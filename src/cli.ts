#!/usr/bin/env bun
import { loadConfig, ensureRadarHome, ConfigError, type RadarConfig } from "./config.ts";
import { openDb, type RadarDb } from "./db/client.ts";
import { desc } from "drizzle-orm";
import { runs } from "./db/schema.ts";
import { collect, defaultAdapters } from "./pipeline/collect.ts";
import { scoreDay } from "./pipeline/scoring.ts";
import { buildCard } from "./pipeline/card.ts";
import { buildHealthReport } from "./pipeline/health.ts";
import { buildCanaryReport } from "./pipeline/canary.ts";
import { opportunityByRef, persistOpportunities } from "./pipeline/opportunity.ts";
import { addFeedback, FeedbackError } from "./pipeline/feedback.ts";
import { buildEdition, DEFAULT_LIMIT, editionByRef, latestEdition } from "./pipeline/edition.ts";
import { opportunityReviews } from "./db/schema.ts";
import { ProfileService, ProfileError, type ProfileRecord } from "./profile/service.ts";
import { buildScheduleUnits, SCHEDULE_NEXT_STEPS, systemdUserDir } from "./schedule.ts";
import { probeRuntime } from "./diagnostics.ts";
import type { AppDeps } from "./app/actions.ts";
import { feedbackAddAction, opportunityReviewAction, collectAction, scoreAction, clusterBuildAction, editionBuildAction, editionShowAction, dailyRunAction, importAction, recordRun, ActionError } from "./app/actions.ts";
import { EventWriter } from "./output/events.ts";
import { renderExplain } from "./output/envelope.ts";
import { renderAgentLine, renderJsonEnvelope, renderSummary, type CommandResult } from "./output/envelope.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marketCommand } from "./market/cli.ts";
import { MarketStoreError } from "./market/repository.ts";
import { MarketValidationError } from "./market/domain.ts";
import { assignmentByRef, createAssignment, produceAssignment, rejectAssignment, submitAssignment } from "./pipeline/assignment.ts";

// Command surface per radar-cli-agent-contract. One CommandResult per
// command; the four renderers (summary/json/agent/events) all derive from it.

interface Args {
  command: string[];
  flags: Map<string, string[]>; // value flags, repeatable
  mode: "summary" | "json" | "agent" | "events" | "explain";
}

function parseArgs(argv: string[]): Args {
  const command: string[] = [];
  const flags = new Map<string, string[]>();
  let mode: Args["mode"] = "summary";
  const MODE_FLAGS = new Set(["--json", "--agent", "--events", "--explain"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (MODE_FLAGS.has(a)) {
      mode = a === "--json" ? "json" : a === "--agent" ? "agent" : a === "--events" ? "events" : "explain";
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, [...(flags.get(key) ?? []), next]);
        i++;
      } else {
        flags.set(key, [...(flags.get(key) ?? []), "true"]);
      }
      continue;
    }
    if (command.length < 3) command.push(a); // group + sub + up to one positional
  }
  return { command, flags, mode };
}


const first = (args: Args, key: string): string | undefined => args.flags.get(key)?.[0];
// A flag present without a value parses as "true"; commands that need real
// values must use require() so a missing value fails closed.
const req = (args: Args, key: string, command: string): string => {
  const v = first(args, key);
  if (v === undefined || v === "" || v === "true") {
    throw new CliError("value_required", `${command} requires --${key} <value>`);
  }
  return v;
};
const many = (args: Args, key: string): string[] => args.flags.get(key) ?? [];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command.length === 0) {
    process.stdout.write(usage());
    process.exit(0);
  }
  // Config/DB failures go through the same output contract (envelope,
  // agent line, or terminal events error) instead of a raw stack trace.
  try {
    const cfg = loadConfig();
    ensureRadarHome();
    const db = openDb(cfg.dbPath);
    const profiles = new ProfileService(db);
    const result = await dispatch(args, cfg, db, profiles);
    emit(result, args);
    process.exit(result.exitCode);
  } catch (err) {
    const result = errorResult(commandId(args.command), err);
    if (args.mode === "events") {
      // Contract: once the stream has started (or the command intended to
      // start one), the LAST line must be the error event — never a bare
      // envelope and never a silent empty stream.
      const writer = EventWriter.active() ?? new EventWriter(commandId(args.command));
      writer.error(result.error?.code ?? "command_failed", result.error?.message ?? String(err));
    } else {
      emit(result, args);
    }
    process.exit(result.exitCode);
  }
}

