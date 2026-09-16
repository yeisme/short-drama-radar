import { exportDecisionPackage, type SampleInput } from "./materials.ts";
import type { RadarDb } from "../db/client.ts";
import type { CommandResult } from "../output/envelope.ts";
import type { EventWriter } from "../output/events.ts";
import { MarketStoreError } from "../market/repository.ts";
import { invalid, type DecisionEvidence, type DecisionBaseline, type ExperimentPlan, type ResultInput } from "./domain.ts";
import {
  addDecisionSample, cancelDecisionExperiment, decisionWorkPackage, prepareDecision, readDecisionCancellation,
  addDecisionCandidate, addDecisionEvidence, createDecision, listDecisions, lockDecisionExperiment,
  readDecision, readDecisionExperiment, readDecisionResult, recordDecisionResult,
  resumeDecision, reviewDecision, setDecisionBaseline,
} from "./service.ts";

export const DECISION_HELP = `Decision pilot: local records, no collection, production or audience certification.

radar decision create --title <text> --objective <text> --topic <ref> --key <key>
radar decision list [--limit 1-100]
radar decision show --pack <ref> [--revision <n>]
radar decision evidence add --pack <ref> --revision <n> --key <key>
  --evidence <ref> --kind supply|demand|counterevidence|background
  --note <text> --observed-at <UTC> --url <public-https-url>
  Alternative to --url: --signal <ref> --signal-revision <n> --market-evidence <ref>
radar decision baseline set --pack <ref> --revision <n> --key <key>
  --status missing|independent --note <text> [--evidence <ref>]
  Independent baseline: record evidence before candidates; operator attestation only.
radar decision candidate add --pack <ref> --revision <n> --key <key>
  --candidate <ref> --name <text> --market <country-code> --locale <language-tag>
  --audience <text> --hypothesis <text> --rationale <text> --risk <text>
  --falsifier <text> --cost-note <text> --evidence <ref> [--evidence <ref>]
radar decision experiment lock --pack <ref> --revision <n> --key <key>
  --candidate <ref> --control <ref> --kind hypothesis|method
  --budget-note <text> --recruitment-note <text> --protocol-note <text>
  [--sample-per-arm 32] [--min-lift-pp 15] [--max-completion-drop-pp 10]
  [--max-failure-percent 10]
  Optional material binding (all required together): --sample <ref> (four times)
  --allocation randomized|manual_balanced --recruitment-channel <ref> --quality-standard <text>
radar decision sample add --pack <ref> --revision <n> --key <key>
  --sample <ref> --candidate <ref> --artifact <ref> --version <ref> --owner auctra|scaena|manual
  --episode 1|2 --duration-seconds <15-600> --locale <language-tag> --format animation|manga_drama
  --file <local-regular-file>
radar decision prepare --pack <ref>
radar decision experiment cancel --experiment <ref> --key <key> --reason <text>
radar decision workpack show --experiment <ref>
radar decision workpack export --experiment <ref> --output <new-local-file>
radar decision experiment show --experiment <ref>
radar decision result record --experiment <ref> --revision <n> --key <key>
  --origin manual|fixture --measurement observed|intent --quality comparable|not_comparable
  --source-ref <opaque-ref> --started-at <UTC> --finished-at <UTC>
  --treatment-assigned <n> --treatment-continued <n> --treatment-completed <n> --treatment-failures <n>
  --control-assigned <n> --control-continued <n> --control-completed <n> --control-failures <n>
  [--reason <correction-reason>] [--materials-digest <sha256-digest>]
  Material-bound experiments require their frozen materials digest on every result.
  First result uses --revision 0; corrections append a revision and require --reason.
radar decision result show --experiment <ref> [--revision <n>]
radar decision report --pack <ref>
radar decision resume --pack <ref> --revision <n> --key <key> --reason <text>

Modes: default summary, --json, --agent, --explain, --events.
The locked metric counts an explicit continuation watched for 15 seconds;
completion requires 90% actually watched. Fixture and intent results are inconclusive.
Public URLs are references only, not fetched or verified. All writes are local.
`;

