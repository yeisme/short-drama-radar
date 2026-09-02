#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, RADAR_HOME } from "../config.ts";
import { openDb } from "../db/client.ts";
import { ProfileService } from "../profile/service.ts";
import { runs } from "../db/schema.ts";
import { desc } from "drizzle-orm";
import { appendAudit, argsDigest, maskPrincipal } from "./audit.ts";
import {
  EXECUTE_ACTIONS,
  laneAllows,
  searchAction,
  type AppDeps,
  type Lane,
} from "../app/actions.ts";
import { latestEdition, editionByRef } from "../pipeline/edition.ts";
import { opportunityByRef } from "../pipeline/opportunity.ts";
import { rankOpportunities } from "../pipeline/ranker.ts";
import { probeRuntime } from "../diagnostics.ts";

// radar mcp --transport stdio --lane reader|curator|operator
// stdout carries only JSON-RPC frames; diagnostics go to stderr. Lane
// permissions are cumulative (operator > curator > reader); profile mutations
// are permanently absent from the tool surface.

export async function runMcpServer(lane: Lane = "reader"): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const deps: AppDeps = { cfg, db, profiles: new ProfileService(db) };
  const principal = maskPrincipal("stdio-host");

  const server = new Server(
    { name: "short-drama-radar", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: `Short-drama radar MCP surface. Lane '${lane}' is fixed for this connection. Profile mutations are CLI-only by design; suggest 'radar profile set ...' instead. collect/daily_run touch external platforms — confirm before executing.`,
    },
  );

  const audit = (tool: string, action: string, args: unknown, outcome: "success" | "denied" | "error", refs: { run?: string; edition?: string } = {}) => {
    // Audit-before-return: the ledger row lands before the caller sees anything.
    appendAudit(RADAR_HOME, {
      principal_ref: principal,
      lane,
      tool,
      action,
      args_digest: argsDigest(args),
      outcome,
      run_ref: refs.run,
      edition_ref: refs.edition,
    });
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allowed = Object.entries(EXECUTE_ACTIONS).filter(([name]) => laneAllows(lane, name));
    const sideEffects = allowed.filter(([, def]) => def.sideEffect === "external").map(([name]) => name);
    return {
      tools: [
        {
          name: "radar.search",
          description: "Read-only search over opportunities/items/editions for the active (or given) profile.",
          inputSchema: {
            type: "object" as const,
            properties: {
              view: { type: "string", enum: ["opportunities", "items", "editions"], description: "projection to search" },
              query: { type: "string", description: "substring filter (topic/hook/title)" },
              date: { type: "string", description: "YYYY-MM-DD (default today)" },
              platform: { type: "string", enum: ["douyin", "xiaohongshu"] },
              profile_ref: { type: "string", description: "default: active profile" },
              min_market_score: { type: "number" },
              min_personal_fit: { type: "number" },
              limit: { type: "number", description: "default 20, max 100" },
            },
            required: ["view"],
          },
        },
        {
          name: "radar.execute",
          description: `Execute a lane-gated action. Allowed for lane '${lane}': ${allowed.map(([n]) => n).join(", ") || "none"}.${sideEffects.length > 0 ? ` External side effects: ${sideEffects.join(", ")} — host must confirm.` : ""} Profile mutations are never available over MCP.`,
          inputSchema: {
            type: "object" as const,
            properties: {
              action: { type: "string", enum: allowed.map(([n]) => n) },
              input: { type: "object", description: "action payload (date/opportunity_ref/kind/...)" },
            },
            required: ["action"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = request.params.name;
    const args = request.params.arguments ?? {};

    if (tool === "radar.search") {
      try {
        const result = searchAction(deps, {
          view: ((args["view"] as string) ?? "opportunities") as "opportunities" | "items" | "editions",
          query: args["query"] as string | undefined,
          date: args["date"] as string | undefined,
          platform: args["platform"] as string | undefined,
          profileRef: args["profile_ref"] as string | undefined,
          minMarketScore: args["min_market_score"] as number | undefined,
          minPersonalFit: args["min_personal_fit"] as number | undefined,
          limit: args["limit"] as number | undefined,
        });
        audit(tool, "search", args, "success");
        return {
          content: [{ type: "text", text: JSON.stringify(result.data ?? {}, null, 2) }],
          structuredContent: { status: result.status, summary: result.summary, facts: result.facts ?? {} },
          isError: false,
        };
      } catch (err) {
        audit(tool, "search", args, "error");
        return { content: [{ type: "text", text: `search failed: ${(err as Error).message}` }], isError: true };
      }
    }

    if (tool === "radar.execute") {
      const action = String(args["action"] ?? "");
      const input = (args["input"] ?? {}) as Record<string, unknown>;
      // Unknown action and lane-denied action share one rejection shape.
      if (!EXECUTE_ACTIONS[action] || !laneAllows(lane, action)) {
        audit(tool, action || "unknown", args, "denied");
        return {
          content: [{ type: "text", text: `action '${action}' is not allowed for lane '${lane}' (unknown actions are rejected identically)` }],
          isError: true,
        };
      }
      try {
        // MCP arguments follow snake_case; actions speak camelCase.
        const result = await EXECUTE_ACTIONS[action]!.run(deps, camelizeKeys(input));
        const outcome: "success" | "denied" = result.status === "failed" ? "denied" : "success";
        audit(tool, action, args, outcome, { run: (result as { runId?: string }).runId, edition: (result as { editionRef?: string }).editionRef ?? extractEditionRef(result) });
        return {
          content: [{ type: "text", text: JSON.stringify({ status: result.status, summary: result.summary, facts: result.facts ?? {}, error: result.error }, null, 2) }],
          isError: result.status === "failed",
        };
      } catch (err) {
        audit(tool, action, args, "error");
        return { content: [{ type: "text", text: `execute failed: ${(err as Error).message}` }], isError: true };
      }
    }

    audit(tool, "unknown", args, "denied");
    return { content: [{ type: "text", text: `unknown tool '${tool}'` }], isError: true };
  });

  const staticResources = [
    "radar://profile/active",
    "radar://editions/latest",
    "radar://runs",
    "radar://sources/status",
    "radar://capabilities",
  ];

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: staticResources.map((uri) => ({
      uri,
      name: uri.replace("radar://", "").replace(/\//g, "_"),
      mimeType: "application/json",
    })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: "radar://editions/{ref}", name: "edition_by_ref", mimeType: "application/json" },
      { uriTemplate: "radar://opportunities/{ref}", name: "opportunity_by_ref", mimeType: "application/json" },
      { uriTemplate: "radar://evidence/{ref}", name: "evidence_by_ref", mimeType: "application/json" },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const text = await readResource(deps, uri);
    return { contents: [{ uri, mimeType: "application/json", text }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "radar_personal_brief",
        description: "Read capabilities → source status → latest completed edition, then produce the personal brief. Read-only; no mutations.",
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== "radar_personal_brief") throw new Error(`unknown prompt '${request.params.name}'`);
    return {
      description: "Personal short-drama morning brief from the latest completed edition",
      messages: [
        { role: "user", content: { type: "text", text: "Read radar://capabilities and radar://sources/status first. Then read radar://editions/latest. Produce: (1) top opportunities with personal-fit reasons and evidence confidence, (2) risks (degraded/low-confidence), (3) recommended next CLI command (e.g. feedback, profile set, edition build). If the edition is stale, empty or absent, state the real reason and the exact radar command to run — never trigger collection yourself." } },
      ],
    };
  });

  // Stdio has no client identity; the principal ref stays a stable masked
  // default (per radar.mcp.audit.v1: redacted principal only).
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[radar-mcp] stdio server running (lane=${lane})\n`);
}

function extractEditionRef(result: { data?: unknown }): string | undefined {
  const data = result.data as { editionRef?: string } | undefined;
  return data?.editionRef;
}

function camelizeKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const camel = k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    out[camel] = v;
  }
  return out;
}

async function readResource(deps: AppDeps, uri: string): Promise<string> {
  if (uri === "radar://profile/active") {
    try {
      const profile = deps.profiles.show();
      // Safe summary: dimension counts and thresholds only, no raw dumps.
      return JSON.stringify({
        ref: profile.ref,
        name: profile.name,
        active: true,
        revision: profile.headRevision,
        digest: profile.digest,
        dimensions: {
          topics: profile.profile.topics.map((t) => t.tag),
          blocked_topics: profile.profile.blocked_topics,
          budget_band: profile.profile.budget_band,
          risk_tolerance: profile.profile.risk_tolerance,
          minimum_fit: profile.profile.minimum_fit,
          minimum_confidence: profile.profile.minimum_confidence,
        },
      }, null, 2);
    } catch {
      return JSON.stringify({ error: "profile_required", message: "no active profile; run 'radar profile create --name <name>'" }, null, 2);
    }
  }
  if (uri === "radar://editions/latest") {
    try {
      const profile = deps.profiles.show();
      const edition = latestEdition(deps.db, profile.ref);
      if (!edition) return JSON.stringify({ status: "absent", message: "no edition yet; run 'radar edition build' or 'radar run'" }, null, 2);
      return JSON.stringify(edition, null, 2);
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message }, null, 2);
    }
  }
  const editionMatch = uri.match(/^radar:\/\/editions\/(.+)$/);
  if (editionMatch) {
    const edition = editionByRef(deps.db, editionMatch[1]!);
    return edition ? JSON.stringify(edition, null, 2) : JSON.stringify({ error: "edition_not_found", ref: editionMatch[1] });
  }
  const oppMatch = uri.match(/^radar:\/\/opportunities\/(.+)$/);
  if (oppMatch) {
    const opp = opportunityByRef(deps.db, oppMatch[1]!);
    if (!opp) return JSON.stringify({ error: "opportunity_not_found", ref: oppMatch[1] });
    let personal: Record<string, unknown> = {};
    try {
      const profile = deps.profiles.show();
      const ranked = rankOpportunities(deps.db, profile.profile, profile.ref, [opp])[0];
      personal = ranked ? { personal_fit: ranked.personalFit, reason_codes: ranked.reasonCodes, adjustment: ranked.adjustment, blocked: ranked.blocked } : {};
    } catch {
      personal = { note: "no active profile; personal fit not computed" };
    }
    return JSON.stringify({
      ref: opp.ref,
      topic: opp.topic,
      hook_family: opp.hookFamily,
      market_score: opp.marketScore,
      evidence_confidence: opp.evidenceConfidence,
      degraded: opp.degraded,
      cross_platform: opp.crossPlatform,
      evidence_digest: opp.evidenceDigest,
      evidence_uri: `radar://evidence/${opp.ref}`,
      ...personal,
    }, null, 2);
  }
  const evidenceMatch = uri.match(/^radar:\/\/evidence\/(.+)$/);
  if (evidenceMatch) {
    const opp = opportunityByRef(deps.db, evidenceMatch[1]!);
    if (!opp) return JSON.stringify({ error: "evidence_not_found", ref: evidenceMatch[1] });
    // Redacted source summary: no authors, no raw payloads, no cookies.
    return JSON.stringify({
      ref: opp.ref,
      digest: opp.evidenceDigest,
      sources: opp.sourceRefs.map((s) => ({ platform: s.split(":")[0], content_id: s.split(":")[1] })),
      note: "member titles and platform metrics are available via radar.search view=items",
    }, null, 2);
  }
  if (uri === "radar://runs") {
    const rows = deps.db.select().from(runs).orderBy(desc(runs.finishedAt)).limit(20).all()
      .map((r) => ({ id: r.id, kind: r.kind, status: r.status, finished_at: r.finishedAt }));
    return JSON.stringify({ runs: rows, note: "collect/daily_run are never auto-replayed; reconcile by run receipt lookup" }, null, 2);
  }
  if (uri === "radar://sources/status") {
    const runtime = await probeRuntime(deps.cfg);
    return JSON.stringify(runtime.checks, null, 2);
  }
  if (uri === "radar://capabilities") {
    return JSON.stringify(capabilities(deps), null, 2);
  }
  return JSON.stringify({ error: "resource_not_found", uri });
}

export function capabilities(deps: AppDeps): Array<{ capability: string; status: "ready" | "planned" | "blocked" | "unavailable"; next_action?: string }> {
  void deps;
  return [
    { capability: "cli", status: "ready" },
    { capability: "collection_layers_0_1", status: "ready" },
    { capability: "layer2_browser_fallback", status: "blocked", next_action: "bun add playwright + add account descriptors (login state: user secret store)" },
    { capability: "personal_profile_feedback", status: "ready" },
    { capability: "opportunity_edition", status: "ready" },
    { capability: "mcp_stdio_lanes", status: "ready" },
    { capability: "hermes_local_canary", status: "planned", next_action: "14-day single-user canary before any public surface" },
    { capability: "remote_mcp_endpoint", status: "unavailable", next_action: "separate proposal required after canary" },
    { capability: "a2a", status: "unavailable", next_action: "not approved for V1" },
    { capability: "multi_user", status: "unavailable", next_action: "rejected for this product scope" },
  ];
}
