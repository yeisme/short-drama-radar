import type { RadarDb } from "../db/client.ts";
import type { CommandResult } from "../output/envelope.ts";
import { initializeMarket, listSources, readSettings, updateSettings, updateSource } from "./sources.ts";
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
import { listWatches, mutateWatch, watchReceipt, type MarketWatch } from "./watch.ts";
import { evidenceForSignal, questionContext } from "./question.ts";
import { buildMarketReview, readMarketReview } from "./review.ts";
import { crossMarketView } from "./cross-market.ts";
import { previousMarketWindow } from "./calendar.ts";
import { recordSamplingCheck, registerSamplingPlan, samplingPlan } from "./sampling.ts";
import { reviewSource, sourceReviewReceipt } from "./source-review.ts";
import { listWorkMappings, workMapping } from "./identity.ts";

export async function marketCommand(command: string[], flags: Map<string, string[]>, db: RadarDb): Promise<CommandResult> {
  const [, group, action] = command;
  const id = ["radar", "market", group, action].filter(Boolean).join(".");
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
    data = analyzeMarket(db, value("start"), value("end"));
  } else if (group === "brief" && action === "build") {
    checkFlags(["start", "end"]);
    const window = flags.has("start") || flags.has("end") ? { start: value("start"), end: value("end") }
      : previousMarketWindow(readSettings(db).timezone, "day");
    const result = buildMarketBrief(db, window.start, window.end);
    data = { ...readMarketBrief(db, result.brief.brief_ref), reused: result.reused };
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
  } else {
    throw new MarketStoreError("command_unknown", "Supported market commands: init, import-legacy, import-catalog, work list/show/review, analyze, brief build/show, review build/show, signal show/correct/restore, evidence show, compare, reader show/mark/unread/catchup/receipt, watch list/add/pause/resume/remove/receipt, question context, source list/show/set/qualify/gaps, config show/set.");
  }
  return {
    command: id, status: "success", summary: "Market " + [group, action].filter(Boolean).join(" ") + " completed.",
    data, facts: { external_collection: false },
    actions: [{ name: "sources", command: "radar market source list" }], exitCode: 0,
  };
}
