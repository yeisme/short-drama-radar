import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { probeXhsBackend, probeXhsReadiness } from "./adapters/agentreach-xhs.ts";
import type { RadarConfig } from "./config.ts";
import { SCHEDULE_NEXT_STEPS } from "./schedule.ts";

// Real backing probes for `radar doctor` / `radar mcp doctor` /
// `radar mcp capabilities`. Unimplemented or unreachable capabilities are
// reported blocked/unavailable with the exact next command — never "ready".

export interface CheckResult {
  status: "ok" | "degraded" | "blocked" | "unavailable";
  detail: string;
  nextCommand?: string;
}

export interface RuntimeProbe {
  checks: Record<string, CheckResult>;
}

export async function probeRuntime(cfg: RadarConfig, opts: { fetchImpl?: typeof fetch } = {}): Promise<RuntimeProbe> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const checks: Record<string, CheckResult> = {};

  // Layer 0: firecrawl reachability. GET liveness only — a scrape POST would
  // burn real scrape quota on every doctor run.
  try {
    const res = await fetchImpl(cfg.firecrawlBaseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    // Any HTTP response proves the service is up (even 404); only transport
    // errors degrade the check.
    checks["firecrawl"] = { status: "ok", detail: `reachable (${res.status})` };
  } catch (err) {
    checks["firecrawl"] = { status: "degraded", detail: `unreachable: ${(err as Error).message}`, nextCommand: `FIRECRAWL_BASE_URL=${cfg.firecrawlBaseUrl} # verify the service` };
  }

  // Layer 1a: agent-reach xiaohongshu backend.
  const xhs = await probeXhsBackend(cfg.agentReachBin);
  if (!xhs.backend) {
    checks["xhs-backend"] = { status: "blocked", detail: "no xiaohongshu backend provisioned", nextCommand: xhs.hint };
  } else {
    const readiness = await probeXhsReadiness(xhs.backend, 15_000);
    checks["xhs-backend"] = readiness.ready
      ? { status: "ok", detail: readiness.detail }
      : { status: "blocked", detail: readiness.detail, nextCommand: readiness.hint };
  }

  // Local checks shared with `radar://sources/status` (see localSourceStatus).
  checks["douyin-cookie"] = checkDouyinCookie();
  checks["playwright"] = await checkPlaywright();
  checks["account-pool"] = checkAccountPool(cfg.accountsPath);

  // Scheduler wiring.
  const timerPath = join(process.env.HOME ?? "~", ".config/systemd/user/short-drama-radar-collect.timer");
  if (!existsSync(timerPath)) {
    checks["schedule"] = { status: "unavailable", detail: "systemd timer not installed", nextCommand: "radar schedule install" };
  } else {
    const timers = ["short-drama-radar-collect.timer", "short-drama-radar-score.timer", "short-drama-radar-card.timer"];
    const systemd = Bun.spawnSync(["systemctl", "--user", "is-enabled", ...timers], { stdout: "pipe", stderr: "pipe" });
    checks["schedule"] = systemd.exitCode === 0
      ? { status: "ok", detail: "systemd user timers installed and enabled" }
      : {
          status: "blocked",
          detail: "timer units exist but the systemd user manager is unavailable or timers are disabled",
          nextCommand: SCHEDULE_NEXT_STEPS[1],
        };
  }

  // DB always present (opened before probing).
  checks["db"] = { status: "ok", detail: cfg.dbPath };

  return { checks };
}

function checkDouyinCookie(): CheckResult {
  // Login material presence only, never values.
  return process.env["DOUYIN_COOKIE"]
    ? { status: "ok", detail: "login material present (user env)" }
    : { status: "blocked", detail: "DOUYIN_COOKIE not set — signed search returns login-required", nextCommand: "export DOUYIN_COOKIE=<from your user secret store>" };
}

async function checkPlaywright(): Promise<CheckResult> {
  // Module availability only (probe by import, no browser launch).
  const mod = "playwright";
  try {
    await import(/* webpackIgnore: true */ mod);
    return { status: "ok", detail: "playwright module importable" };
  } catch {
    return { status: "unavailable", detail: "playwright module not installed", nextCommand: "bun add playwright" };
  }
}

function checkAccountPool(poolPath: string): CheckResult {
  let poolReady = false;
  if (existsSync(poolPath)) {
    try {
      const raw = JSON.parse(readFileSync(poolPath, "utf8")) as { accounts?: { status?: string }[] };
      poolReady = (raw.accounts ?? []).some((a) => a.status === "active");
    } catch {
      poolReady = false;
    }
  }
  return poolReady
    ? { status: "ok", detail: `usable accounts in ${poolPath}` }
    : { status: "blocked", detail: "no active accounts in pool descriptors", nextCommand: `add account descriptors to ${poolPath} (credentials go to the secret store only)` };
}

// Local-only source status backing the MCP resource `radar://sources/status`.
// Never touches the network or platform backends — live probing is CLI-only
// (`radar doctor`); MCP resources report local state plus the latest
// persisted collection receipt instead.
export interface LocalSourceStatus {
  checks: Record<string, CheckResult>;
  note: string;
}

export async function localSourceStatus(
  cfg: RadarConfig,
  lastCollection: { runId: string; finishedAt: string; status: string; degradedLayers: string[] } | null,
): Promise<LocalSourceStatus> {
  const checks: Record<string, CheckResult> = {
    "douyin-cookie": checkDouyinCookie(),
    playwright: await checkPlaywright(),
    "account-pool": checkAccountPool(cfg.accountsPath),
    db: { status: "ok", detail: cfg.dbPath },
  };
  checks["last-collection"] = lastCollection
    ? {
        status: lastCollection.status === "ok" ? "ok" : "degraded",
        detail:
          `run ${lastCollection.runId} finished ${lastCollection.finishedAt}` +
          (lastCollection.degradedLayers.length ? ` — degraded layers: ${lastCollection.degradedLayers.join(", ")}` : ""),
      }
    : { status: "unavailable", detail: "no collection run recorded yet", nextCommand: "radar collect" };
  return {
    checks,
    note: "local state only; live probes (firecrawl reachability, xiaohongshu backend/login) are CLI-only via `radar doctor`",
  };
}
