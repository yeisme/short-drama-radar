import type { RadarDb } from "../db/client.ts";
import { marketCommand } from "./cli.ts";
import { MarketStoreError } from "./repository.ts";
import type { Lane } from "../app/actions.ts";
import { marketActionNames } from "./mcp-actions.ts";

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

export const MARKET_STATIC_RESOURCES = ["capabilities", "coverage", "sources", "reader", "watches", "briefs/latest", "catchup"]
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
    reader: "market_reader", watches: "market_watches" };
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
