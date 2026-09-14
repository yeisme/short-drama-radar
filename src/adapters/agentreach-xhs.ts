import { emptyResult, type Adapter, type AdapterContext, type FetchResult, type RawItem } from "./types.ts";

// Layer 1 (xiaohongshu): agent-reach routed platform backend.
// Supported CLI backends (picked by `agent-reach doctor --json`):
//   A. OpenCLI (desktop, reuses Chrome login state)
//   B. xhs-cli (legacy CLI fallback)
// Login material lives inside the backend's own user-level config; this
// adapter never sees or stores credentials. Missing backend or missing login
// state degrades loudly with the exact next command — never fabricates data.

export type XhsBackend = "opencli" | "xhs-cli";

export interface BackendProbe {
  backend: XhsBackend | null;
  hint: string; // exact next command when the channel is not usable yet
}

export interface ProbeDeps {
  runJson?: (cmd: string[]) => { stdout: string; exitCode: number } | Promise<{ stdout: string; exitCode: number }>;
}


// Probe agent-reach for the currently active xiaohongshu backend. doctor is
// the routing source of truth; we do not guess a backend by PATH sniffing.
export async function probeXhsBackend(agentReachBin: string, deps: ProbeDeps = {}): Promise<BackendProbe> {
  const runJson = deps.runJson ?? ((cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }));
  try {
    const res = await runJson([agentReachBin, "doctor", "--json"]);
    if (res.exitCode !== 0) {
      return { backend: null, hint: `agent-reach doctor exited ${res.exitCode}; install agent-reach first.` };
    }
    const doctor = JSON.parse(res.stdout.toString()) as Record<string, unknown>;
    const channel = doctor["xiaohongshu"] as { status?: string; active_backend?: string | null; message?: string } | undefined;
    if (!channel || channel.status !== "ok" || !channel.active_backend) {
      const first = (channel?.message ?? "xiaohongshu backend not provisioned.").split("\n").map((l) => l.trim()).filter(Boolean);
      const install = first.find((l) => l.includes("agent-reach install")) ?? "agent-reach install --channels opencli";
      return { backend: null, hint: install };
    }
    const map: Record<string, XhsBackend> = {
      "OpenCLI": "opencli",
      "xhs-cli (xiaohongshu-cli)": "xhs-cli",
    };
    const backend = map[channel.active_backend] ?? null;
    return backend
      ? { backend, hint: "" }
      : { backend: null, hint: `unknown active_backend '${channel.active_backend}'; supported: OpenCLI, xhs-cli.` };
  } catch (err) {
    return { backend: null, hint: `agent-reach doctor failed: ${(err as Error).message}` };
  }
}

export interface FetchDeps {
  probe?: (agentReachBin: string) => Promise<BackendProbe>;
  readiness?: (backend: XhsBackend, timeoutMs: number) => Promise<BackendReadiness>;
  run?: (cmd: string[]) => Promise<{ stdout: string; exitCode: number }>;
  now?: () => Date;
}

export interface BackendReadiness {
  ready: boolean;
  detail: string;
  hint?: string;
}

// Adapter factory; keyword defaults to the radar's standing discovery query.
export function makeXhsBackendAdapter(keyword = "短剧"): Adapter {
  return {
    name: "agent-reach-xhs",
    layer: 1,
    platform: "xiaohongshu",
    async fetch(ctx: AdapterContext, deps: FetchDeps = {}): Promise<FetchResult> {
      // Tests inject a recorded backend payload instead of a live call; the
      // probe is skipped so fixture runs stay offline.
      if (ctx.fixtureDir) {
        const path = `${ctx.fixtureDir}/xiaohongshu-layer1.json`;
        const file = Bun.file(path);
        if (await file.exists()) {
          return normalizeResult(JSON.parse(await file.text()));
        }
        return emptyResult("agent-reach-xhs", 1, [`fixture ${path} not found`]);
      }

      const probe = deps.probe ?? ((bin: string) => probeXhsBackend(bin));
      const run = deps.run ?? defaultRun;
      const { backend, hint } = await probe(ctx.agentReachBin);
      if (!backend) {
        return emptyResult("agent-reach-xhs", 1, [`xiaohongshu backend not ready — next command: ${hint}`]);
      }

      const readiness = deps.readiness ?? probeXhsReadiness;
      const state = await readiness(backend, ctx.timeoutMs);
      if (!state.ready) {
        const next = state.hint ? ` — next command: ${state.hint}` : "";
        return emptyResult("agent-reach-xhs", 1, [`xiaohongshu backend not ready — ${state.detail}${next}`]);
      }

      try {
        const raw = await run(backendCommand(backend, keyword, ctx.timeoutMs));
        if (raw.exitCode !== 0) return emptyResult("agent-reach-xhs", 1, [`backend '${backend}' exited ${raw.exitCode} (login state missing or expired?)`]);
        const parsed = JSON.parse(raw.stdout.toString()) as unknown;
        return normalizeResult(parsed);
      } catch (err) {
        return emptyResult("agent-reach-xhs", 1, [`backend call failed: ${(err as Error).message}`]);
      }
    },
  };
}

