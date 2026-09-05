import { createHash } from "node:crypto";
import type { RadarConfig } from "../config.ts";
import type { RadarDb } from "../db/client.ts";
import { dailyItems, morningEditions, opportunityReviews, runs } from "../db/schema.ts";
import { and, desc, eq, like } from "drizzle-orm";
import { collect, defaultAdapters, type CollectHooks } from "../pipeline/collect.ts";
import { scoreDay } from "../pipeline/scoring.ts";
import { buildCard } from "../pipeline/card.ts";
import { persistOpportunities, opportunityByRef, loadOpportunities } from "../pipeline/opportunity.ts";
import { addFeedback } from "../pipeline/feedback.ts";
import { rankOpportunities } from "../pipeline/ranker.ts";
import { buildEdition, DEFAULT_LIMIT, editionByRef, latestEdition } from "../pipeline/edition.ts";
import { ProfileService, ProfileError } from "../profile/service.ts";
import type { CommandResult } from "../output/envelope.ts";
import type { EventWriter } from "../output/events.ts";
import type { AdapterContext } from "../adapters/types.ts";
import { makeManualImportAdapter } from "../adapters/manual-import.ts";

// Shared application action registry — the single source of business
// semantics for CLI commands and MCP tools (task 3.2). Handlers here own
// revision/digest/degraded semantics; entry points only parse and render.

export interface AppDeps {
  cfg: RadarConfig;
  db: RadarDb;
  profiles: ProfileService;
}

export class ActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

export function adapterContext(deps: AppDeps): AdapterContext {
  return {
    firecrawlBaseUrl: deps.cfg.firecrawlBaseUrl,
    agentReachBin: deps.cfg.agentReachBin,
    timeoutMs: 60_000,
    fixtureDir: process.env.RADAR_FIXTURE_DIR,
    accountsPath: deps.cfg.accountsPath,
    dailyQuotaPerAccount: deps.cfg.accountPool.dailyQuotaPerAccount,
  };
}

export function recordRun(db: RadarDb, id: string, kind: string, status: string, summary: unknown): void {
  const startedAt = id.startsWith(`${kind}-`) && !Number.isNaN(Date.parse(id.slice(kind.length + 1)))
    ? id.slice(kind.length + 1)
    : new Date().toISOString();
  try {
    db.insert(runs).values({ id, kind, startedAt, finishedAt: new Date().toISOString(), status, summaryJson: JSON.stringify(summary) }).run();
  } catch {
    // Millisecond ids collide when two runs land in the same tick (e.g.
    // daily writing its collect receipt); disambiguate with a short random
    // suffix instead of crashing the whole command.
    const suffix = Math.random().toString(36).slice(2, 6);
    db.insert(runs).values({ id: `${id}-${suffix}`, kind, startedAt, finishedAt: new Date().toISOString(), status, summaryJson: JSON.stringify(summary) }).run();
  }
}

// --- curator actions ---------------------------------------------------------

