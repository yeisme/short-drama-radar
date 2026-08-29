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
  accountPool: {
    xiaohongshu: number;
    douyin: number;
    dailyQuotaPerAccount: number;
  };
  schedule: {
    collect1: string; // "08:10"
    collect2: string; // "08:30"
    score: string; // "08:42"
    freeze: string; // "08:55"
    send: string; // "08:59"
  };
}

const HOME = process.env.HOME ?? "~";
export const RADAR_HOME = process.env.RADAR_HOME ?? join(HOME, ".short-drama-radar");

export const defaultConfig: RadarConfig = {
  dbPath: process.env.RADAR_DB_PATH ?? join(RADAR_HOME, "radar.db"),
  firecrawlBaseUrl: process.env.FIRECRAWL_BASE_URL ?? "http://10.10.1.101:32741",
  agentReachBin: process.env.AGENT_REACH_BIN ?? "agent-reach",
  accountPool: {
    xiaohongshu: 3,
    douyin: 3,
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

export function loadConfig(): RadarConfig {
  const path = process.env.RADAR_CONFIG_PATH ?? join(RADAR_HOME, "config.json");
  if (!existsSync(path)) return defaultConfig;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RadarConfig>;
  return { ...defaultConfig, ...raw, accountPool: { ...defaultConfig.accountPool, ...(raw.accountPool ?? {}) }, schedule: { ...defaultConfig.schedule, ...(raw.schedule ?? {}) } };
}

export function ensureRadarHome(): void {
  mkdirSync(RADAR_HOME, { recursive: true });
}
