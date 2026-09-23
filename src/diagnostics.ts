import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { probeXhsBackend, probeXhsReadiness } from "./adapters/agentreach-xhs.ts";
import { openSecretStore, SecretsError } from "./adapters/secrets.ts";
import { RADAR_HOME, type RadarConfig } from "./config.ts";
import { probeRunLock } from "./runlock.ts";

// Real backing probes for `radar doctor`. Unimplemented or unreachable capabilities are
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

  checks["schedule"] = probeSchedule(RADAR_HOME);

  // DB always present (opened before probing).
  checks["db"] = { status: "ok", detail: cfg.dbPath };

  return { checks };
}

// Wall-clock scheduling is customer-owned: Radar generates no units and
// probes no OS managers. This check only reports run-lock availability, so a
// customer-side timer knows overlapping triggers queue instead of racing.
export function probeSchedule(home: string): CheckResult {
  try {
    const probe = probeRunLock(home);
    if (probe.status === "ok") {
      return { status: "ok", detail: "run lock available; wall-clock scheduling is customer-owned (docs/runtime/schedule.md)" };
    }
    return { status: "degraded", detail: `run lock held by pid ${probe.holder.pid} (${probe.holder.command})` };
  } catch (err) {
    return { status: "blocked", detail: `run lock path unavailable: ${(err as Error).message}` };
  }
}

function checkDouyinCookie(): CheckResult {
  // Login material presence only, never values.
  return process.env["DOUYIN_COOKIE"]
    ? { status: "ok", detail: "login material present (user env)" }
    : { status: "blocked", detail: "DOUYIN_COOKIE not set — signed search returns login-required", nextCommand: "export DOUYIN_COOKIE=<from your user secret store>" };
}

async function checkPlaywright(): Promise<CheckResult> {
  // Module + chromium executable (no browser launch).
  const mod = "playwright";
  let chromium: { executablePath?: () => string } | undefined;
  try {
    chromium = ((await import(/* webpackIgnore: true */ mod)) as { chromium?: { executablePath?: () => string } }).chromium;
  } catch {
    return { status: "unavailable", detail: "playwright module not installed", nextCommand: "bun add playwright" };
  }
  const executable = chromium?.executablePath?.();
  if (!executable || !existsSync(executable)) {
    return { status: "degraded", detail: "playwright module importable but the chromium executable is not installed", nextCommand: "bunx playwright install chromium" };
  }
  return { status: "ok", detail: `playwright module + chromium (${executable})` };
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

// Local-only source status backing the CLI doctor.
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

// Layer 2 readiness: every prerequisite is checked explicitly and every gap
// produces a named reason. Contents of secret files are never read here —
// only their presence (and mode) for the accounts the pool would rotate to.
export interface Layer2Readiness {
  ok: boolean;
  reasons: string[];
  nextCommand?: string;
}

export async function probeLayer2(cfg: RadarConfig): Promise<Layer2Readiness> {
  const reasons: string[] = [];
  let executablePath: (() => string) | null = null;
  try {
    const mod = (await import(/* webpackIgnore: true */ "playwright")) as { chromium?: { executablePath?: () => string } };
    executablePath = mod.chromium?.executablePath ?? null;
    if (!executablePath) reasons.push("playwright module has no chromium export");
  } catch {
    reasons.push("playwright module not installed");
  }
  if (executablePath) {
    // executablePath() throws when no browser was ever downloaded; a missing
    // path means the same thing — either way chromium is not usable.
    let installed = false;
    try {
      installed = existsSync(executablePath());
    } catch {
      installed = false;
    }
    if (!installed) reasons.push("chromium executable not installed (run: bunx playwright install chromium)");
  }
  if (!existsSync(cfg.accountsPath)) {
    reasons.push(`no account pool descriptor at ${cfg.accountsPath}`);
  } else {
    let accounts: Array<{ platform?: string; status?: string; credentialRef?: string; proxyRef?: string }> = [];
    try {
      accounts = (JSON.parse(readFileSync(cfg.accountsPath, "utf8")) as { accounts?: typeof accounts }).accounts ?? [];
    } catch {
      reasons.push(`account pool descriptor is not valid JSON: ${cfg.accountsPath}`);
    }
    const active = accounts.filter((a) => a.status === "active");
    if (active.length === 0) reasons.push("no active accounts in pool descriptors");
    try {
      const store = openSecretStore();
      for (const account of active) {
        const ref = account.credentialRef;
        if (!ref || !existsSync(join(store.root, `${ref}.json`))) {
          reasons.push(`credential '${ref ?? "?"}' missing in ${store.root}`);
        }
        if (account.proxyRef && !existsSync(join(store.root, `${account.proxyRef}.json`))) {
          reasons.push(`proxy descriptor '${account.proxyRef}' missing in ${store.root}`);
        }
      }
    } catch (err) {
      if (err instanceof SecretsError) reasons.push(err.message);
      else reasons.push(`secret store unavailable: ${(err as Error).message}`);
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    nextCommand: reasons.length === 0 ? undefined : "radar doctor --json",
  };
}
