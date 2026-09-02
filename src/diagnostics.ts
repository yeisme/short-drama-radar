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

  // Layer 0: firecrawl reachability.
  try {
    const res = await fetchImpl(`${cfg.firecrawlBaseUrl}/v1/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }),
      signal: AbortSignal.timeout(2_000),
    });
    checks["firecrawl"] = res.ok ? { status: "ok", detail: `reachable (${res.status})` } : { status: "degraded", detail: `http ${res.status}`, nextCommand: "check the firecrawl service" };
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

  // Layer 1b: douyin signed API login material (presence only, never values).
  checks["douyin-cookie"] = process.env["DOUYIN_COOKIE"]
    ? { status: "ok", detail: "login material present (user env)" }
    : { status: "blocked", detail: "DOUYIN_COOKIE not set — signed search returns login-required", nextCommand: "export DOUYIN_COOKIE=<from your user secret store>" };

  // Layer 2: playwright module availability (probe by import, no browser launch).
  let playwright: CheckResult;
  const mod = "playwright";
  try {
    await import(/* webpackIgnore: true */ mod);
    playwright = { status: "ok", detail: "playwright module importable" };
  } catch {
    playwright = { status: "unavailable", detail: "playwright module not installed", nextCommand: "bun add playwright" };
  }
  checks["playwright"] = playwright;

  // Layer 2 accounts.
  const poolPath = cfg.accountsPath;
  const poolReady = (() => {
    if (!existsSync(poolPath)) return false;
    try {
      const raw = JSON.parse(readFileSync(poolPath, "utf8")) as { accounts?: { status?: string }[] };
      return (raw.accounts ?? []).some((a) => a.status === "active");
    } catch {
      return false;
    }
  })();
  checks["account-pool"] = poolReady
    ? { status: "ok", detail: `usable accounts in ${poolPath}` }
    : { status: "blocked", detail: "no active accounts in pool descriptors", nextCommand: `add account descriptors to ${poolPath} (credentials go to the secret store only)` };

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
