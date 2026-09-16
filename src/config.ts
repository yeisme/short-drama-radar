import { existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// User-level config and DB stay outside the repository by default.
// Credentials (cookies, proxy passwords) must never live here; only
// endpoints, paths, and non-secret policy values.
export interface RadarConfig {
  dbPath: string;
  firecrawlBaseUrl: string;
  // Layer 1 adapters shell out to agent-reach / platform CLIs.
  agentReachBin: string;
  accountsPath: string; // Layer 2 pool descriptors (no credentials inside)
  layer1: {
    xhsKeyword: string;
    douyinKeyword: string;
  };
  accountPool: {
    // Pool membership per platform comes from the account descriptors; the
    // only pool policy here is the per-account daily quota.
    dailyQuotaPerAccount: number;
  };
  schedule: {
    collect1: string; // "08:10"
    collect2: string; // "08:30"
    score: string; // "08:42"
    freeze: string; // "08:55"
    send: string; // "08:59"
  };
  // Optional PG archive target (radar market sync --to pg). The DSN is a
  // credential: it may live in this user-level file or in RADAR_PG_URL, but
  // never in the DB, logs, envelopes or evidence.
  pgArchive?: {
    url?: string;
  };
}

// A literal "~" would create a directory named ~ in cwd; prefer the OS tmp root as the lesser evil and let doctor flag it.
const HOME = process.env.HOME ?? "/tmp";
export const RADAR_HOME = process.env.RADAR_HOME ?? join(HOME, ".short-drama-radar");

export const defaultConfig: RadarConfig = {
  dbPath: process.env.RADAR_DB_PATH ?? join(RADAR_HOME, "radar.db"),
  firecrawlBaseUrl: process.env.FIRECRAWL_BASE_URL ?? "http://10.10.1.101:32741",
  agentReachBin: process.env.AGENT_REACH_BIN ?? "agent-reach",
  accountsPath: process.env.RADAR_ACCOUNTS_PATH ?? join(RADAR_HOME, "accounts.json"),
  layer1: {
    xhsKeyword: "短剧",
    douyinKeyword: "短剧",
  },
  accountPool: {
    dailyQuotaPerAccount: 200,
  },
  schedule: {
    collect1: "08:10",
    collect2: "08:30",
    score: "08:42",
    freeze: "08:55",
    send: "08:59",
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(): RadarConfig {
  const path = process.env.RADAR_CONFIG_PATH ?? join(RADAR_HOME, "config.json");
  if (!existsSync(path)) return defaultConfig;
  let raw: Partial<RadarConfig>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RadarConfig>;
  } catch (err) {
    throw new ConfigError(`config file is not valid JSON (${path}): ${(err as Error).message}`);
  }
  const merged: RadarConfig = {
    ...defaultConfig,
    ...raw,
    layer1: { ...defaultConfig.layer1, ...(raw.layer1 ?? {}) },
    accountPool: { ...defaultConfig.accountPool, ...(raw.accountPool ?? {}) },
    schedule: { ...defaultConfig.schedule, ...(raw.schedule ?? {}) },
  };
  // Minimal type validation: wrong-typed values used to surface much later
  // as cryptic crashes (e.g. schedule.collect1 breaking time.match()).
  for (const key of ["collect1", "collect2", "score", "freeze", "send"] as const) {
    if (!/^\d{1,2}:\d{2}$/.test(merged.schedule[key])) {
      throw new ConfigError(`config schedule.${key} must be HH:MM, got '${merged.schedule[key]}'`);
    }
  }
  for (const key of ["firecrawlBaseUrl", "agentReachBin", "dbPath", "accountsPath"] as const) {
    if (typeof merged[key] !== "string") throw new ConfigError(`config ${key} must be a string`);
  }
  if (merged.pgArchive !== undefined) {
    if (typeof merged.pgArchive !== "object" || merged.pgArchive === null || Array.isArray(merged.pgArchive)) {
      throw new ConfigError("config pgArchive must be an object");
    }
    if (merged.pgArchive.url !== undefined && typeof merged.pgArchive.url !== "string") {
      throw new ConfigError("config pgArchive.url must be a string");
    }
  }
  return merged;
}

export function ensureRadarHome(): void {
  mkdirSync(RADAR_HOME, { recursive: true });
}