export const DECISION_COMMANDS = new Set(["create", "list", "show", "evidence.add", "baseline.set", "candidate.add",
  "sample.add", "prepare", "experiment.cancel", "workpack.show", "workpack.export", "experiment.lock", "experiment.show", "result.record", "result.show", "report", "resume", "help"]);

export function decisionCommandId(command: string[]): string {
  const suffix = command.slice(1).join(".");
  return DECISION_COMMANDS.has(suffix) ? "radar.decision." + suffix : "radar.decision";
}

export function decisionCommand(command: string[], flags: Map<string, string[]>, db: RadarDb, events?: EventWriter): CommandResult {
  const id = decisionCommandId(command), action = command.slice(1).join(".");
  events?.start(id);
  try {
    const value = (name: string): string => {
      const entries = flags.get(name);
      if (!entries || entries.length !== 1 || !entries[0] || entries[0] === "true") invalid("value_required", `Provide one value for --${name}.`);
      return entries[0]!;
    };
    const number = (name: string, fallback?: number): number => {
      if (!flags.has(name) && fallback !== undefined) return fallback;
      const raw = value(name);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) invalid("decision_input_invalid", `${name} requires an integer.`);
      return Number(raw);
    };
    const check = (allowed: string[]) => {
      if ([...flags.keys()].some(k => !allowed.includes(k))) invalid("flag_invalid", "Unsupported decision command flag; use radar decision help.");
    };
    const many = (name: string) => {
      const entries = flags.get(name);
      if (!entries?.length || entries.some(v => !v || v === "true")) invalid("value_required", `Provide values for --${name}.`);
      return entries;
    };
    const metaFlags = ["pack", "revision", "key"];
    const meta = () => ({ pack_ref: value("pack"), revision: number("revision"), key: value("key") });
    let data: unknown;
    let packRef: string | undefined;
    if (action === "help" || (flags.size === 1 && flags.get("help")?.join() === "true")) {
      check(["help"]);
      if (flags.has("help") && flags.get("help")?.join() !== "true") invalid("flag_invalid", "Use --help without a value.");
      data = { help: DECISION_HELP };
    } else if (action === "create") {
      check(["title", "objective", "topic", "key"]);
      const result = createDecision(db, { title: value("title"), objective: value("objective"), topics: many("topic"), key: value("key") });
      packRef = result.pack.ref;
      data = result;
    } else if (action === "list") {
      check(["limit"]);
      data = listDecisions(db, number("limit", 50));
    } else if (action === "show") {
      check(["pack", "revision"]);
      data = readDecision(db, value("pack"), flags.has("revision") ? number("revision") : undefined);
    } else if (action === "evidence.add") {
      check([...metaFlags, "evidence", "kind", "note", "observed-at", "url", "signal", "signal-revision", "market-evidence"]);
      data = addDecisionEvidence(db, meta(), { ref: value("evidence"), kind: value("kind") as DecisionEvidence["kind"],
        note: value("note"), observed_at: value("observed-at"),
        ...(flags.has("url") ? { url: value("url") } : {}),
        ...(flags.has("signal") ? { signal_ref: value("signal") } : {}),
        ...(flags.has("signal-revision") ? { signal_revision: number("signal-revision") } : {}),
        ...(flags.has("market-evidence") ? { market_evidence_ref: value("market-evidence") } : {}) });
    } else if (action === "baseline.set") {
      check([...metaFlags, "status", "note", "evidence"]);
      data = setDecisionBaseline(db, meta(), { status: value("status") as DecisionBaseline["status"], note: value("note"),
        evidence_ref: flags.has("evidence") ? value("evidence") : null });
    } else if (action === "candidate.add") {
      check([...metaFlags, "candidate", "name", "market", "locale", "audience", "hypothesis", "rationale", "risk", "falsifier", "cost-note", "evidence"]);
      data = addDecisionCandidate(db, meta(), { ref: value("candidate"), name: value("name"), market: value("market"), locale: value("locale"),
        audience: value("audience"), hypothesis: value("hypothesis"), rationale: value("rationale"), risk: value("risk"),
        falsifier: value("falsifier"), cost_note: value("cost-note"), evidence_refs: many("evidence") });
    } else if (action === "sample.add") {
      check([...metaFlags, "sample", "candidate", "artifact", "version", "owner", "episode", "duration-seconds", "locale", "format", "file"]);
      data = addDecisionSample(db, meta(), { ref: value("sample"), candidate_ref: value("candidate"), artifact_ref: value("artifact"),
        version: value("version"), owner: value("owner") as SampleInput["owner"], episode: number("episode"),
        duration_seconds: number("duration-seconds"), locale: value("locale"), format: value("format") as SampleInput["format"] }, value("file"));
    } else if (action === "prepare") {
      check(["pack"]);
      data = prepareDecision(db, value("pack"));
    } else if (action === "experiment.cancel") {
      check(["experiment", "key", "reason"]);
      data = cancelDecisionExperiment(db, { experiment_ref: value("experiment"), key: value("key"), reason: value("reason") });
    } else if (action === "workpack.show" || action === "workpack.export") {
      check(action === "workpack.show" ? ["experiment"] : ["experiment", "output"]);
      const output = action === "workpack.export" ? value("output") : undefined;
      const workpack = decisionWorkPackage(db, value("experiment"));
      data = output === undefined ? workpack : exportDecisionPackage(output, workpack);
    } else if (action === "experiment.lock") {
      check([...metaFlags, "candidate", "control", "kind", "budget-note", "recruitment-note", "protocol-note", "sample-per-arm",
        "min-lift-pp", "max-completion-drop-pp", "max-failure-percent", "sample", "allocation", "recruitment-channel", "quality-standard"]);
      data = lockDecisionExperiment(db, meta(), { candidate_ref: value("candidate"), control_ref: value("control"), plan: {
        kind: value("kind") as ExperimentPlan["kind"], sample_per_arm: number("sample-per-arm", 32), min_lift_pp: number("min-lift-pp", 15),
        max_completion_drop_pp: number("max-completion-drop-pp", 10), max_failure_percent: number("max-failure-percent", 10),
        budget_note: value("budget-note"), recruitment_note: value("recruitment-note"), protocol_note: value("protocol-note"),
      }, ...(["sample", "allocation", "recruitment-channel", "quality-standard"].some(f => flags.has(f)) ? { materials: {
        sample_refs: many("sample"), allocation: value("allocation") as "randomized" | "manual_balanced",
        recruitment_channel: value("recruitment-channel"), quality_standard: value("quality-standard"),
      } } : {}) });
    } else if (action === "experiment.show") {
      check(["experiment"]);
      data = readDecisionExperiment(db, value("experiment"));
    } else if (action === "result.record") {
      const armFlags = ["treatment", "control"].flatMap(a => ["assigned", "continued", "completed", "failures"].map(f => `${a}-${f}`));
      check(["experiment", "revision", "key", "origin", "measurement", "quality", "source-ref", "started-at", "finished-at", "reason", "materials-digest", ...armFlags]);
      const arm = (name: string) => ({ assigned: number(`${name}-assigned`), continued: number(`${name}-continued`),
        completed: number(`${name}-completed`), technical_failures: number(`${name}-failures`) });
      data = recordDecisionResult(db, { experiment_ref: value("experiment"), revision: number("revision"), key: value("key") }, {
        ...(flags.has("materials-digest") ? { materials_digest: value("materials-digest") } : {}),
        origin: value("origin") as ResultInput["origin"], measurement: value("measurement") as ResultInput["measurement"],
        quality: value("quality") as ResultInput["quality"], source_ref: value("source-ref"),
        started_at: value("started-at"), finished_at: value("finished-at"), treatment: arm("treatment"), control: arm("control"),
        reason: flags.has("reason") ? value("reason") : null,
      });
    } else if (action === "result.show") {
      check(["experiment", "revision"]);
      data = { result: readDecisionResult(db, value("experiment"), flags.has("revision") ? number("revision") : undefined) };
    } else if (action === "report") {
      check(["pack"]);
      data = reviewDecision(db, value("pack"));
    } else if (action === "resume") {
      check([...metaFlags, "reason"]);
      data = resumeDecision(db, meta(), value("reason"));
    } else {
      invalid("command_unknown", "Unsupported decision command; use radar decision help.");
    }
    if (!packRef && flags.has("pack")) packRef = value("pack");
    const result: CommandResult = { command: id, status: "success",
      summary: (data && typeof data === "object" && "help" in data) ? DECISION_HELP : "Decision " + action.replaceAll(".", " ") + " completed.",
      data, facts: { external_actions: false, ...(packRef ? { pack_ref: packRef } : {}) },
      actions: [{ name: "inspect", command: packRef ? `radar decision report --pack ${packRef}` : "radar decision list" }], exitCode: 0 };
    if (data && typeof data === "object") {
      if ("pack" in data) {
        const pack = (data as { pack: { revision: number; digest: string } }).pack;
        result.facts!.revision = pack.revision;
        result.evidence = [pack.digest];
      }
      if ("reused" in data) result.facts!.reused = (data as { reused: boolean }).reused;
      if (action === "report") {
        const review = data as ReturnType<typeof reviewDecision>;
        result.facts!.pause_required = review.pause_required;
        result.facts!.rounds = review.rounds.length;
        result.facts!.baseline_status = review.baseline_status;
        const latest = review.rounds.at(-1);
        if (latest) {
          result.facts!.latest_lifecycle = latest.lifecycle;
          result.facts!.latest_verdict = latest.verdict;
          result.facts!.latest_kind = latest.kind;
          result.facts!.reasons = latest.reasons.join(",");
          if (latest.lift_pp !== null) result.facts!.lift_pp = latest.lift_pp;
          result.evidence = [latest.experiment_ref, `result-revision:${latest.result_revision ?? "missing"}`];
        }
        result.summary = result.facts!.pause_required ? "Pause and review before locking another experiment." : "Decision review completed; outcomes remain operator-reported.";
      }
      if (action === "show") {
        const pack = data as ReturnType<typeof readDecision>;
        result.summary = pack.title;
        Object.assign(result.facts!, { revision: pack.revision, baseline_status: pack.baseline?.status ?? "unrecorded",
          candidates: pack.candidates.length, candidate_refs: pack.candidates.map(c => c.ref).join(","), evidence_count: pack.evidence.length });
        result.evidence = [pack.digest];
      }
      if (action === "list") {
        const listing = data as ReturnType<typeof listDecisions>;
        result.summary = listing.packs.length ? listing.packs.map(p => `${p.ref}: ${p.title}`).join("; ") : "No readable decision packs in the active profile.";
        result.facts!.packs = listing.packs.length;
        result.facts!.truncated = listing.truncated;
      }
      if (action === "prepare") {
        const preparation = data as ReturnType<typeof prepareDecision>;
        result.summary = "Preparation gaps are advisory; evidence presence does not certify demand.";
        Object.assign(result.facts!, { candidates: preparation.candidates.length, pause_required: preparation.pause_required,
          method_comparison_available: preparation.method_comparison_available,
          gaps: preparation.candidates.map(c => `${c.candidate.ref}:${c.gaps.join(",")}`).join(";"),
          pending_experiment: preparation.pending_experiment ?? "none" });
      }
      if (action === "experiment.show") result.facts!.cancelled = readDecisionCancellation(db, value("experiment")) !== null;
      if (action === "workpack.show") result.facts!.materials_digest = (data as ReturnType<typeof decisionWorkPackage>).materials_digest;
      if (action === "experiment.cancel") result.facts!.cancelled = true;
      if ("experiment" in data) {
        const experiment = (data as { experiment: ReturnType<typeof readDecisionExperiment> }).experiment;
        result.facts!.experiment_ref = experiment.ref;
        if (experiment.materials) result.facts!.materials_digest = experiment.materials.digest;
      }
      if (action === "experiment.show") {
        const experiment = data as ReturnType<typeof readDecisionExperiment>;
        if (experiment.materials) result.facts!.materials_digest = experiment.materials.digest;
      }
      if (action === "workpack.show") result.facts!.handoff_status = "prepared_not_accepted";
      if (action === "workpack.export") result.facts!.exported = true;
      if ("digest" in data && typeof data.digest === "string") result.evidence = [data.digest];
    }
    events?.end("success", { command: id, ...result.facts });
    return result;
  } catch (error) {
    if (error instanceof MarketStoreError) throw error;
    // Database errors may include bound prose; never emit raw query errors.
    throw new MarketStoreError("decision_storage_error", "Decision operation failed; inspect local database availability.");
  }
}