function emit(result: CommandResult, args: Args): void {
  switch (args.mode) {
    case "json":
      console.log(JSON.stringify(renderJsonEnvelope(result), null, 2));
      break;
    case "agent":
      console.log(renderAgentLine(result));
      break;
    case "events":
      // The NDJSON stream was already written by the command itself; the
      // final end|error event IS the outcome surface.
      break;
    case "explain":
      console.log(renderExplain(result));
      break;
    default:
      console.log(renderSummary(result));
  }
}

async function dispatch(args: Args, cfg: RadarConfig, db: RadarDb, profiles: ProfileService): Promise<CommandResult> {
  const [group, sub] = args.command;
  const positional = args.command[2]; // group sub <positional> — date or ref
  switch (group) {
    case "market": {
      // Long market builds stream staged events; reads render normally.
      const events = args.mode === "events" ? new EventWriter(`market-${new Date().toISOString()}`) : undefined;
      return marketCommand(args.command, args.flags, db, events);
    }
    case "profile":
      return profileCommand(sub, args, profiles);
    case "feedback":
      return feedbackCommand(args, db, profiles, cfg);
    case "opportunity":
      return opportunityCommand(sub, args, db, profiles, cfg);
    case "cluster":
      return clusterCommand(sub, positional, db, cfg);
    case "edition":
      return editionCommand(sub, positional, args, db, profiles, cfg);
    case "import":
      return importCommand(args, cfg, db);
    case "collect":
      return collectCommand(args, cfg, db);
    case "run":
      return runCommand(args, cfg, db);
    case "score":
      return scoreCommand(args.command[1], db, cfg);
    case "card":
      return cardCommand(args.command[1], db);
    case "runs":
      return runsCommand(db);
    case "health":
      return healthCommand(args.command[1], db, cfg);
    case "canary":
      return canaryCommand(sub, positional, args, db, profiles);
    case "schedule":
      return scheduleCommand(sub, args, cfg);
    case "doctor":
      return doctorCommand(cfg);
    case "assignment":
      return assignmentCommand(sub, positional, args, db, profiles);
    default:
      throw new CliError("unknown_command", `unknown command '${args.command.join(" ")}' — run 'radar' for usage`);
  }
}

// --- profile --------------------------------------------------------------

function profileCommand(sub: string, args: Args, profiles: ProfileService): CommandResult {
  switch (sub) {
    case "create": {
      const name = first(args, "name");
      if (!name) throw new CliError("name_required", "profile create requires --name <name>");
      const record = profiles.create(name, profilePatches(args));
      return ok("radar.profile.create", `Profile '${record.name}' created${record.active ? " and activated" : ""}.`, {
        ref: record.ref,
        active: record.active,
        revision: record.headRevision,
        digest: record.digest,
      }, {
        actions: [{ name: "show", command: `radar profile show --profile ${record.ref}` }],
      });
    }
    case "show": {
      const record = profiles.show(first(args, "profile"));
      return ok("radar.profile.show", `Profile '${record.name}' (${record.ref}), revision ${record.headRevision}, ${record.active ? "active" : "inactive"}.`, {
        ref: record.ref,
        active: record.active,
        revision: record.headRevision,
        digest: record.digest,
        blocked_topics: record.profile.blocked_topics.length,
        minimum_fit: record.profile.minimum_fit,
        minimum_confidence: record.profile.minimum_confidence,
      }, { data: record.profile });
    }
    case "set": {
      // Supply the current range so a one-sided --episode-min/--episode-max
      // keeps the other bound instead of resetting it to the default.
      let currentRange: { min: number; max: number } | undefined;
      try {
        currentRange = profiles.show(first(args, "profile")).profile.episode_length_seconds;
      } catch {
        currentRange = undefined; // profile set requires an existing profile; show() failure surfaces in set()
      }
      const patches = profilePatches(args, currentRange);
      if (Object.keys(patches).length === 0) throw new CliError("fields_required", "profile set needs at least one field flag (e.g. --genre revenge:80)");
      const record = profiles.set(first(args, "profile"), patches);
      return ok("radar.profile.set", `Profile '${record.ref}' updated to revision ${record.headRevision} (immutable history preserved).`, {
        ref: record.ref,
        revision: record.headRevision,
        digest: record.digest,
      });
    }
    case "activate": {
      const ref = args.command[2];
      if (!ref) throw new CliError("profile_ref_required", "profile activate requires a profile ref");
      const record = profiles.activate(ref);
      return ok("radar.profile.activate", `Profile '${record.ref}' is now the single active profile.`, { ref: record.ref, revision: record.headRevision });
    }
    default:
      throw new CliError("unknown_command", `unknown profile subcommand '${sub}'`);
  }
}

