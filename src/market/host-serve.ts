// Local stdio host seam for DSH market clients (radar-market-host-seam-v1).
//
// `radar market host-serve` speaks newline-delimited JSON frames on
// stdin/stdout (schema radar.market.host.frame.v1); stderr is diagnostics
// only. A DSH adapter spawns this process as its Radar owner host: read
// frames reuse the existing market service functions (payloads are the same
// objects the CLI renders into --json data), dispatch maps one typed
// proposal intent to the owner-local assignment create, and every frame
// error is a named secret-free code. No network listener, no daemon, one
// local consumer; the loop ends on stdin close or a shutdown frame.
// Contract: docs/interfaces/market-host-seam.md.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { desc, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketReviews, radarAssignments } from "../db/schema.ts";
import { ProfileService, ProfileError } from "../profile/service.ts";
import { createAssignment } from "../pipeline/assignment.ts";
import { MarketStoreError } from "./repository.ts";
import { marketCommand } from "./cli.ts";

export const MARKET_HOST_FRAME_SPEC = "radar.market.host.frame.v1";
export const MARKET_HOST_RECEIPT_SPEC = "dsh.radar.receipt.v1";

// Views the seam actually serves; the DSH capability probe only trusts this
// declaration (required: market_brief + market_reader).
export const MARKET_HOST_VIEWS = [
  "market_capabilities", "market_brief", "market_reader", "market_catchup", "market_signal",
  "market_evidence", "market_compare", "market_reviews", "market_review",
] as const;

// Opaque ref charset shared with the DSH contracts; blocks traversal,
// credentials and URL-shaped input before any command routing.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const UNSAFE_BLOB = /https?:\/\/|file:\/\/|(?:^|\s)\/[\w.-]+\/|[A-Za-z]:\\|(?:authorization|cookie|password|secret|token)\s*[:=]|-----BEGIN/i;
const SAFE_CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;

export interface MarketHostIo {
  input: Readable;
  output: Writable;
  diagnostics?: Writable;
}

function marketHostCapabilities() {
  return {
    spec: "radar.market_capabilities.v1",
    views: [...MARKET_HOST_VIEWS],
    read_only: true,
    external_collection: false,
    lane: "reader",
    mutations: {
      status: "unavailable",
      actions: [],
      reason:
        "Host seam serves reads and typed proposal dispatch only; reader/watch writes run on the owner CLI after explicit user confirmation.",
    },
    recovery: {
      execution_host: "Radar owner host",
      command: "radar doctor --json",
      client_requirement:
        "Consume this stdio seam per docs/interfaces/market-host-seam.md; never spawn the CLI from the browser or read SQLite directly.",
    },
    limitations: [
      "Available local projections do not establish live platform coverage.",
      "MCP face was removed 2026-09-15; parameter discovery is command --help and doctor actions[].command.",
    ],
  };
}

// Bounded discovery list of owner-frozen reviews (latest 30, summaries only),
// mirroring the CLI-adjacent projection the DSH review index expects.
function reviewIndex(db: RadarDb) {
  const reviews = db
    .select()
    .from(marketReviews)
    .orderBy(desc(marketReviews.windowEnd), desc(marketReviews.cutoff))
    .limit(30)
    .all()
    .map((row) => ({
      review_ref: row.payload.review_ref,
      digest: row.payload.digest,
      window: row.payload.window,
      as_of: row.payload.as_of,
      entries: row.payload.entries.length,
    }));
  return {
    spec: "radar.market_reviews.v1",
    reviews,
    limitations: ["Latest 30 reviews; drill into radar://market/reviews/{ref} for the bound payload."],
  };
}

async function runCommand(db: RadarDb, command: string[], flags: Map<string, string[]>): Promise<unknown> {
  const result = await marketCommand(["market", ...command], flags, db);
  return result.data;
}

function flag(name: string, value: string): Map<string, string[]> {
  return new Map([[name, [value]]]);
}

