import { desc } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketCommand } from "./cli.ts";
import { MarketStoreError } from "./repository.ts";
import type { Lane } from "../app/actions.ts";
import { marketActionNames } from "./mcp-actions.ts";
import { marketBriefs, marketReviews, marketSignals } from "../db/schema.ts";

const views = {
  market_capabilities: { command: [], required: [], optional: [] },
  market_sources: { command: ["source", "list"], required: [], optional: [] },
  market_qualification: { command: ["source", "qualification"], required: ["record"], optional: [] },
  market_coverage: { command: ["source", "gaps"], required: [], optional: [] },
  market_brief: { command: ["brief", "show"], required: [], optional: ["brief"] },
  market_signal: { command: ["signal", "show"], required: ["signal", "revision"], optional: [] },
  market_reader: { command: ["reader", "show"], required: [], optional: [] },
  market_catchup: { command: ["reader", "catchup"], required: [], optional: ["cursor", "limit"] },
  market_watches: { command: ["watch", "list"], required: [], optional: [] },
  market_reader_receipt: { command: ["reader", "receipt"], required: ["key"], optional: [] },
  market_watch_receipt: { command: ["watch", "receipt"], required: ["key"], optional: [] },
  market_review: { command: ["review", "show"], required: ["review"], optional: [] },
  market_evidence: { command: ["evidence", "show"], required: ["signal", "revision", "evidence"], optional: [] },
  market_question: { command: ["question", "context"], required: ["signal", "revision", "question"], optional: [] },
  market_compare: { command: ["compare"], required: ["left", "left_revision", "right", "right_revision"], optional: [] },
  // List projections let CLI-less clients discover which refs exist before
  // drilling into a bound ref/revision. All lists are bounded.
  market_briefs: { command: ["brief", "list"], required: [], optional: [] },
  market_signals: { command: ["signal", "list"], required: [], optional: [] },
  market_reviews: { command: ["review", "list"], required: [], optional: [] },
  market_evidence_list: { command: ["evidence", "list"], required: ["signal", "revision"], optional: [] },
} satisfies Record<string, { command: string[]; required: string[]; optional: string[] }>;

export const MARKET_VIEWS = Object.keys(views);
const numeric = new Set(["revision", "left_revision", "right_revision", "limit"]);
export const MARKET_VIEW_SCHEMAS = Object.entries(views).map(([view, config]) => ({
  type: "object", properties: Object.fromEntries([
    ["view", { const: view }],
    ...[...config.required, ...config.optional].map(name => [name,
      numeric.has(name) ? { type: "integer", minimum: 1, ...(name === "limit" ? { maximum: 100 } : {}) }
        : { type: "string", minLength: 1, maxLength: name === "question" ? 2000 : 2048 }]),
  ]), required: ["view", ...config.required], additionalProperties: false,
}));

export function marketCapabilities(lane: Lane = "reader") {
  return { spec: "radar.market_capabilities.v1", views: MARKET_VIEWS,
    read_only: lane === "reader", external_collection: false, lane,
    mutations: { status: lane === "reader" ? "blocked" : "ready", actions: marketActionNames(lane),
      reason: lane === "reader" ? "Reader lane cannot mutate state." : "Only explicit local actions are available; source/config/observe remain owner CLI operations." },
    recovery: { execution_host: "Radar owner host", command: "radar market source gaps",
      client_requirement: "Use tools/list inputSchema and resources; no client-side CLI or filesystem access is required." },
    limitations: ["Available local projections do not establish live platform coverage."] };
}

const briefSummaries = (db: RadarDb) => db.select().from(marketBriefs)
  .orderBy(desc(marketBriefs.windowEnd), desc(marketBriefs.generatedAt)).limit(30).all()
  .map(row => ({ brief_ref: row.payload.brief_ref, digest: row.payload.digest,
    window: row.payload.window, status: row.payload.status, generated_at: row.payload.generated_at,
    supersedes: row.payload.supersedes }));