// Map repeatable CLI flags onto profile patches.
function profilePatches(args: Args, currentRange?: { min: number; max: number }): Partial<import("./profile/domain.ts").PersonalProfileV1> {
  const patches: Partial<import("./profile/domain.ts").PersonalProfileV1> = {};
  const weighted: [keyof import("./profile/domain.ts").PersonalProfileV1, string][] = [
    ["genres", "genre"],
    ["topics", "topic"],
    ["audiences", "audience"],
    ["platforms", "platform"],
    ["formats", "format"],
    ["hooks", "hook"],
    ["emotions", "emotion"],
    ["languages", "language"],
  ];
  for (const [field, flag] of weighted) {
    const values = many(args, flag);
    if (values.length > 0) {
      (patches as Record<string, unknown>)[field] = values.map((v) => {
        const [tag, weight] = v.split(":");
        return { tag: tag ?? "", weight: weight === undefined ? 50 : Number(weight) };
      });
    }
  }
  if (many(args, "blocked-topic").length > 0) patches.blocked_topics = many(args, "blocked-topic");
  if (many(args, "asset-tag").length > 0) patches.available_asset_tags = many(args, "asset-tag");
  const budget = first(args, "budget-band");
  if (budget) patches.budget_band = budget as import("./profile/domain.ts").BudgetBand;
  const risk = first(args, "risk-tolerance");
  if (risk !== undefined) patches.risk_tolerance = Number(risk);
  const minFit = first(args, "minimum-fit");
  if (minFit !== undefined) patches.minimum_fit = Number(minFit);
  const minConf = first(args, "minimum-confidence");
  if (minConf !== undefined) patches.minimum_confidence = Number(minConf);
  const minLen = first(args, "episode-min");
  const maxLen = first(args, "episode-max");
  if (minLen !== undefined || maxLen !== undefined) {
    // Unspecified bounds inherit the CURRENT profile's value when the caller
    // supplies it (profile set); profile create falls back to the defaults.
    // The old code reset the missing bound to a hardcoded 60/180, silently
    // discarding the user's existing range.
    const base = currentRange ?? { min: 60, max: 180 };
    patches.episode_length_seconds = { min: Number(minLen ?? base.min), max: Number(maxLen ?? base.max) };
  }
  return patches;
}

// --- pipeline ---------------------------------------------------------------

async function importCommand(args: Args, cfg: RadarConfig, db: RadarDb): Promise<CommandResult> {
  const deps: AppDeps = { cfg, db, profiles: new ProfileService(db) };
  const csvPath = first(args, "csv");
  if (!csvPath) throw new CliError("csv_required", "import requires --csv <path> (columns: platform,title,url[,publishedAt,author,likes,comments,collects,shares,contentId])");
  return importAction(deps, csvPath, first(args, "date"));
}