export function feedbackAddAction(deps: AppDeps, input: { opportunityRef: string; kind: string; profileRef?: string; projectRef?: string; idempotencyKey?: string }): CommandResult {
  const profile = deps.profiles.show(input.profileRef);
  const receipt = addFeedback(deps.db, {
    profileRef: profile.ref,
    opportunityRef: input.opportunityRef,
    kind: input.kind,
    projectRef: input.projectRef,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    command: "radar.feedback.add",
    status: "success",
    summary: `Feedback '${receipt.kind}' recorded${receipt.duplicate ? " (idempotent replay, original receipt returned)" : ""} for ${receipt.opportunityRef}.`,
    facts: { id: receipt.id, kind: receipt.kind, opportunity_ref: receipt.opportunityRef, profile_ref: receipt.profileRef, duplicate: receipt.duplicate },
    actions: [{ name: "rebuild", command: `radar edition build --profile ${profile.ref}` }],
    exitCode: 0,
  };
}

export function opportunityReviewAction(deps: AppDeps, input: { opportunityRef: string; decision: string; profileRef?: string; note?: string; projectRef?: string }): CommandResult {
  if (!["accept", "reject", "needs_evidence"].includes(input.decision)) throw new ActionError("decision_invalid", "decision must be accept|reject|needs_evidence");
  const profile = deps.profiles.show(input.profileRef);
  const opp = opportunityByRef(deps.db, input.opportunityRef);
  if (!opp) throw new ActionError("opportunity_not_found", `opportunity '${input.opportunityRef}' not found`);
  const idempotencyKey = `rev-${profile.ref}-${input.opportunityRef}-${input.decision}`;
  const inserted = deps.db.insert(opportunityReviews).values({
    profileRef: profile.ref,
    opportunityRef: input.opportunityRef,
    decision: input.decision,
    note: input.note ?? "",
    projectRef: input.projectRef ?? "",
    idempotencyKey,
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing().returning({ id: opportunityReviews.id }).all();
  const replayed = inserted.length === 0;
  return {
    command: "radar.opportunity.review",
    status: "success",
    summary: `Review '${input.decision}' recorded${replayed ? " (idempotent replay)" : ""} for ${input.opportunityRef}.`,
    facts: { decision: input.decision, opportunity_ref: input.opportunityRef, profile_ref: profile.ref, duplicate: replayed },
    exitCode: 0,
  };
}

// Local helpers end here.

// --- operator actions ---------------------------------------------------------

export async function collectAction(deps: AppDeps, events?: EventWriter): Promise<CommandResult & { runId: string }> {
  events?.start("radar.collect", { layers: "0-3" });
  const summary = await collect(
    deps.db,
    defaultAdapters({ xhsKeyword: deps.cfg.layer1.xhsKeyword, douyinKeyword: deps.cfg.layer1.douyinKeyword }),
    adapterContext(deps),
    new Date(),
    { onLayer: (result) => events?.layer(result.source, result.degraded, result.items.length, result.errors) },
  );
  recordRun(deps.db, summary.runId, "collect", summary.degradedLayers.length > 0 ? "degraded" : "ok", summary);
  const status = summary.degradedLayers.length > 0 ? "partial" : "success";
  events?.end(status, { items: summary.items, snapshots: summary.snapshots });
  return {
    command: "radar.collect",
    status,
    summary: `Collected ${summary.items} items (${summary.snapshots} snapshots); ${summary.degradedLayers.length} layer(s) degraded.`,
    facts: { date: summary.date, items: summary.items, snapshots: summary.snapshots, degraded_layers: summary.degradedLayers.join(",") || "none" },
    evidence: [`run_id=${summary.runId}`],
    data: summary as unknown as Record<string, unknown>,
    exitCode: 0,
    runId: summary.runId,
  };
}

// Layer 3 manual CSV import. Runs the file through the shared collect()
// pipeline so dedupe (authority order), raw receipts and metric deltas behave
// exactly like every other layer; records its own kind="import" run receipt.
export async function importAction(deps: AppDeps, csvPath: string, dateArg?: string): Promise<CommandResult> {
  const now = dateArg ? new Date(`${dateArg}T12:00:00Z`) : new Date();
  if (dateArg && Number.isNaN(now.getTime())) {
    throw new ActionError("invalid_date", `--date must be YYYY-MM-DD, got '${dateArg}'`);
  }
  const summary = await collect(deps.db, [makeManualImportAdapter(csvPath)], adapterContext(deps), now);
  const badRows = summary.errors.filter((e) => e.startsWith("manual-import: row "));
  // Whole-file failures (unreadable path, missing required column) surface as
  // layer degradation — a silently "successful" import of zero rows would
  // violate the loud-degradation contract.
  const degraded = badRows.length > 0 || summary.degradedLayers.length > 0;
  recordRun(deps.db, `import-${now.toISOString()}`, "import", degraded ? "degraded" : "ok", { ...summary, csvPath });
  const status = degraded ? "partial" : "success";
  return {
    command: "radar.import",
    status,
    summary: `Imported ${summary.items} item(s) from ${csvPath}; ${badRows.length} bad row(s)${summary.errors.length > badRows.length ? `; ${summary.errors[0]}` : ""}.`,
    facts: { date: summary.date, imported: summary.items, bad_rows: badRows.length, errors: summary.errors.slice(0, 3) },
    evidence: [`run_id=import-${now.toISOString()}`],
    data: { items: summary.items, bad_rows: badRows } as unknown as Record<string, unknown>,
    exitCode: 0,
  };
}

export async function scoreAction(deps: AppDeps, date?: string): Promise<CommandResult> {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const summary = await scoreDay(deps.db, day);
  // Deterministic run id over the resulting rows: same-day re-scoring of
  // unchanged data (scoreDay is deterministic) reuses one receipt instead of
  // appending a row per call.
  const fingerprint = createHash("sha256").update(JSON.stringify(
    deps.db.select({ cid: dailyItems.contentId, score: dailyItems.score, conf: dailyItems.confidence, isNew: dailyItems.isNew, tags: dailyItems.tagsJson })
      .from(dailyItems).where(eq(dailyItems.date, day)).all()
      .sort((x, y) => x.cid.localeCompare(y.cid)),
  )).digest("hex").slice(0, 8);
  const id = `score-${day}-${fingerprint}`;
  if (deps.db.select().from(runs).where(eq(runs.id, id)).all().length === 0) {
    recordRun(deps.db, id, "score", summary.lowConfidence > 0 ? "degraded" : "ok", summary);
  }
  return {
    command: "radar.score",
    status: summary.scored === 0 ? "partial" : "success",
    summary: `Scored ${summary.scored} items for ${day}${summary.lowConfidence > 0 ? `; ${summary.lowConfidence} below confidence gate` : ""}.`,
    facts: { date: day, scored: summary.scored, low_confidence: summary.lowConfidence },
    evidence: [`run_id=${id}`],
    exitCode: 0,
  };
}

export function clusterBuildAction(deps: AppDeps, date?: string): CommandResult {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const outcome = persistOpportunities(deps.db, day);
  // Deterministic per-day outcome: identical rebuilds reuse one receipt.
  const id = `cluster-${day}-${createHash("sha256").update(JSON.stringify(outcome)).digest("hex").slice(0, 8)}`;
  if (deps.db.select().from(runs).where(eq(runs.id, id)).all().length === 0) {
    recordRun(deps.db, id, "cluster", "ok", outcome);
  }
  return {
    command: "radar.cluster.build",
    status: "success",
    summary: `Built ${outcome.clusters} opportunity clusters (${outcome.items} member items) for ${day}.`,
    facts: { date: day, clusters: outcome.clusters, items: outcome.items },
    evidence: [`run_id=${id}`],
    exitCode: 0,
  };
}

export function editionBuildAction(deps: AppDeps, input: { date?: string; profileRef?: string; limit?: number }): CommandResult {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const profile = deps.profiles.show(input.profileRef);
  const { edition, excluded, reused } = buildEdition(deps.db, profile, date, input.limit ?? DEFAULT_LIMIT);
  return {
    command: "radar.edition.build",
    status: edition.status === "ready" ? "success" : "partial",
    summary: edition.status === "empty"
      ? `Edition for ${date} is honestly empty: ${edition.limitations.join("; ")}`
      : `Edition ${edition.editionRef} (${edition.status}) with ${edition.entries.length} entries for ${date}.`,
    facts: {
      edition_ref: edition.editionRef,
      status: edition.status,
      entries: edition.entries.length,
      idempotent_reuse: reused,
      profile_ref: edition.profileRef,
      profile_revision: edition.profileRevision,
      excluded_below_threshold: excluded.belowThreshold,
      excluded_blocked: excluded.blocked,
      excluded_suppressed: excluded.suppressed,
    },
    data: edition as unknown as Record<string, unknown>,
    exitCode: 0,
  };
}

export function editionShowAction(deps: AppDeps, input: { ref?: string; profileRef?: string }): CommandResult {
  const profile = deps.profiles.show(input.profileRef);
  const edition = input.ref && input.ref !== "latest" ? editionByRef(deps.db, input.ref) : latestEdition(deps.db, profile.ref);
  if (!edition) throw new ActionError("edition_not_found", `no edition found for ${input.ref ?? `profile ${profile.ref}`}; run 'radar edition build' first`);
  return {
    command: "radar.edition.show",
    status: "success",
    summary: `Edition ${edition.editionRef} (${edition.status}), ${edition.entries.length} entries, generated ${edition.generatedAt}.`,
    facts: { edition_ref: edition.editionRef, status: edition.status, entries: edition.entries.length, date: edition.date },
    data: edition as unknown as Record<string, unknown>,
    actions: [{ name: "feedback", command: "radar feedback add --opportunity <ref> --kind saved|used|dismissed|not_relevant|too_risky|already_seen" }],
    exitCode: 0,
  };
}

export interface DailyRunOutcome extends CommandResult {
  runId: string;
  date: string;
  editionRef?: string;
}

export async function dailyRunAction(deps: AppDeps, events?: EventWriter): Promise<DailyRunOutcome> {
  events?.start("radar.run", { stages: "collect->score->cluster->card+edition" });
  const collectSummary = await collect(
    deps.db,
    defaultAdapters({ xhsKeyword: deps.cfg.layer1.xhsKeyword, douyinKeyword: deps.cfg.layer1.douyinKeyword }),
    adapterContext(deps),
    new Date(),
    { onLayer: (result) => events?.layer(result.source, result.degraded, result.items.length, result.errors) },
  );
  // Record the collect receipt too: card degradation notes and health
  // reports read kind="collect" receipts, and `radar run` must not leave
  // those days invisible to them.
  recordRun(deps.db, collectSummary.runId, "collect", collectSummary.degradedLayers.length > 0 ? "degraded" : "ok", collectSummary);
  const scoreSummary = await scoreDay(deps.db, collectSummary.date);
  const clusters = persistOpportunities(deps.db, collectSummary.date);
  events?.emit({ event: "stage", stage: "cluster", clusters: clusters.clusters });
  const card = buildCard(deps.db, collectSummary.date, new Date(), collectSummary.degradedLayers);
  let editionNote = "edition skipped: profile_required";
  let edition: import("../pipeline/edition.ts").EditionRecord | null = null;
  try {
    const record = deps.profiles.show();
    edition = buildEdition(deps.db, record, collectSummary.date).edition;
    editionNote = `edition ${edition.status} with ${edition.entries.length} entries (${edition.editionRef})`;
    events?.emit({ event: "stage", stage: "edition", status: edition.status, entries: edition.entries.length });
  } catch (err) {
    if (!(err instanceof ProfileError) || err.code !== "profile_required") throw err;
    events?.emit({ event: "stage", stage: "edition", status: "skipped", reason: "profile_required" });
  }
  const dailyId = `daily-${new Date().toISOString()}`;
  recordRun(deps.db, dailyId, "daily", card.sourceStatus.degraded ? "degraded" : "ok", { collect: collectSummary, score: scoreSummary, clusters });
  const status = collectSummary.degradedLayers.length > 0 || card.sourceStatus.degraded ? "partial" : "success";
  events?.end(status, { date: collectSummary.date, items: card.top.douyin.length + card.top.xiaohongshu.length });
  return {
    command: "radar.run",
    status,
    summary: `Daily run for ${collectSummary.date}: ${card.top.douyin.length}+${card.top.xiaohongshu.length} card items, ${clusters.clusters} clusters, ${editionNote}.`,
    facts: {
      date: collectSummary.date,
      card_douyin: card.top.douyin.length,
      card_xiaohongshu: card.top.xiaohongshu.length,
      clusters: clusters.clusters,
      edition_status: edition?.status ?? "skipped",
      degraded: collectSummary.degradedLayers.length > 0,
    },
    evidence: [`run_id=${dailyId}`, `contract=${card.contract}`, `edition_ref=${edition?.editionRef ?? ""}`],
    data: { card, edition } as unknown as Record<string, unknown>,
    exitCode: 0,
    runId: dailyId,
    date: collectSummary.date,
    editionRef: edition?.editionRef,
  };
}

// --- reader action: search ------------------------------------------------------

export interface SearchInput {
  view: "opportunities" | "items" | "editions";
  query?: string;
  date?: string;
  platform?: string;
  profileRef?: string;
  minMarketScore?: number;
  minPersonalFit?: number;
  limit?: number;
}

export function searchAction(deps: AppDeps, input: SearchInput): CommandResult {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const limit = Math.min(Math.max(1, input.limit ?? 20), 100);

  if (input.view === "opportunities") {
    let opps = loadOpportunities(deps.db, date);
    if (input.query) opps = opps.filter((o) => o.topic.includes(input.query!) || o.hookFamily.includes(input.query!));
    if (input.minMarketScore !== undefined) opps = opps.filter((o) => o.marketScore >= input.minMarketScore!);
    // min_personal_fit requires computing the active profile's rerank.
    let fitByRef = new Map<string, { fit: number; reasons: string[] }>();
    if (input.minPersonalFit !== undefined) {
      const profile = deps.profiles.show(input.profileRef);
      const ranked = rankOpportunities(deps.db, profile.profile, profile.ref, opps);
      fitByRef = new Map(ranked.map((r) => [r.opportunity.ref, { fit: r.personalFit, reasons: r.reasonCodes }]));
      opps = ranked.filter((r) => r.personalFit >= input.minPersonalFit!).map((r) => r.opportunity);
    }
    const rows = opps.slice(0, limit).map((o) => ({
      ref: o.ref,
      topic: o.topic,
      hook_family: o.hookFamily,
      market_score: o.marketScore,
      evidence_confidence: o.evidenceConfidence,
      cross_platform: o.crossPlatform,
      degraded: o.degraded,
      members: o.items.length,
      ...(fitByRef.has(o.ref) ? { personal_fit: fitByRef.get(o.ref)!.fit, reason_codes: fitByRef.get(o.ref)!.reasons } : {}),
    }));
    return {
      command: "radar.search",
      status: rows.length === 0 ? "partial" : "success",
      summary: `${rows.length} opportunity cluster(s) for ${date}.`,
      facts: { view: "opportunities", date, count: rows.length },
      data: rows as unknown as Record<string, unknown>,
      exitCode: 0,
    };
  }

  if (input.view === "items") {
    // Filter in SQL BEFORE the limit — applying a title filter after
    // `.limit()` silently truncated matches beyond the first N rows.
    const where = [eq(dailyItems.date, date)];
    if (input.platform) where.push(eq(dailyItems.platform, input.platform));
    if (input.query) where.push(like(dailyItems.title, `%${input.query}%`));
    const rows = deps.db.select().from(dailyItems)
      .where(and(...where))
      .orderBy(desc(dailyItems.score))
      .limit(limit)
      .all()
      .map((r) => ({ platform: r.platform, content_id: r.contentId, title: r.title.slice(0, 60), score: r.score, confidence: r.confidence, degraded: r.degraded === 1 }));
    return {
      command: "radar.search",
      status: rows.length === 0 ? "partial" : "success",
      summary: `${rows.length} daily item(s) for ${date}.`,
      facts: { view: "items", date, count: rows.length },
      data: rows as unknown as Record<string, unknown>,
      exitCode: 0,
    };
  }

  // editions view
  let profile;
  try {
    profile = deps.profiles.show(input.profileRef);
  } catch {
    return {
      command: "radar.search",
      status: "partial",
      summary: "No active profile; edition search needs one.",
      facts: { view: "editions", count: 0 },
      error: { code: "profile_required", message: "run 'radar profile create --name <name>' first" },
      exitCode: 0,
    };
  }
  const editionRows = deps.db.select().from(morningEditions)
    .where(eq(morningEditions.profileRef, profile.ref))
    .orderBy(desc(morningEditions.generatedAt))
    .limit(limit)
    .all()
    .map((r) => ({ ref: r.editionRef, date: r.date, status: r.status, profile_revision: r.profileRevision, generated_at: r.generatedAt, digest: r.digest }));
  return {
    command: "radar.search",
    status: editionRows.length === 0 ? "partial" : "success",
    summary: `${editionRows.length} edition(s) for profile ${profile.ref}.`,
    facts: { view: "editions", profile_ref: profile.ref, count: editionRows.length },
    data: editionRows as unknown as Record<string, unknown>,
    exitCode: 0,
  };
}

// Lane model for radar.execute (cumulative: operator > curator > reader).
export type Lane = "reader" | "curator" | "operator";

export const EXECUTE_ACTIONS: Record<string, { lane: Lane; sideEffect: "local" | "external"; run: (deps: AppDeps, input: Record<string, unknown>) => Promise<CommandResult> }> = {
  feedback_add: { lane: "curator", sideEffect: "local", run: (d, i) => Promise.resolve(feedbackAddAction(d, i as never)) },
  opportunity_review: { lane: "curator", sideEffect: "local", run: (d, i) => Promise.resolve(opportunityReviewAction(d, i as never)) },
  collect: { lane: "operator", sideEffect: "external", run: (d) => collectAction(d) },
  score: { lane: "operator", sideEffect: "local", run: (d, i) => scoreAction(d, i["date"] as string | undefined) },
  cluster_build: { lane: "operator", sideEffect: "local", run: (d, i) => Promise.resolve(clusterBuildAction(d, i["date"] as string | undefined)) },
  edition_build: { lane: "operator", sideEffect: "local", run: (d, i) => Promise.resolve(editionBuildAction(d, i as never)) },
  daily_run: { lane: "operator", sideEffect: "external", run: (d) => dailyRunAction(d) },
};

export function laneAllows(lane: Lane, action: string): boolean {
  const required = EXECUTE_ACTIONS[action]?.lane;
  if (!required) return false;
  const rank = { reader: 0, curator: 1, operator: 2 } as const;
  return rank[lane] >= rank[required];
}
