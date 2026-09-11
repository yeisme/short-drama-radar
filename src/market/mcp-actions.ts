import type { Lane } from "../app/actions.ts";
import type { RadarDb } from "../db/client.ts";
import { changeReadState, type SignalVersion } from "./reader.ts";
import { mutateWatch, type MarketWatch } from "./watch.ts";
import { MarketStoreError } from "./repository.ts";
import { marketCommand } from "./cli.ts";

const actions = {
  market_reader_mark: ["key", "revision", "policy_revision", "signals"],
  market_reader_unread: ["key", "revision", "policy_revision", "signals"],
  market_watch_add: ["key", "revision", "policy_revision", "kind", "target"],
  market_watch_pause: ["key", "revision", "policy_revision", "watch"],
  market_watch_resume: ["key", "revision", "policy_revision", "watch"],
  market_watch_remove: ["key", "revision", "policy_revision", "watch"],
  market_analyze: ["start", "end"],
  market_brief_build: ["start", "end"],
  market_review_build: ["start", "end", "as_of"],
} satisfies Record<string, string[]>;

export function marketActionAllowed(lane: Lane, action: string) {
  if (!Object.hasOwn(actions, action) || lane === "reader") return false;
  return lane === "operator" || action.startsWith("market_reader_") || action.startsWith("market_watch_");
}
export function marketActionNames(lane: Lane) { return Object.keys(actions).filter(a => marketActionAllowed(lane, a)); }

const stringSchema = { type: "string", minLength: 1, maxLength: 2048 };
const revisionSchema = { type: "integer", minimum: 1 };
const signalsSchema = { type: "array", minItems: 1, maxItems: 100, items: {
  type: "object", properties: { ref: stringSchema, revision: revisionSchema }, required: ["ref", "revision"], additionalProperties: false,
} };
export function marketActionSchemas(lane: Lane) {
  return marketActionNames(lane).map(action => {
    const names = actions[action as keyof typeof actions];
    return { type: "object", properties: { action: { const: action }, input: {
      type: "object", properties: Object.fromEntries(names.map(name => [name,
        name === "signals" ? signalsSchema : name === "revision" ? revisionSchema : name === "kind"
          ? { enum: ["topic", "work", "platform", "market"] } : stringSchema])), required: names, additionalProperties: false,
    } }, required: ["action", "input"], additionalProperties: false };
  });
}

export async function marketExecute(db: RadarDb, lane: Lane, action: string, input: unknown) {
  if (!marketActionAllowed(lane, action)) throw new MarketStoreError("action_denied", "Market action is unavailable for this connection lane.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MarketStoreError("input_invalid", "Provide the action input shown by tools/list.");
  const payload = input as Record<string, unknown>;
  const names: string[] = actions[action as keyof typeof actions];
  if (Object.keys(payload).some(k => !names.includes(k)) || names.some(k => payload[k] === undefined)) {
    throw new MarketStoreError("input_invalid", "Action fields do not match tools/list inputSchema.");
  }
  for (const name of names) {
    const value = payload[name];
    if (name === "signals") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some(s => !s || typeof s !== "object" ||
        Object.keys(s).some(k => !["ref", "revision"].includes(k)) || typeof s.ref !== "string" || !Number.isSafeInteger(s.revision) || s.revision < 1)) {
        throw new MarketStoreError("input_invalid", "Provide 1–100 explicit signal references and revisions.");
      }
    } else if (name === "revision" ? !Number.isSafeInteger(value) || Number(value) < 1
      : typeof value !== "string" || !value.length || value.length > 2048) {
      throw new MarketStoreError("input_invalid", "Action fields do not match tools/list inputSchema.");
    }
  }
  if (action.startsWith("market_reader_")) return changeReadState(db, {
    action: action === "market_reader_mark" ? "mark" : "unread", idempotency_key: payload.key as string,
    expected_revision: payload.revision as number, policy_revision: payload.policy_revision as string,
    signals: payload.signals as SignalVersion[],
  });
  if (action.startsWith("market_watch_")) return mutateWatch(db, {
    action: action.slice("market_watch_".length) as "add" | "pause" | "resume" | "remove",
    key: payload.key as string, revision: payload.revision as number, policy_revision: payload.policy_revision as string,
    ...(action === "market_watch_add" ? { kind: payload.kind as MarketWatch["target_kind"], target: payload.target as string }
      : { watch: payload.watch as string }),
  });
  const command = action === "market_analyze" ? ["analyze"] : action === "market_brief_build" ? ["brief", "build"] : ["review", "build"];
  const flags = new Map(names.map(name => [name.replaceAll("_", "-"), [payload[name] as string]]));
  return (await marketCommand(["market", ...command], flags, db)).data;
}