async function collectCommand(args: Args, cfg: RadarConfig, db: RadarDb): Promise<CommandResult> {
  const deps: AppDeps = { cfg, db, profiles: new ProfileService(db) };
  const events = args.mode === "events" ? new EventWriter(`collect-${new Date().toISOString()}`) : undefined;
  return collectAction(deps, events);
}
async function runCommand(args: Args, cfg: RadarConfig, db: RadarDb): Promise<CommandResult> {
  const deps: AppDeps = { cfg, db, profiles: new ProfileService(db) };
  const events = args.mode === "events" ? new EventWriter(`run-${new Date().toISOString()}`) : undefined;
  return dailyRunAction(deps, events);
}
// --- feedback / opportunity / cluster / edition (M2) ------------------------

function feedbackCommand(args: Args, db: RadarDb, profiles: ProfileService, cfg: RadarConfig): CommandResult {
  if (args.command[1] !== "add") throw new CliError("unknown_command", "usage: radar feedback add --opportunity <ref> --kind <kind> [--project-ref <ref>]");
  return feedbackAddAction({ cfg, db, profiles }, {
    opportunityRef: req(args, "opportunity", "feedback add"),
    kind: req(args, "kind", "feedback add"),
    profileRef: first(args, "profile"),
    projectRef: first(args, "project-ref"),
    idempotencyKey: first(args, "idempotency-key"),
  });
}
function opportunityCommand(sub: string, args: Args, db: RadarDb, profiles: ProfileService, cfg: RadarConfig): CommandResult {
  if (sub !== "review") throw new CliError("unknown_command", "usage: radar opportunity review --opportunity <ref> --decision <accept|reject|needs_evidence>");
  return opportunityReviewAction({ cfg, db, profiles }, {
    opportunityRef: req(args, "opportunity", "opportunity review"),
    decision: req(args, "decision", "opportunity review"),
    profileRef: first(args, "profile"),
    note: first(args, "note"),
    projectRef: first(args, "project-ref"),
  });
}
function clusterCommand(sub: string, date: string | undefined, db: RadarDb, cfg: RadarConfig): CommandResult {
  if (sub !== "build") throw new CliError("unknown_command", "usage: radar cluster build [date]");
  return clusterBuildAction({ cfg, db, profiles: new ProfileService(db) }, date);
}
function assignmentCommand(sub: string, positional: string | undefined, args: Args, db: RadarDb, profiles: ProfileService): CommandResult {
  const profile = profiles.show(first(args, "profile"));
  if (sub === "create") {
    const result = createAssignment(db, {
      profile,
      editionRef: first(args, "edition") ?? positional,
      opportunityRef: first(args, "opportunity"),
      briefRef: first(args, "brief"),
      idempotencyKey: first(args, "key"),
    });
    return {
      command: "radar.assignment.create",
      status: "success",
      summary: result.reused
        ? `Assignment ${result.assignment.assignment_ref} reused.`
        : `Assignment ${result.assignment.assignment_ref} (${result.assignment.status}) ready for Auctra ingress.`,
      facts: {
        assignment_ref: result.assignment.assignment_ref,
        status: result.assignment.status,
        reused: result.reused,
        downstream_status: result.assignment.downstream_status,
      },
      data: result.assignment,
      actions: result.assignment.status === "do_not_shoot"
        ? [{ name: "edition", command: "radar edition show latest" }]
        : [{ name: "show", command: `radar assignment show ${result.assignment.assignment_ref}` }],
      exitCode: 0,
    };
  }
  if (sub === "show") {
    const assignment = assignmentByRef(db, first(args, "assignment") ?? positional ?? "latest", profile.ref);
    return {
      command: "radar.assignment.show",
      status: "success",
      summary: `Assignment ${assignment.assignment_ref} (${assignment.status}).`,
      facts: { assignment_ref: assignment.assignment_ref, status: assignment.status, downstream_status: assignment.downstream_status },
      data: assignment,
      exitCode: 0,
    };
  }
  if (sub === "submit") {
    const result = submitAssignment(db, {
      profile,
      assignmentRef: first(args, "assignment") ?? positional ?? "latest",
      auctraPath: req(args, "auctra-path", "radar assignment submit"),
      auctraBin: first(args, "auctra-bin"),
    });
    return {
      command: "radar.assignment.submit",
      status: "success",
      summary: result.reused
        ? `Assignment ${result.assignment.assignment_ref} already submitted.`
        : `Assignment ${result.assignment.assignment_ref} submitted as Auctra ${result.assignment.auctra?.proposal_ref ?? "proposal"}.`,
      facts: {
        assignment_ref: result.assignment.assignment_ref,
        downstream_status: result.assignment.downstream_status,
        reused: result.reused,
        proposal_ref: result.assignment.auctra?.proposal_ref ?? null,
      },
      data: result.assignment,
      exitCode: 0,
    };
  }
  if (sub === "produce") {
    const result = produceAssignment(db, {
      profile,
      assignmentRef: first(args, "assignment") ?? positional ?? "latest",
      scaenaPath: req(args, "scaena-path", "radar assignment produce"),
      auctraBin: first(args, "auctra-bin"),
      scaenaBin: first(args, "scaena-bin"),
    });
    return {
      command: "radar.assignment.produce",
      status: "success",
      summary: result.reused
        ? `Assignment ${result.assignment.assignment_ref} already produced a Scaena skeleton.`
        : `Assignment ${result.assignment.assignment_ref} produced Scaena ${result.assignment.scaena?.receipt_ref ?? "receipt"}.`,
      facts: {
        assignment_ref: result.assignment.assignment_ref,
        downstream_status: result.assignment.downstream_status,
        reused: result.reused,
        receipt_ref: result.assignment.scaena?.receipt_ref ?? null,
      },
      data: result.assignment,
      exitCode: 0,
    };
  }
  if (sub === "reject") {
    const result = rejectAssignment(db, {
      profile,
      assignmentRef: first(args, "assignment") ?? positional ?? "",
      kind: req(args, "kind", "radar assignment reject"),
      idempotencyKey: first(args, "key"),
    });
    return {
      command: "radar.assignment.reject",
      status: "success",
      summary: `Assignment ${result.assignment.assignment_ref} rejected.`,
      facts: { assignment_ref: result.assignment.assignment_ref, status: result.assignment.status },
      data: result.assignment,
      exitCode: 0,
    };
  }
  throw new CliError("unknown_command", "usage: radar assignment create|show|submit|produce|reject");
}