// One allowed query key per resource; unknown or repeated keys are refused so
// frames never smuggle extra flags into the CLI router.
function queryOf(uri: string, allowed: string[]): URLSearchParams {
  const query = new URL(uri).searchParams;
  for (const key of [...query.keys()]) {
    if (!allowed.includes(key) || query.getAll(key).length > 1) {
      throw new MarketStoreError("input_invalid", `Resource supports at most one of each query parameter: ${allowed.join(", ")}.`);
    }
  }
  return query;
}

function instantParam(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null) return undefined;
  if (value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) {
    throw new MarketStoreError("input_invalid", `${name} must be a UTC instant.`);
  }
  return value;
}

async function readResource(db: RadarDb, uri: string): Promise<unknown> {
  const prefix = "radar://market/";
  if (!uri.startsWith(prefix) || uri.length > 4096) {
    throw new MarketStoreError("resource_not_found", "Market resource is unavailable.");
  }
  const rest = uri.slice(prefix.length);
  const path = rest.split("?", 1)[0]!;
  const parts = path.split("/");
  if (parts.some((part) => !SAFE_SEGMENT.test(part) && !/^\d+$/.test(part))) {
    throw new MarketStoreError("resource_not_found", "Market resource path contains unsafe segments.");
  }
  if (path === "capabilities") return marketHostCapabilities();
  if (path === "reader") return runCommand(db, ["reader", "show"], new Map());
  if (path === "coverage") return runCommand(db, ["source", "gaps"], new Map());
  if (path === "sources") return runCommand(db, ["source", "list"], new Map());
  if (path === "watches") return runCommand(db, ["watch", "list"], new Map());
  if (path === "briefs/latest") return runCommand(db, ["brief", "show"], new Map());
  if (path === "reviews") return reviewIndex(db);
  if (path === "catchup" || path.startsWith("catchup?")) {
    const query = queryOf(uri, ["cursor", "limit"]);
    const flags = new Map<string, string[]>();
    const cursor = query.get("cursor");
    if (cursor !== null) {
      if (!SAFE_CURSOR.test(cursor)) throw new MarketStoreError("cursor_invalid", "Catch-up cursor is invalid.");
      flags.set("cursor", [cursor]);
    }
    const limit = query.get("limit");
    if (limit !== null) {
      const parsed = Number(limit);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new MarketStoreError("input_invalid", "limit must be an integer between 1 and 100.");
      }
      flags.set("limit", [limit]);
    }
    return runCommand(db, ["reader", "catchup"], flags);
  }
  if (path === "question") {
    const query = queryOf(uri, ["signal", "revision", "question"]);
    const signal = query.get("signal");
    const revision = Number(query.get("revision"));
    const question = query.get("question");
    if (!signal || !SAFE_SEGMENT.test(signal) || !Number.isSafeInteger(revision) || revision < 1 ||
      typeof question !== "string" || question.length < 1 || question.length > 2000) {
      throw new MarketStoreError("input_invalid", "Question context requires signal, revision and a 1-2000 character question.");
    }
    return runCommand(db, ["question", "context"], new Map([
      ["signal", [signal]], ["revision", [String(revision)]], ["question", [question]],
    ]));
  }
  if (path === "reading") {
    const query = queryOf(uri, ["language", "source", "limit"]);
    const flags = new Map<string, string[]>();
    const language = query.get("language");
    if (language !== null) {
      if (!["zh-Hans", "zh-Hant"].includes(language)) throw new MarketStoreError("input_invalid", "language must be zh-Hans or zh-Hant.");
      flags.set("language", [language]);
    }
    const source = query.get("source");
    if (source !== null) {
      if (!SAFE_SEGMENT.test(source)) throw new MarketStoreError("input_invalid", "source must be a safe ref.");
      flags.set("source", [source]);
    }
    const limit = query.get("limit");
    if (limit !== null) {
      const parsed = Number(limit);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new MarketStoreError("input_invalid", "limit must be an integer between 1 and 100.");
      }
      flags.set("limit", [limit]);
    }
    return runCommand(db, ["reading", "list"], flags);
  }
  // Template routes below; every segment was charset-checked above.
  if (parts.length === 2 && parts[0] === "briefs") return runCommand(db, ["brief", "show"], flag("brief", parts[1]!));
  if (parts.length === 2 && parts[0] === "reviews") return runCommand(db, ["review", "show"], flag("review", parts[1]!));
  if (parts.length === 3 && parts[0] === "watches" && parts[2] === "changes") {
    const query = queryOf(uri, ["since", "until"]);
    const flags = flag("watch", parts[1]!);
    const since = instantParam(query, "since");
    const until = instantParam(query, "until");
    if (since !== undefined) flags.set("since", [since]);
    if (until !== undefined) flags.set("until", [until]);
    return runCommand(db, ["watch", "changes"], flags);
  }
  const compare = /^compare\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/([1-9]\d*)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/([1-9]\d*)$/.exec(path);
  if (compare) {
    return runCommand(db, ["compare"], new Map([
      ["left", [compare[1]!]], ["left-revision", [compare[2]!]], ["right", [compare[3]!]], ["right-revision", [compare[4]!]],
    ]));
  }
  if (parts.length === 4 && parts[0] === "signals" && parts[2] === "revisions" && /^\d+$/.test(parts[3]!)) {
    return runCommand(db, ["signal", "show"], new Map([["signal", [parts[1]!]], ["revision", [parts[3]!]]]));
  }
  if (parts.length === 6 && parts[0] === "signals" && parts[2] === "revisions" && /^\d+$/.test(parts[3]!) && parts[4] === "evidence") {
    return runCommand(db, ["evidence", "show"], new Map([
      ["signal", [parts[1]!]], ["revision", [parts[3]!]], ["evidence", [parts[5]!]],
    ]));
  }
  throw new MarketStoreError("resource_not_found", "Market resource is unavailable.");
}