const reviewSummaries = (db: RadarDb) => db.select().from(marketReviews)
  .orderBy(desc(marketReviews.windowEnd), desc(marketReviews.cutoff)).limit(30).all()
  .map(row => ({ review_ref: row.payload.review_ref, digest: row.payload.digest,
    window: row.payload.window, as_of: row.payload.as_of, entries: row.payload.entries.length }));

const signalHeads = (db: RadarDb) => {
  const heads = new Map<string, typeof marketSignals.$inferSelect>();
  for (const row of db.select().from(marketSignals).orderBy(desc(marketSignals.observedAt), desc(marketSignals.revision)).limit(500).all()) {
    if (heads.size >= 100) break;
    if (!heads.has(row.ref)) heads.set(row.ref, row);
  }
  return [...heads.values()].map(row => ({ signal_ref: row.payload.signal_ref, revision: row.payload.revision,
    claim_kind: row.payload.claim_kind, lifecycle: row.payload.lifecycle, market: row.payload.market,
    title: row.payload.title, observed_at: row.payload.observed_at }));
};

const evidenceList = (db: RadarDb, signalRef: string, revision: number) => {
  const { signalByRef } = require("./signals.ts") as typeof import("./signals.ts");
  const signal = signalByRef(db, signalRef, revision);
  if (!signal) throw new MarketStoreError("signal_not_found", "Requested signal revision does not exist.");
  return signal.evidence_refs.slice(0, 10).map(ref => ({ evidence_ref: ref }));
};

const listViews = {
  market_briefs: (db: RadarDb) => ({ spec: "radar.market_briefs.v1", briefs: briefSummaries(db),
    limitations: ["Latest 30 briefs; drill into radar://market/briefs/{ref} for the bound payload."] }),
  market_signals: (db: RadarDb) => ({ spec: "radar.market_signals.v1", signals: signalHeads(db),
    limitations: ["Latest 100 signal heads; drill into radar://market/signals/{ref}/revisions/{revision}."] }),
  market_reviews: (db: RadarDb) => ({ spec: "radar.market_reviews.v1", reviews: reviewSummaries(db),
    limitations: ["Latest 30 reviews; drill into radar://market/reviews/{ref}."] }),
  market_evidence_list: (db: RadarDb, args: Record<string, unknown>) => {
    const signal = typeof args.signal === "string" ? args.signal : "";
    const revision = Number(args.revision);
    if (!Number.isSafeInteger(revision) || revision < 1 || !signal) {
      throw new MarketStoreError("input_invalid", "Market view parameters do not match tools/list inputSchema.");
    }
    return { spec: "radar.market_evidence_list.v1", signal_ref: signal, signal_revision: revision,
      evidence: evidenceList(db, signal, revision),
      limitations: ["At most 10 evidence refs; each opens via radar://market/signals/{ref}/revisions/{revision}/evidence/{evidence}."] };
  },
};

export async function marketSearch(db: RadarDb, args: Record<string, unknown>) {
  const view = typeof args.view === "string" ? args.view : "";
  if (!Object.hasOwn(views, view)) throw new MarketStoreError("view_invalid", "Unknown market view; inspect tools/list.");
  const config = views[view as keyof typeof views];
  const names: string[] = [...config.required, ...config.optional];
  if (Object.keys(args).some(key => key !== "view" && !names.includes(key)) ||
    config.required.some(key => args[key] === undefined)) {
    throw new MarketStoreError("input_invalid", "Market view parameters do not match tools/list inputSchema.");
  }
  if (view === "market_capabilities") return { command: "radar.market.capabilities", status: "success" as const,
    summary: "Market reader capabilities.", data: marketCapabilities(), facts: { external_collection: false }, exitCode: 0 };
  if (listViews[view as keyof typeof listViews]) {
    // Bounded discovery lists; the bound single-ref views carry the payloads.
    const data = listViews[view as keyof typeof listViews](db, args);
    return { command: "radar.market." + view.replace("market_", "").replaceAll("_", "."), status: "success" as const,
      summary: "Market list projection.", data, facts: { external_collection: false }, exitCode: 0 };
  }
  const flags = new Map<string, string[]>();
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    if (numeric.has(name) ? (!Number.isSafeInteger(value) || Number(value) < 1 || (name === "limit" && Number(value) > 100))
      : (typeof value !== "string" || !value.length || value.length > (name === "question" ? 2000 : 2048))) {
      throw new MarketStoreError("input_invalid", "Market view parameters do not match tools/list inputSchema.");
    }
    flags.set(name.replaceAll("_", "-"), [String(value)]);
  }
  return marketCommand(["market", ...config.command], flags, db);
}