function editionCommand(sub: string, positional: string | undefined, args: Args, db: RadarDb, profiles: ProfileService, cfg: RadarConfig): CommandResult {
  if (sub === "build") {
    return editionBuildAction({ cfg, db, profiles }, {
      date: positional,
      profileRef: first(args, "profile"),
      limit: numericFlag(args, "limit", 1, 50),
      minimumFit: numericFlag(args, "minimum-fit", 0, 100),
    });
  }
  if (sub === "show") {
    return editionShowAction({ cfg, db, profiles }, { ref: positional, profileRef: first(args, "profile") });
  }
  throw new CliError("unknown_command", "usage: radar edition build|show");
}
async function scoreCommand(date: string | undefined, db: RadarDb, cfg: RadarConfig): Promise<CommandResult> {
  return scoreAction({ cfg, db, profiles: new ProfileService(db) }, date);
}
function cardCommand(date: string | undefined, db: RadarDb): CommandResult {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const card = buildCard(db, day);
  const id = `card-${new Date().toISOString()}`;
  recordRun(db, id, "card", card.sourceStatus.degraded ? "degraded" : "ok", { items: card.top.douyin.length + card.top.xiaohongshu.length });
  return {
    command: "radar.card",
    status: card.sourceStatus.degraded ? "partial" : "success",
    summary: `Card ${card.contract} for ${day}: ${card.top.douyin.length} douyin + ${card.top.xiaohongshu.length} xiaohongshu.`,
    facts: { date: day, contract: card.contract, degraded: card.sourceStatus.degraded },
    evidence: [`run_id=${id}`],
    data: card as unknown as Record<string, unknown>,
    exitCode: 0,
  };
}

function runsCommand(db: RadarDb): CommandResult {
  // Deterministic recency order, matching the radar://runs resource.
  const rows = db.select().from(runs).orderBy(desc(runs.finishedAt)).limit(20).all();
  return ok("radar.runs", `${rows.length} recent run receipts.`, { runs: rows.length }, { data: rows });
}