interface ProposalDispatch {
  opportunityRef?: string;
  editionRef?: string;
  idempotencyKey: string;
}

function parseProposalIntent(input: unknown): ProposalDispatch {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new MarketStoreError("intent_invalid", "Dispatch intent must be an object.");
  }
  const row = input as Record<string, unknown>;
  if (row.schema !== "dsh.radar.intent.v1") {
    throw new MarketStoreError("intent_invalid", "Dispatch only accepts dsh.radar.intent.v1 intents.");
  }
  if (row.kind !== "proposal") {
    throw new MarketStoreError("intent_unsupported", "Host seam dispatch only accepts proposal intents.");
  }
  const refs = row.opportunityRefs;
  if (!Array.isArray(refs) || refs.length > 1 || refs.some((ref) => typeof ref !== "string" || !SAFE_SEGMENT.test(ref))) {
    throw new MarketStoreError("intent_invalid", "Proposal intent accepts zero or one safe opportunity ref.");
  }
  if (row.editionRef !== undefined && (typeof row.editionRef !== "string" || !SAFE_SEGMENT.test(row.editionRef))) {
    throw new MarketStoreError("intent_invalid", "editionRef must be a safe ref.");
  }
  if (typeof row.idempotencyKey !== "string" || !SAFE_SEGMENT.test(row.idempotencyKey)) {
    throw new MarketStoreError("intent_invalid", "idempotencyKey must be a safe ref.");
  }
  if (typeof row.confirmed !== "boolean") {
    throw new MarketStoreError("intent_invalid", "confirmed must be a boolean.");
  }
  if (UNSAFE_BLOB.test(JSON.stringify(input))) {
    throw new MarketStoreError("intent_unsafe", "Dispatch intent carries unsafe content.");
  }
  return {
    ...(refs.length === 1 ? { opportunityRef: refs[0] as string } : {}),
    ...(row.editionRef !== undefined ? { editionRef: row.editionRef as string } : {}),
    idempotencyKey: row.idempotencyKey,
  };
}

export interface MarketHostReceipt {
  schema: typeof MARKET_HOST_RECEIPT_SPEC;
  idempotencyKey: string;
  outcome: "submitted" | "rejected" | "reconciled";
  reason: string;
  assignmentRef?: string;
}

