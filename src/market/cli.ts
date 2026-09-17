import { chineseLocale, listChineseReading, readTitleTranslation, recordTitleTranslation, type TitleTranslation } from "./translation.ts";
import type { RadarDb } from "../db/client.ts";
import type { CommandResult } from "../output/envelope.ts";
import { initializeMarket, listSources, readSettings, registerSourceCandidate, updateSettings, updateSource } from "./sources.ts";
import { MarketStoreError, sourceByRef } from "./repository.ts";
import type { Market } from "./domain.ts";
import { importLegacyRun } from "./legacy.ts";
import { importCatalog } from "./catalog.ts";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { qualificationReport, sourceGaps, recordQualification, qualificationRecord } from "./qualification.ts";
import { analyzeMarket, correctSignal, restoreSignal, reviewWorkIdentity, signalByRef } from "./signals.ts";
import { assertMarketContentReadable } from "./policy.ts";
import { buildMarketBrief, readMarketBrief } from "./brief.ts";
import { changeReadState, readReader, readerReceipt } from "./reader.ts";
import { catchUp } from "./catchup.ts";
import { listWatches, mutateWatch, watchChanges, watchReceipt, type MarketWatch } from "./watch.ts";
import { evidenceForSignal, questionContext } from "./question.ts";
import { buildMarketReview, readMarketReview } from "./review.ts";
import { crossMarketView } from "./cross-market.ts";
import { previousMarketWindow } from "./calendar.ts";
import { recordSamplingCheck, registerSamplingPlan, samplingPlan } from "./sampling.ts";
import { reviewSource, sourceReviewReceipt } from "./source-review.ts";
import { listWorkMappings, workMapping } from "./identity.ts";
import { CURRENT_GATE_VERSION, gateDecisionsForWork, gateRuleSet, promoteWork } from "./gate.ts";
import { gateReport, reviewBatchReceipt, reviewWorkBatch } from "./review-batch.ts";
import { loadConfig } from "../config.ts";
import { migratePg, openPg } from "../db/pg-client.ts";
import { resolvePgConnection, pgConnectionDiagnostics } from "./sync-config.ts";
import { postgresArchive, syncMarketToPg, unsupportedTargetError, verifyMarketPg } from "./sync.ts";
import { normalizeChunkSize } from "./sync-plan.ts";
import type { EventWriter } from "../output/events.ts";
import { buildMarketScheduleUnits, MARKET_SCHEDULE_NEXT_STEPS, MARKET_SCHEDULE_SYNC_HOOK, MARKET_SCHEDULE_TIMES } from "./schedule.ts";
import { observeCatalog } from "./observe.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemdUserDir } from "../schedule.ts";