function healthCommand(windowArg: string | undefined, db: RadarDb, cfg: RadarConfig): CommandResult {
  const windowDays = windowArg ? Number(windowArg) : 14;
  const requestedDays = Number.isFinite(windowDays) ? windowDays : 14;
  const report = buildHealthReport(db, requestedDays, new Date(), cfg.accountsPath);
  const status = report.daysWithAttempt < requestedDays || report.degradedDays > 0 ? "partial" : "success";
  return {
    command: "radar.health",
    status,
    summary: `Collection health ${report.from}..${report.to}: ${report.daysWithAttempt} attempt day(s), ${report.daysWithCollection} with data, ${report.degradedDays} degraded.`,
    facts: {
      days_with_attempt: report.daysWithAttempt,
      days_with_collection: report.daysWithCollection,
      degraded_days: report.degradedDays,
      both_platform_days: report.coverageDays.both,
      avg_items_per_day: report.avgItemsPerDay,
      avg_duplicate_rate: report.avgDuplicateRate,
      stable_id_violations: report.stableIdViolationTotal,
      accounts_active: report.accountSurvival.active,
      accounts_cooldown: report.accountSurvival.cooldown,
      accounts_disabled: report.accountSurvival.disabled,
    },
    data: report as unknown as Record<string, unknown>,
    exitCode: 0,
  };
}

function canaryCommand(sub: string | undefined, daysArg: string | undefined, args: Args, db: RadarDb, profiles: ProfileService): CommandResult {
  if (sub !== "report") throw new CliError("unknown_command", "usage: radar canary report [window-days] [--profile <ref>]");
  const requested = daysArg === undefined ? 14 : Number(daysArg);
  if (!Number.isFinite(requested) || requested < 1) throw new CliError("window_invalid", "canary report window-days must be a positive number");
  const profile = profiles.show(first(args, "profile"));
  const report = buildCanaryReport(db, profile.ref, requested);
  const readyForManualReview = report.quantitativePassed && report.windowDays >= 14;
  return {
    command: "radar.canary.report",
    status: "partial",
    summary: readyForManualReview
      ? `Canary quantitative gates passed for ${profile.ref}; Hermes, secret-leak and replay reviews remain manual.`
      : `Canary collecting for ${profile.ref}: ${report.editionDays}/10 reviewable edition days, usefulness ${report.usefulnessRate}, false/unexplained ${report.falseOrUnexplainedRate}.`,
    facts: {
      profile_ref: profile.ref,
      window_days: report.windowDays,
      edition_days: report.editionDays,
      non_empty_days: report.nonEmptyEditionDays,
      usefulness_rate: report.usefulnessRate,
      false_or_unexplained_rate: report.falseOrUnexplainedRate,
      quantitative_passed: report.quantitativePassed,
      manual_reviews_remaining: 3,
    },
    actions: [{ name: "manual-review", command: "radar audit tail --json" }],
    data: report,
    exitCode: 0,
  };
}

function scheduleCommand(sub: string, args: Args, cfg: RadarConfig): CommandResult {
  if (sub !== "install") throw new CliError("unknown_command", "usage: radar schedule install [--print]");
  const execStart = `${process.execPath} ${join(import.meta.dir, "cli.ts")}`;
  const units = buildScheduleUnits(cfg, execStart);
  const target = systemdUserDir(process.env.HOME ?? "~");
  if (first(args, "print") !== undefined) {
    return ok("radar.schedule.install", `Printed ${Object.keys(units).length} systemd user units (dry run).`, { units: Object.keys(units).length, target }, {
      data: units,
      actions: SCHEDULE_NEXT_STEPS.slice(0, 1).map((c) => ({ name: "reload", command: c })),
    });
  }
  mkdirSync(target, { recursive: true });
  mkdirSync(join(process.env.HOME ?? "~", ".agent-reach", "xiaohongshu"), { recursive: true });
  for (const [name, content] of Object.entries(units)) {
    writeFileSync(join(target, name), content);
  }
  return ok("radar.schedule.install", `Wrote ${Object.keys(units).length} units to ${target}.`, { units: Object.keys(units).length, target }, {
    actions: SCHEDULE_NEXT_STEPS.map((c) => ({ name: "step", command: c })),
  });
}