async function defaultRun(cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? -1 };
}

export async function probeXhsReadiness(
  backend: XhsBackend,
  timeoutMs: number,
  run: (cmd: string[]) => Promise<{ stdout: string; exitCode: number }> = defaultRun,
): Promise<BackendReadiness> {
  return { ready: true, detail: `active backend: ${backend}` };
}

export function backendCommand(backend: XhsBackend, keyword: string, timeoutMs: number): string[] {
  switch (backend) {
    case "opencli":
      return ["opencli", "xiaohongshu", "search", keyword, "-f", "json"];
    case "xhs-cli":
      return ["xhs", "search", keyword, "--json"];
  }
}

// Tolerant normalizer: accept array or {items|data|notes|feeds:[...]} shapes
// across backends; unknown shapes yield zero items (degraded), never guesses.
export function normalizeXhsItems(payload: unknown): RawItem[] {
  const list = extractList(payload);
  const items: RawItem[] = [];
  for (const row of list) {
    if (typeof row !== "object" || row === null) continue;
    const o = row as Record<string, unknown>;
    // OpenCLI and xhs-cli may return nested camelCase or flattened fields.
    const card = (o["noteCard"] ?? o["note_card"] ?? {}) as Record<string, unknown>;
    const contentId = str(o["note_id"] ?? o["id"] ?? o["feed_id"] ?? card["noteId"] ?? card["note_id"]);
    const title = str(o["display_title"] ?? o["title"] ?? o["note_title"] ?? card["displayTitle"] ?? card["title"]);
    const url = str(o["xsec_url"] ?? o["url"] ?? o["note_url"] ?? card["xsecUrl"] ?? (contentId ? `https://www.xiaohongshu.com/explore/${contentId}` : ""));
    if (!contentId || !title) continue; // rows without stable id or title are not radar evidence
    const user = (o["user"] ?? o["author"] ?? card["user"] ?? {}) as Record<string, unknown>;
    const interaction = (o["interactInfo"] ?? o["interact_info"] ?? card["interactInfo"] ?? {}) as Record<string, unknown>;
    const metric = (key: string, ...values: unknown[]) => values.map(str).map(parseMetric).find((v): v is number => v !== null) ?? null;
    const metrics = {
      ...(metric("liked_count", o["liked_count"], o["likes"], interaction["likedCount"]) !== null ? { liked_count: metric("liked_count", o["liked_count"], o["likes"], interaction["likedCount"])! } : {}),
      ...(metric("collected_count", o["collected_count"], o["collect_count"], interaction["collectedCount"]) !== null ? { collected_count: metric("collected_count", o["collected_count"], o["collect_count"], interaction["collectedCount"])! } : {}),
      ...(metric("comment_count", o["comment_count"], o["comments"], interaction["commentCount"]) !== null ? { comment_count: metric("comment_count", o["comment_count"], o["comments"], interaction["commentCount"])! } : {}),
    };
    items.push({
      platform: "xiaohongshu",
      contentId,
      title: title.slice(0, 200),
      url,
      authorId: str(user["user_id"] ?? user["id"]),
      authorName: str(user["nickname"] ?? user["name"]),
      publishedAt: isoDate(str(o["time"] ?? o["publish_time"] ?? o["create_time"] ?? card["time"])),
      metrics,
      // Structured backend rows carry stable IDs and real engagement counts,
      // unlike Layer 0 public pages (confidence 40).
      confidence: 75,
    });
    if (items.length >= 30) break;
  }
  return items;
}

function normalizeResult(payload: unknown): FetchResult {
  const items = normalizeXhsItems(payload);
  const errors = items.length === 0 ? ["backend payload parsed but no usable notes (login expired or payload shape changed?)"] : [];
  return { source: "agent-reach-xhs", layer: 1, items, degraded: items.length === 0, errors };
}

function extractList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "object" && payload !== null) {
    for (const key of ["items", "data", "notes", "feeds", "result"]) {
      const v = (payload as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
      if (typeof v === "object" && v !== null) {
        const nested = extractList(v);
        if (nested.length > 0) return nested;
      }
    }
  }
  return [];
}

function collectText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return payload.map(collectText).join("\n");
  if (typeof payload === "object" && payload !== null) {
    return Object.values(payload as Record<string, unknown>).map(collectText).join("\n");
  }
  return "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

// XHS times arrive either as ISO strings or epoch milliseconds; normalize to
// ISO so downstream date handling sees one shape (douyin already emits ISO).
function isoDate(raw: string): string {
  if (!raw) return "";
  if (/^\d{12,}$/.test(raw)) {
    const ms = Number(raw);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
  }
  return raw;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseMetric(v: string): number | null {
  if (!v) return null;
  const m = v.replaceAll(",", "").match(/^(\d+(?:\.\d+)?)(万|亿)?/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n * (m[2] === "万" ? 10_000 : m[2] === "亿" ? 100_000_000 : 1) : null;
}