export async function marketCommand(command: string[], flags: Map<string, string[]>, db: RadarDb, events?: EventWriter): Promise<CommandResult> {
  const [, group, action, nested] = command;
  const id = ["radar", "market", group, action, group === "work" && action === "gate" ? nested : undefined].filter(Boolean).join(".");
  // Long builds stream staged progress; the final end|error event is written
  // by this path on success and by the CLI error path on failure.
  if (events) events.start(id);
  const value = (name: string): string => {
    const values = flags.get(name);
    if (!values || values.length !== 1 || values[0] === "true" || values[0] === "") {
      throw new MarketStoreError("value_required", "Provide one value for --" + name + ".");
    }
    return values[0];
  };
  const revision = () => {
    const n = Number(value("revision"));
    if (!Number.isSafeInteger(n) || n < 1) throw new MarketStoreError("revision_invalid", "revision must be a positive integer.");
    return n;
  };
  const checkFlags = (allowed: string[]) => {
    if ([...flags.keys()].some(k => !allowed.includes(k))) throw new MarketStoreError("flag_invalid", "Unsupported market command flag.");
  };
  let data: unknown;
  if (group === "init" && !action) {
    checkFlags([]);
    data = initializeMarket(db);
  } else if (group === "import-legacy" && !action) {
    checkFlags(["run"]);
    data = importLegacyRun(db, value("run"));
  } else if (group === "import-catalog" && !action) {
    checkFlags(["source", "file", "format", "observed-at", "fixture"]);
    const format = value("format");
    if (format !== "html" && format !== "markdown") throw new MarketStoreError("format_invalid", "format must be html or markdown.");
    if (flags.has("fixture") && flags.get("fixture")?.join() !== "true") throw new MarketStoreError("flag_invalid", "Use --fixture without a value.");
    const file = value("file");
    let content: string;
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 2_000_000) throw new MarketStoreError("input_too_large", "Use a regular catalog file no larger than 2 MB.");
      content = readFileSync(fd, "utf8");
    } catch (error) {
      if (error instanceof MarketStoreError) throw error;
      throw new MarketStoreError("input_unavailable", "Catalog file could not be read.");
    } finally { if (fd !== undefined) closeSync(fd); }
    data = await importCatalog(db, { source: value("source"), content, format,
      observedAt: value("observed-at"), origin: flags.has("fixture") ? "fixture" : "manual" });
  } else if (group === "source" && action === "list") {
    checkFlags([]);
    data = { sources: listSources(db) };
  } else if (group === "source" && action === "register-candidate") {
    // Discovery entry: an agent may register research candidates for
    // regions without a seeded source. Registration writes a planned
    // descriptor only; no adapter, backend or schedule is installed.
    checkFlags(["source", "publisher-group", "locale", "market", "role", "note"]);
    const role = flags.has("role") ? value("role") : "catalog";
    if (!["catalog", "discussion", "industry"].includes(role)) throw new MarketStoreError("flag_invalid", "--role must be catalog, discussion or industry.");
    data = registerSourceCandidate(db, { source_ref: value("source"), publisher_group: value("publisher-group"),
      locale: value("locale"), markets: flags.get("market") ?? [], role: role as "catalog" | "discussion" | "industry",
      ...(flags.has("note") ? { note: value("note") } : {}) });
  } else if (group === "reader" && action === "show") {
    checkFlags([]);
    data = readReader(db);
  } else if (group === "question" && action === "context") {
    checkFlags(["signal", "revision", "question"]);
    data = questionContext(db, { signal_ref: value("signal"), revision: revision(), question: value("question") });
  } else if (group === "evidence" && action === "show") {
    checkFlags(["signal", "revision", "evidence"]);
    data = evidenceForSignal(db, value("signal"), revision(), value("evidence"));
  } else if (group === "watch" && action === "list") {
    checkFlags([]);
    data = { watches: listWatches(db), reader: readReader(db) };
  } else if (group === "watch" && action === "changes") {
    checkFlags(["watch", "since", "until"]);
    data = watchChanges(db, { watch: value("watch"),
      ...(flags.has("since") ? { since: value("since") } : {}),
      ...(flags.has("until") ? { until: value("until") } : {}) });
  } else if (group === "watch" && action === "receipt") {
    checkFlags(["key"]);
    data = watchReceipt(db, value("key"));
    if (!data) throw new MarketStoreError("receipt_not_found", "Watch receipt not found.");
  } else if (group === "watch" && ["add", "pause", "resume", "remove"].includes(action ?? "")) {
    checkFlags(action === "add" ? ["kind", "target", "revision", "policy-revision", "key"] : ["watch", "revision", "policy-revision", "key"]);
    data = mutateWatch(db, { action: action as "add" | "pause" | "resume" | "remove",
      key: value("key"), revision: revision(), policy_revision: value("policy-revision"),
      ...(action === "add" ? { kind: value("kind") as MarketWatch["target_kind"], target: value("target") } : { watch: value("watch") }) });
  } else if (group === "reader" && action === "catchup") {
    checkFlags(["cursor", "limit"]);
    data = catchUp(db, { cursor: flags.has("cursor") ? value("cursor") : undefined,
      limit: flags.has("limit") ? Number(value("limit")) : undefined });
  } else if (group === "reader" && (action === "mark" || action === "unread")) {
    checkFlags(["revision", "policy-revision", "signal", "signal-revision", "key"]);
    const signalRevision = Number(value("signal-revision"));
    data = changeReadState(db, { action, expected_revision: revision(),
      policy_revision: value("policy-revision"), idempotency_key: value("key"),
      signals: [{ ref: value("signal"), revision: signalRevision }] });
  } else if (group === "reader" && action === "receipt") {
    checkFlags(["key"]);
    data = readerReceipt(db, value("key"));
    if (!data) throw new MarketStoreError("receipt_not_found", "No reader receipt exists for this key.");
  } else if (group === "analyze" && !action) {
    checkFlags(["start", "end"]);
    // Without an explicit window the scheduled pass analyzes the previous
    // complete local day — the same default rule `brief build` uses.
    const window = flags.has("start") || flags.has("end") ? { start: value("start"), end: value("end") }
      : previousMarketWindow(readSettings(db).timezone, "day");
    data = analyzeMarket(db, window.start, window.end);
    events?.emit({ event: "phase", phase: "analyzed", window, signals: (data as { created?: number }).created ?? 0 });
  } else if (group === "brief" && action === "build") {
    checkFlags(["start", "end"]);
    const window = flags.has("start") || flags.has("end") ? { start: value("start"), end: value("end") }
      : previousMarketWindow(readSettings(db).timezone, "day");
    const result = buildMarketBrief(db, window.start, window.end);
    data = { ...readMarketBrief(db, result.brief.brief_ref), reused: result.reused };
    events?.emit({ event: "phase", phase: "brief_frozen", window, status: (data as { status: string }).status, reused: result.reused });
  } else if (group === "brief" && action === "show") {
    checkFlags(["brief"]);
    data = readMarketBrief(db, flags.has("brief") ? value("brief") : "latest");
  } else if (group === "compare" && !action) {
    checkFlags(["left", "left-revision", "right", "right-revision"]);
    data = crossMarketView(db,
      { signal_ref: value("left"), revision: Number(value("left-revision")) },
      { signal_ref: value("right"), revision: Number(value("right-revision")) });
  } else if (group === "review" && action === "build") {
    checkFlags(["start", "end", "as-of"]);
    const now = new Date();
    const window = flags.has("start") || flags.has("end") ? { start: value("start"), end: value("end") }
      : previousMarketWindow(readSettings(db).timezone, "week", now);
    const result = buildMarketReview(db, window.start, window.end, flags.has("as-of") ? value("as-of") : now.toISOString(), now);
    data = { ...readMarketReview(db, result.review.review_ref), reused: result.reused };
    events?.emit({ event: "phase", phase: "review_frozen", window, entries: (data as { entries: unknown[] }).entries.length, reused: result.reused });
  } else if (group === "review" && action === "show") {
    checkFlags(["review"]);
    data = readMarketReview(db, value("review"));
  } else if (group === "signal" && action === "show") {
    checkFlags(["signal", "revision"]);
    const signal = signalByRef(db, value("signal"), flags.has("revision") ? revision() : undefined);
    if (!signal) throw new MarketStoreError("signal_not_found", "Requested signal revision does not exist.");
    assertMarketContentReadable(db, signal.topics);
    data = signal;
  } else if (group === "signal" && action === "restore") {
    checkFlags(["signal", "revision", "observation", "reason", "at"]);
    data = restoreSignal(db, { ref: value("signal"), expected_revision: revision(),
      observation_ref: value("observation"), reason: value("reason"), reviewed_at: value("at") });
  } else if (group === "signal" && action === "correct") {
    checkFlags(["signal", "revision", "reason", "evidence", "outcome", "at"]);
    const signal = signalByRef(db, value("signal"), revision());
    if (!signal) throw new MarketStoreError("signal_not_found", "Signal revision not found.");
    assertMarketContentReadable(db, signal.topics);
    data = correctSignal(db, { ref: signal.signal_ref, expected_revision: signal.revision,
      reason: value("reason"), evidence_refs: flags.get("evidence") ?? [],
      outcome: value("outcome") as "retracted" | "inconclusive", corrected_at: value("at") });
  } else if (group === "source" && action === "plan") {
    checkFlags(["source", "revision", "slot"]);
    data = registerSamplingPlan(db, value("source"), revision(), flags.get("slot") ?? []);
  } else if (group === "source" && action === "show-plan") {
    checkFlags(["source", "revision"]);
    data = samplingPlan(db, value("source"), revision());
    if (!data) throw new MarketStoreError("sampling_plan_not_found", "No plan exists for this source revision.");
  } else if (group === "source" && action === "check-sample") {
    checkFlags(["batch", "scheduled-at", "checked-at", "completeness", "stable-ids", "metric-contract-valid", "failure-sample"]);
    const boolean = (name: string) => {
      const raw = flags.get(name);
      if (!raw || raw.length !== 1 || !["true", "false"].includes(raw[0])) throw new MarketStoreError("value_required", "Use true or false for --" + name + ".");
      return raw[0] === "true";
    };
    data = recordSamplingCheck(db, { batch_ref: value("batch"), scheduled_at: value("scheduled-at"), checked_at: value("checked-at"),
      completeness: value("completeness") as "complete" | "partial", stable_ids: boolean("stable-ids"),
      metric_contract_valid: boolean("metric-contract-valid"), failure_sample_ref: value("failure-sample") });
  } else if (group === "source" && action === "review") {
    checkFlags(["source", "revision", "stage", "reason", "evidence", "batch", "key"]);
    data = reviewSource(db, { source_ref: value("source"), revision: revision(), stage: value("stage") as "identity" | "sample" | "blocked",
      reason: value("reason"), evidence_refs: flags.get("evidence") ?? [], key: value("key"),
      ...(flags.has("batch") ? { batch_ref: value("batch") } : {}) });
  } else if (group === "source" && action === "review-receipt") {
    checkFlags(["key"]);
    data = sourceReviewReceipt(db, value("key"));
  } else if (group === "source" && action === "record-qualification") {
    checkFlags(["source", "revision"]);
    data = recordQualification(db, value("source"), revision());
  } else if (group === "source" && action === "qualification") {
    checkFlags(["record"]);
    data = qualificationRecord(db, value("record"));
  } else if (group === "source" && action === "qualify") {
    checkFlags(["source"]);
    data = qualificationReport(db, value("source"));
  } else if (group === "source" && action === "gaps") {
    checkFlags([]);
    data = sourceGaps(db);
  } else if (group === "source" && action === "show") {
    checkFlags(["source", "revision"]);
    data = sourceByRef(db, value("source"), flags.has("revision") ? revision() : undefined);
    if (!data) throw new MarketStoreError("source_not_found", "Requested source revision is not registered.");
  } else if (group === "source" && action === "set") {
    checkFlags(["source", "revision", "sampling-scope", "freshness-seconds", "locale", "market", "limitation"]);
    const patch: Parameters<typeof updateSource>[3] = {};
    if (flags.has("sampling-scope")) patch.sampling_scope = value("sampling-scope");
    if (flags.has("freshness-seconds")) patch.freshness_budget = value("freshness-seconds") === "unknown" ? null : Number(value("freshness-seconds"));
    if (flags.has("locale")) patch.locale = value("locale");
    if (flags.has("market")) patch.market_scope = flags.get("market") as Market[];
    if (flags.has("limitation")) patch.limitations = flags.get("limitation");
    if (!Object.keys(patch).length) throw new MarketStoreError("value_required", "Provide at least one source setting.");
    data = updateSource(db, value("source"), revision(), patch);
  } else if (group === "config" && action === "show") {
    checkFlags([]);
    data = readSettings(db);
  } else if (group === "config" && action === "set") {
    checkFlags(["revision", "timezone", "blocked-topic", "clear-blocked-topics"]);
    const patch: Parameters<typeof updateSettings>[2] = {};
    if (flags.has("timezone")) patch.timezone = value("timezone");
    if (flags.has("blocked-topic")) patch.blocked_topics = flags.get("blocked-topic");
    if (flags.has("clear-blocked-topics")) {
      if (flags.has("blocked-topic") || flags.get("clear-blocked-topics")?.join() !== "true") throw new MarketStoreError("flag_invalid", "Use --clear-blocked-topics alone without a value.");
      patch.blocked_topics = [];
    }
    if (!Object.keys(patch).length) throw new MarketStoreError("value_required", "Provide at least one market setting.");
    data = updateSettings(db, revision(), patch);
  } else if (group === "translation" && action === "add") {
    checkFlags(["work", "work-revision", "revision", "language", "text", "method", "translator", "key", "reason"]);
    data = recordTitleTranslation(db, { work_ref: value("work"), work_revision: Number(value("work-revision")),
      revision: Number(value("revision")), target_locale: chineseLocale(value("language")), translated_title: value("text"),
      method: value("method") as TitleTranslation["method"], translator_ref: value("translator"), key: value("key"),
      ...(flags.has("reason") ? { reason: value("reason") } : {}) });
  } else if (group === "translation" && action === "show") {
    checkFlags(["work", "language", "revision"]);
    data = readTitleTranslation(db, value("work"), chineseLocale(value("language")), flags.has("revision") ? revision() : undefined);
  } else if (group === "reading" && action === "list") {
    checkFlags(["language", "source", "limit"]);
    data = listChineseReading(db, { language: chineseLocale(flags.has("language") ? value("language") : "zh-Hans"),
      ...(flags.has("source") ? { source: value("source") } : {}), ...(flags.has("limit") ? { limit: Number(value("limit")) } : {}) });
  } else if (group === "work" && action === "list") {
    checkFlags(["status"]);
    let status: "candidate" | "verified" | undefined;
    if (flags.has("status")) {
      status = value("status") as "candidate" | "verified";
      if (status !== "candidate" && status !== "verified") throw new MarketStoreError("flag_invalid", "--status must be candidate or verified.");
    }
    data = { works: listWorkMappings(db, status) };
  } else if (group === "work" && action === "show") {
    checkFlags(["work", "revision"]);
    const mapping = workMapping(db, value("work"), flags.has("revision") ? revision() : undefined);
    if (!mapping) throw new MarketStoreError("identity_not_found", "Requested work mapping revision does not exist.");
    data = mapping;
  } else if (group === "work" && action === "review") {
    checkFlags(["work", "revision", "canonical", "evidence"]);
    // Identity review runs through the signal-aware wrapper: moving a
    // verified canonical ref appends corrections to affected signals.
    data = reviewWorkIdentity(db, { work: value("work"), expected_revision: revision(),
      canonical_work_ref: value("canonical"), evidence_refs: flags.get("evidence") ?? [] });
  } else if (group === "work" && action === "gate" && nested === "show") {
    checkFlags(["version"]);
    data = gateRuleSet(flags.has("version") ? value("version") : CURRENT_GATE_VERSION);
  } else if (group === "work" && action === "gate" && nested === "report") {
    checkFlags(["source", "batch", "version"]);
    data = gateReport(db, {
      ...(flags.has("source") ? { source_ref: value("source") } : {}),
      ...(flags.has("batch") ? { batch_ref: value("batch") } : {}),
    }, flags.has("version") ? value("version") : CURRENT_GATE_VERSION);
  } else if (group === "work" && action === "gate" && nested === "decisions") {
    checkFlags(["work", "version"]);
    data = { decisions: gateDecisionsForWork(db, value("work"), flags.has("version") ? value("version") : undefined) };
  } else if (group === "work" && action === "gate") {
    throw new MarketStoreError("command_unknown", "Use 'market work gate show', 'market work gate report' or 'market work gate decisions'.");
  } else if (group === "work" && action === "review-batch") {
    checkFlags(["source", "batch", "key"]);
    data = reviewWorkBatch(db, {
      source_ref: value("source"), key: value("key"),
      ...(flags.has("batch") ? { batch_ref: value("batch") } : {}),
    });
  } else if (group === "work" && action === "review-batch-receipt") {
    checkFlags(["key"]);
    data = reviewBatchReceipt(db, value("key"));
    if (!data) {
      throw new MarketStoreError("receipt_not_found",
        "Review-batch receipt not found. If a previous run outcome is unknown, query this key before replaying; do not mint a second key.");
    }
  } else if (group === "work" && action === "promote") {
    checkFlags(["work", "revision", "canonical", "evidence", "override-reason"]);
    data = promoteWork(db, {
      work: value("work"), expected_revision: revision(),
      canonical_work_ref: value("canonical"), evidence_refs: flags.get("evidence") ?? [],
      ...(flags.has("override-reason") ? { override_reason: value("override-reason") } : {}),
    });
  } else if (group === "observe" && !action) {
    checkFlags(["source", "mode", "confirm-live", "fixture", "observed-at"]);
    if (flags.has("confirm-live") && flags.get("confirm-live")?.join() !== "true") {
      throw new MarketStoreError("flag_invalid", "Use --confirm-live without a value.");
    }
    if (flags.has("fixture") && flags.get("fixture")?.join() !== "true") {
      throw new MarketStoreError("flag_invalid", "Use --fixture without a value.");
    }
    const mode = value("mode");
    if (mode !== "verify-sample" && mode !== "production") {
      throw new MarketStoreError("mode_invalid", "mode must be verify-sample or production.");
    }
    data = await observeCatalog(db, {
      source: value("source"),
      mode,
      confirmLive: flags.has("confirm-live"),
      fixture: flags.has("fixture"),
      observedAt: flags.has("observed-at") ? value("observed-at") : undefined,
      fixtureDir: process.env.RADAR_FIXTURE_DIR,
    });
  } else if (group === "sync" && !action) {
    // PG archive sync: SQLite stays the source of truth; the archive is
    // append-only. Long syncs stream start -> table_synced phases -> end.
    checkFlags(["to", "chunk-size", "verify", "reset-cursor", "confirm-reset", "allow-target-change"]);
    const target = value("to");
    if (target !== "pg") throw unsupportedTargetError(target);
    const switchFlag = (name: string): boolean => {
      if (!flags.has(name)) return false;
      if (flags.get(name)?.join() !== "true") throw new MarketStoreError("flag_invalid", "Use --" + name + " without a value.");
      return true;
    };
    const verifyOnly = switchFlag("verify");
    const resetCursor = switchFlag("reset-cursor");
    const confirmReset = switchFlag("confirm-reset");
    if (resetCursor && !confirmReset) {
      throw new MarketStoreError("flag_invalid", "--reset-cursor requires --confirm-reset; the full replay is idempotent but must be confirmed explicitly.");
    }
    // Validate cheap inputs before any connection is attempted.
    if (flags.has("chunk-size")) normalizeChunkSize(value("chunk-size"));
    const connection = resolvePgConnection(loadConfig());
    const pg = await openPg(connection.dsn);
    try {
      const archive = postgresArchive(pg.db);
      const diagnostics = pgConnectionDiagnostics(connection);
      const warnings = connection.warnings;
      if (verifyOnly) {
        // Zero-write reconciliation: no migrate, no inserts.
        const report = await verifyMarketPg(db, archive, connection.fingerprint, { allowTargetChange: switchFlag("allow-target-change") });
        const payload = { verify: true, ok: report.ok, tables_checked: report.tables_checked, differences: report.differences, ...diagnostics, warnings };
        if (!report.ok) {
          events?.end("failed", { command: id, differences: report.differences.length });
          return {
            command: id, status: "failed",
            summary: `Archive verification found ${report.differences.length} difference(s); both sides were left untouched.`,
            data: payload, facts: { verify: true, differences: report.differences.length, ...diagnostics },
            error: { code: "verify_diverged", message: "Archived rows diverge from the SQLite source; review the listed differences — existing archive rows are never updated or deleted." },
            actions: [{ name: "resync", command: "radar market sync --to pg" }], exitCode: 1,
          };
        }
        events?.end("success", { command: id, verify: true });
        return {
          command: id, status: "success",
          summary: `Archive verified: ${report.tables_checked} tables match the SQLite source.`,
          data: payload, facts: { verify: true, differences: 0, ...diagnostics },
          actions: [{ name: "sync", command: "radar market sync --to pg" }], exitCode: 0,
        };
      }
      await migratePg(pg.db);
      const report = await syncMarketToPg(db, archive, connection.fingerprint, {
        ...(flags.has("chunk-size") ? { chunkSize: value("chunk-size") } : {}),
        resetCursor, confirmReset,
        allowTargetChange: switchFlag("allow-target-change"),
      }, events);
      const payload = { ...report, ...diagnostics, warnings };
      events?.end("success", { command: id, rows_synced: report.rows_synced, rows_reused: report.rows_reused });
      return {
        command: id, status: "success",
        summary: `Synced ${report.rows_synced} row(s) to the PostgreSQL archive (${report.rows_reused} reused, ${report.chunks} chunk(s)${report.resumed ? ", resumed" : ""}).`,
        data: payload,
        facts: {
          tables: report.tables.length, rows_synced: report.rows_synced, rows_reused: report.rows_reused,
          chunks: report.chunks, resumed: report.resumed, ...diagnostics,
        },
        actions: [{ name: "verify", command: "radar market sync --to pg --verify" }], exitCode: 0,
      };
    } finally {
      await pg.close();
    }
  } else if (group === "canary" && action === "report") {
    checkFlags(["days"]);
    throw new MarketStoreError("capability_unavailable",
      "The 14-day market canary is planned but not started; it requires real source qualification and a real observation window, and when implemented must consume persisted observation quality records (radar.observation_quality.v1) as coverage and parse-regression evidence. The personal canary report (radar canary report) keeps its original meaning.");
  } else if (group === "schedule" && (action === "show" || action === "install")) {
    checkFlags(["print"]);
    if (action === "show") {
      if (flags.has("print")) throw new MarketStoreError("flag_invalid", "Use 'market schedule install --print' for unit contents.");
      const planned = [{ stage: "observe", status: "planned" as const,
        reason: "Scheduled observation starts only after a source passes qualification and the owner CLI exposes observe; no timer is generated for it yet." }];
      data = { scheduled_stages: ["analyze", "brief"],
        planned_stages: planned,
        local_times: MARKET_SCHEDULE_TIMES,
        observe_policy: "two slots per day 12h apart, per-source 60s timeout, at most two read-only retries (2s/8s backoff), global concurrency 2, 24h cooldown on login/risk-control failures",
        sync_hook: MARKET_SCHEDULE_SYNC_HOOK,
        installed_note: "Printing or writing units never enables a timer; enable steps are owner actions." };
    } else {
      const execStart = `${process.execPath} ${join(import.meta.dir, "../cli.ts")}`;
      const units = buildMarketScheduleUnits(execStart);
      const target = systemdUserDir(process.env.HOME ?? "~");
      if (flags.has("print")) {
        data = { units_written: 0, target, units, sync_hook: MARKET_SCHEDULE_SYNC_HOOK };
      } else {
        mkdirSync(target, { recursive: true });
        for (const [name, content] of Object.entries(units)) writeFileSync(join(target, name), content);
        data = { units_written: Object.keys(units).length, target,
          next_steps: MARKET_SCHEDULE_NEXT_STEPS,
          sync_hook: MARKET_SCHEDULE_SYNC_HOOK,
          note: "Units were written but not enabled; enabling the timers is an explicit owner action." };
      }
    }
  } else if (group === "schedule" && !action) {
    throw new MarketStoreError("command_unknown", "Use 'market schedule show' or 'market schedule install [--print]'.");
  } else {
    throw new MarketStoreError("command_unknown", "Supported market commands: translation add/show, reading list, init, import-legacy, import-catalog, work list/show/review/gate show|report|decisions/review-batch/review-batch-receipt/promote, analyze, brief build/show, review build/show, signal show/correct/restore, evidence show, compare, reader show/mark/unread/catchup/receipt, watch list/add/pause/resume/remove/changes/receipt, question context, source list/show/set/qualify/gaps/register-candidate, config show/set, schedule show/install, observe, sync.");
  }
  if (group === "reading" && action === "list") {
    const reading = data as ReturnType<typeof listChineseReading>;
    const result: CommandResult = { command: id, status: "success", summary: reading.items.length
      ? reading.items.slice(0, 5).map(i => `${i.original_title} -> ${i.display_title} [${i.status}; ${i.status === "current" ? "unreviewed" : "original"}]`).join("; ")
      : "No readable works match this source.", data,
      facts: { external_collection: false, entries: reading.items.length, language: reading.language, truncated: reading.truncated,
        missing: reading.items.filter(i => i.status === "missing").length, stale: reading.items.filter(i => i.status === "stale").length },
      actions: [{ name: "inspect", command: `radar market reading list --language ${reading.language} --json` }], exitCode: 0 };
    events?.end("success", { command: id, ...result.facts });
    return result;
  }
  if (group === "translation") {
    const record = data as { translation: TitleTranslation | null; reused?: boolean; source_current?: boolean; status?: string };
    const facts = { external_collection: false, revision: record.translation?.revision ?? 0,
      source_current: record.source_current ?? (record.status === "current"), review_status: record.translation?.review_status ?? "missing" };
    const summary = action !== "add" ? "Translation record inspected; reading aid only, no model call."
      : record.reused ? "Translation replay returned the original receipt; reading aid only, no model call."
      : record.source_current === false ? "Translation recorded, but its source has changed; it stays a stale reading aid."
      : "Translation recorded as an unreviewed reading aid; no model call.";
    events?.end("success", { command: id, ...facts });
    return { command: id, status: "success", summary, data, facts, exitCode: 0 };
  }
  events?.end("success", { command: id });
  const live = !!data && typeof data === "object" && "origin" in data && (data as { origin?: string }).origin === "live";
  return {
    command: id, status: "success", summary: "Market " + [group, action].filter(Boolean).join(" ") + " completed.",
    data, facts: { external_collection: live },
    actions: [{ name: "sources", command: "radar market source list" }], exitCode: 0,
  };
}