export const MARKET_STATIC_RESOURCES = ["capabilities", "coverage", "sources", "reader", "watches", "briefs/latest", "catchup", "briefs", "signals", "reviews"]
  .map(path => "radar://market/" + path);
export const MARKET_RESOURCE_TEMPLATES = [
  "briefs/{ref}", "signals/{ref}/revisions/{revision}", "reviews/{ref}", "qualifications/{ref}", "compare/{left}/{left_revision}/{right}/{right_revision}",
  "reader/receipts/{key}", "watch/receipts/{key}",
  "signals/{ref}/revisions/{revision}/evidence/{evidence}",
].map(path => ({ uriTemplate: "radar://market/" + path, name: "market_" + path.replaceAll("/", "_"), mimeType: "application/json" }));

export async function marketResource(db: RadarDb, uri: string, lane: Lane = "reader") {
  const path = uri.slice("radar://market/".length);
  if (path === "catchup" || path.startsWith("catchup?")) {
    const query = new URL(uri).searchParams;
    if ([...query.keys()].some(key => key !== "cursor") || query.getAll("cursor").length > 1) {
      throw new MarketStoreError("input_invalid", "Catch-up resource supports one optional cursor.");
    }
    return (await marketSearch(db, { view: "market_catchup", ...(query.has("cursor") ? { cursor: query.get("cursor") } : {}) })).data;
  }
  const compare = /^compare\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/([1-9]\d*)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/([1-9]\d*)$/.exec(path);
  if (compare) return (await marketSearch(db, { view: "market_compare", left: compare[1], left_revision: Number(compare[2]), right: compare[3], right_revision: Number(compare[4]) })).data;
  if (path === "capabilities") return marketCapabilities(lane);
  const simple: Record<string, string> = { coverage: "market_coverage", sources: "market_sources",
    reader: "market_reader", watches: "market_watches",
    briefs: "market_briefs", signals: "market_signals", reviews: "market_reviews" };
  let args: Record<string, unknown> | undefined;
  if (Object.hasOwn(simple, path)) args = { view: simple[path] };
  else {
    const parts = path.split("/");
    if (parts.some(p => !/^[A-Za-z0-9._:-]+$/.test(p))) throw new MarketStoreError("resource_not_found", "Market resource is unavailable.");
    if (parts.length === 2 && parts[0] === "briefs") args = { view: "market_brief", brief: parts[1] };
    if (parts.length === 2 && parts[0] === "reviews") args = { view: "market_review", review: parts[1] };
    if (parts.length === 2 && parts[0] === "qualifications") args = { view: "market_qualification", record: parts[1] };
    if (parts.length === 3 && parts[1] === "receipts" && ["reader", "watch"].includes(parts[0]))
      args = { view: "market_" + parts[0] + "_receipt", key: parts[2] };
    if ([4, 6].includes(parts.length) && parts[0] === "signals" && parts[2] === "revisions" && /^\d+$/.test(parts[3])) {
      if (parts.length === 4) args = { view: "market_signal", signal: parts[1], revision: Number(parts[3]) };
      else if (parts[4] === "evidence") args = { view: "market_evidence", signal: parts[1], revision: Number(parts[3]), evidence: parts[5] };
    }
  }
  if (!args) throw new MarketStoreError("resource_not_found", "Market resource is unavailable.");
  return (await marketSearch(db, args)).data;
}