/** Typed proposal -> owner-local assignment create; replay returns the original receipt. */
export function dispatchProposal(db: RadarDb, profiles: ProfileService, intent: unknown): MarketHostReceipt {
  const parsed = parseProposalIntent(intent);
  const profile = profiles.show();
  const { assignment } = createAssignment(db, { profile, ...parsed });
  const receipt: MarketHostReceipt = assignment.status === "do_not_shoot"
    ? {
        schema: MARKET_HOST_RECEIPT_SPEC, idempotencyKey: parsed.idempotencyKey, outcome: "rejected",
        reason: `assignment ${assignment.assignment_ref} is do_not_shoot`, assignmentRef: assignment.assignment_ref,
      }
    : {
        schema: MARKET_HOST_RECEIPT_SPEC, idempotencyKey: parsed.idempotencyKey, outcome: "submitted",
        reason: `assignment ${assignment.assignment_ref} created for Auctra ingress`, assignmentRef: assignment.assignment_ref,
      };
  return receipt;
}

/** Receipt reconcile by the ORIGINAL key only; never dispatches again. */
export function lookupAssignmentReceipt(db: RadarDb, key: string): MarketHostReceipt | null {
  if (typeof key !== "string" || !SAFE_SEGMENT.test(key)) {
    throw new MarketStoreError("intent_invalid", "Receipt key must be a safe ref.");
  }
  const row = db.select().from(radarAssignments).where(eq(radarAssignments.idempotencyKey, key)).get();
  if (!row) return null;
  return {
    schema: MARKET_HOST_RECEIPT_SPEC, idempotencyKey: key, outcome: "reconciled",
    reason: `assignment ${row.payload.assignment_ref} reconciled by original key`, assignmentRef: row.payload.assignment_ref,
  };
}

/**
 * Frame loop. Strictly sequential: one response line per request, in arrival
 * order; malformed lines answer frame_invalid and never stop the loop.
 */
export async function marketHostServe(db: RadarDb, io: MarketHostIo): Promise<{ processed: number }> {
  const profiles = new ProfileService(db);
  const write = (frame: Record<string, unknown>) => io.output.write(JSON.stringify(frame) + "\n");
  const note = (message: string) => io.diagnostics?.write(`[market-host] ${message}\n`);
  let processed = 0;
  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  for await (const line of lines) {
    const raw = line?.trim();
    if (!raw) continue;
    let id: string | number | null = null;
    processed++;
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new MarketStoreError("frame_invalid", "Frame line is not valid JSON.");
      }
      if (parsed === null || typeof parsed !== "object" || parsed.schema !== MARKET_HOST_FRAME_SPEC) {
        throw new MarketStoreError("frame_invalid", `Frames must declare ${MARKET_HOST_FRAME_SPEC}.`);
      }
      if (typeof parsed.id === "number" || typeof parsed.id === "string") id = parsed.id;
      if (parsed.op === "read") {
        if (typeof parsed.uri !== "string") throw new MarketStoreError("frame_invalid", "Read frame requires a uri string.");
        const payload = await readResource(db, parsed.uri);
        write({ schema: MARKET_HOST_FRAME_SPEC, id, ok: true, resource: { uri: parsed.uri, text: JSON.stringify(payload) } });
      } else if (parsed.op === "dispatch") {
        write({ schema: MARKET_HOST_FRAME_SPEC, id, ok: true, receipt: dispatchProposal(db, profiles, parsed.intent) });
      } else if (parsed.op === "lookup-receipt") {
        if (typeof parsed.idempotencyKey !== "string") throw new MarketStoreError("frame_invalid", "lookup-receipt requires idempotencyKey.");
        write({ schema: MARKET_HOST_FRAME_SPEC, id, ok: true, receipt: lookupAssignmentReceipt(db, parsed.idempotencyKey) });
      } else if (parsed.op === "shutdown") {
        write({ schema: MARKET_HOST_FRAME_SPEC, id, ok: true, stopped: true });
        return { processed };
      } else {
        throw new MarketStoreError("frame_invalid", "Unknown frame op; expected read, dispatch, lookup-receipt or shutdown.");
      }
    } catch (error) {
      const code = error instanceof MarketStoreError || error instanceof ProfileError ? error.code : "host_frame_failed";
      const message = error instanceof Error ? error.message : "Frame processing failed.";
      note(`frame ${String(id)} failed: ${code}`);
      write({ schema: MARKET_HOST_FRAME_SPEC, id, ok: false, error: { code, message } });
    }
  }
  return { processed };
}