async function doctorCommand(cfg: RadarConfig): Promise<CommandResult> {
  const runtime = await probeRuntime(cfg);
  const problems = Object.entries(runtime.checks).filter(([, v]) => String(v.status) !== "ok");
  return {
    command: "radar.doctor",
    status: problems.length > 0 ? "partial" : "success",
    summary: problems.length === 0 ? "All radar layers ready." : `${problems.length} layer(s) need attention.`,
    facts: Object.fromEntries(Object.entries(runtime.checks).map(([k, v]) => [k, v.status])),
    actions: problems.length > 0 ? [{ name: "next", command: problems[0]![1].nextCommand ?? "radar doctor" }] : undefined,
    data: runtime.checks as unknown as Record<string, unknown>,
    exitCode: 0,
  };
}

// --- helpers ----------------------------------------------------------------

function ok(command: string, summary: string, facts: Record<string, unknown>, opts: { actions?: { name: string; command: string }[]; data?: unknown; evidence?: string[] } = {}): CommandResult {
  return {
    command,
    status: "success",
    summary,
    facts,
    ...(opts.actions ? { actions: opts.actions } : {}),
    ...(opts.evidence ? { evidence: opts.evidence } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
    exitCode: 0,
  };
}

function fail(command: string, code: string, message: string, opts: { actions?: { name: string; command: string }[] } = {}): CommandResult {
  return { command, status: "failed", summary: message, error: { code, message }, ...(opts.actions ? { actions: opts.actions } : {}), exitCode: 1 };
}

class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function errorResult(command: string, err: unknown): CommandResult {
  if (err instanceof MarketStoreError || err instanceof MarketValidationError) {
    return fail(command, err.code, err.message);
  }
  if (err instanceof ProfileError || err instanceof FeedbackError) {
    return fail(command, err.code, err.message);
  }
  if (err instanceof ConfigError) {
    return fail(command, "config_invalid", err.message);
  }
  if (err instanceof CliError) {
    return fail(command, err.code, err.message);
  }
  return fail(command, "internal_error", (err as Error).message ?? String(err));
}

function commandId(command: string[]): string {
  return `radar.${command.filter((c) => c !== undefined).join(".") || "help"}`;
}


// Numeric flag validation: `--limit abc` used to silently become NaN and
// produce an empty edition; invalid values are contract errors now.
function numericFlag(args: Args, name: string, min: number, max: number): number | undefined {
  const raw = first(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CliError(`${name}_invalid`, `--${name} must be an integer between ${min} and ${max}, got '${raw}'`);
  }
  return value;
}

function usage(): string {
  return `short-drama-radar — crawler-first daily short-drama intelligence with personal edition

Usage: radar <command> [args] [--json | --agent | --events | --explain]

Collection & scoring:
  collect                          Fetch all layers (0 firecrawl / 1 backends / 2 browser)
  import --csv <path> [--date d]   Layer 3 manual CSV import (platform,title,url required)
  score [date]                     Compute v0 scores for a day
  card [date]                      Build Top5+Top5 card (contract short-drama-radar.card.v1)
  run                              collect -> score -> cluster -> card + edition
  runs                             List recent run receipts
  health [window-days]             Collection health report (default 14 days)
  canary report [window-days]      Personal Edition usefulness gates (default 14 days)
  schedule install [--print]       Write (or print) systemd user timer units

Profiles:
  profile create --name <n> [--genre t:80 ...] [--blocked-topic t ...]
  profile show [--profile <ref>]
  profile set [--profile <ref>] --risk-tolerance 60 ...
  profile activate <profile-ref>

Market foundation (local only):
  market init
  market import-legacy --run <legacy-run-ref>
  market import-catalog --source <ref> --file <path> --format html --observed-at <UTC-instant>
  market source list
  market source qualify --source <ref>  Inspect evidence; never promote from a day count alone
  market source gaps                   Show source and market coverage gaps
  market source show --source <ref> [--revision <n>]
  market source set --source <ref> --revision <n> --sampling-scope <text>
  market config show
  market config set --revision <n> --timezone <IANA-zone>
  market config set --revision <n> --blocked-topic <ref>
  market config set --revision <n> --clear-blocked-topics
  market analyze --start <UTC-instant> --end <UTC-instant>
  market analyze (without windows: previous complete local day)
  market schedule show                 Market pipeline schedule description (planned vs schedulable)
  market schedule install [--print]    Write (or print) market-only systemd user units; never enables timers
  market observe --source hongguo --mode verify-sample|production [--confirm-live|--fixture] [--observed-at UTC]
  market canary report --days 14       Planned: 14-day market canary (radar canary report keeps its old meaning)
  market signal show --signal <ref> [--revision <n>]
  market signal correct --signal <ref> --revision <n> --reason <text> --evidence <ref> --outcome <retracted|inconclusive> --at <UTC-instant>
  market signal restore --signal <ref> --revision <n> --observation <ref> --reason <text> --at <UTC-instant>
  market source plan --source <ref> --revision <n> --slot <HH:mm> --slot <HH:mm>
  market source show-plan --source <ref> --revision <n>
  market source record-qualification --source <ref> --revision <n>
  market source qualification --record <ref>
  market source review --source <ref> --revision <n> --stage <identity|sample|blocked> --reason <text> --key <key> [--evidence <ref>] [--batch <ref>]
  market source review-receipt --key <key>
  market source check-sample --batch <ref> --scheduled-at <UTC> --checked-at <UTC> --completeness <complete|partial> --stable-ids <true|false> --metric-contract-valid <true|false> --failure-sample <ref>
  market brief build --start <UTC-instant> --end <UTC-instant>
  market brief show [--brief <ref>]
  market review build --start <UTC-instant> --end <UTC-instant> --as-of <UTC-instant>
  market review show --review <ref>
  market brief build / market review build (without windows: previous complete local day/week)
  market compare --left <signal> --left-revision <n> --right <signal> --right-revision <n>
  market reader show
  market reader catchup [--limit <n>] [--cursor <cursor>]
  market reader mark --signal <ref> --signal-revision <n> --revision <n> --policy-revision <digest> --key <key>
  market reader unread --signal <ref> --signal-revision <n> --revision <n> --policy-revision <digest> --key <key>
  market reader receipt --key <key>
  market watch list
  market watch add --kind <topic|work|platform|market> --target <ref> --revision <n> --policy-revision <digest> --key <key>
  market watch pause|resume|remove --watch <ref> --revision <n> --policy-revision <digest> --key <key>
  market watch changes --watch <ref> [--since <UTC-instant>] [--until <UTC-instant>]  Pause-period changes with source gaps
  market watch receipt --key <key>
  market question context --signal <ref> --revision <n> --question <text>
  market evidence show --signal <ref> --revision <n> --evidence <ref>
  assignment create [--edition <ref>] [--opportunity <ref>] [--brief <ref>] [--key <key>]
  assignment show [<ref>|latest]
  assignment submit --assignment <ref> --auctra-path <project> [--auctra-bin <bin>]
  assignment produce --assignment <ref> --scaena-path <project> [--auctra-bin <bin>] [--scaena-bin <bin>]
  assignment reject --assignment <ref> --kind too_risky|not_relevant [--key <key>]

Diagnostics:
  doctor                           Probe firecrawl / agent-reach / cookie env / playwright / schedule

Output:
  default   English human summary, one next command
  --json    standard envelope (spec_version 1.0)
  --agent   single key=value line
  --events  NDJSON progress stream (collect, run)

Env:
  RADAR_HOME / RADAR_DB_PATH / RADAR_CONFIG_PATH / RADAR_ACCOUNTS_PATH
  FIRECRAWL_BASE_URL / AGENT_REACH_BIN / DOUYIN_COOKIE (user secret only)
  RADAR_FIXTURE_DIR   Feed fixtures instead of live layers (tests)
`;
}

await main();
