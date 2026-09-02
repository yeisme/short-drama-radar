import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Layer 2 account pool: descriptors only. Cookie values and proxy passwords
// live in the user-level secret store / agent-reach config and are referenced
// opaquely (credentialRef / proxyRef) — never stored, logged or committed.

export type AccountPlatform = "douyin" | "xiaohongshu";
export type AccountStatus = "active" | "cooldown" | "disabled";

export interface PoolAccount {
  id: string; // e.g. "xhs-01"
  platform: AccountPlatform;
  handleMasked: string; // masked handle, e.g. "x***1" — never the full handle
  credentialRef: string; // opaque ref into the user secret store
  proxyRef?: string; // opaque ref; account↔proxy pairing is fixed once set
  status: AccountStatus;
  cooldownUntil?: string; // ISO timestamp; risk-control trip = +24h
  cooldownReason?: string;
  dailyUsed: number;
  dailyQuotaDate?: string; // YYYY-MM-DD bucket for dailyUsed
  lastUsedAt?: string;
}

export interface AccountPoolFile {
  version: 1;
  accounts: PoolAccount[];
}

export interface RotationResult {
  account: PoolAccount | null;
  reason?: string; // why no account was selected (all cooled down, none configured, ...)
}

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

export class AccountPool {
  private file: AccountPoolFile;

  constructor(
    private readonly path: string,
    initial?: AccountPoolFile,
  ) {
    this.file = initial ?? loadPool(path);
  }

  list(): PoolAccount[] {
    return this.file.accounts;
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file, null, 2));
  }

  // Cooldowns that expired become active again lazily on every lookup.
  refreshCooldowns(now = new Date()): number {
    let restored = 0;
    for (const a of this.file.accounts) {
      if (a.status === "cooldown" && a.cooldownUntil && new Date(a.cooldownUntil) <= now) {
        a.status = "active";
        delete a.cooldownUntil;
        delete a.cooldownReason;
        restored++;
      }
    }
    return restored;
  }

  // Pick the least-recently-used active account for the platform, honoring
  // the per-account daily quota. Rotation is deterministic for replay.
  rotate(platform: AccountPlatform, dailyQuota: number, now = new Date()): RotationResult {
    this.refreshCooldowns(now);
    const today = now.toISOString().slice(0, 10);
    const candidates = this.file.accounts
      .filter((a) => a.platform === platform && a.status === "active")
      .map((a) => resetDailyBucket(a, today))
      .sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "") || a.id.localeCompare(b.id));
    if (candidates.length === 0) {
      const any = this.file.accounts.some((a) => a.platform === platform);
      return {
        account: null,
        reason: any
          ? `all ${platform} accounts are in cooldown/disabled; earliest recovery ${earliestRecovery(this.file.accounts, platform)}`
          : `no ${platform} accounts configured; add descriptors to ${this.path}`,
      };
    }
    const usable = candidates.find((a) => a.dailyUsed < dailyQuota);
    if (!usable) {
      return { account: null, reason: `daily quota exhausted for all ${platform} accounts (${dailyQuota}/day)` };
    }
    usable.lastUsedAt = now.toISOString();
    usable.dailyUsed += 1;
    return { account: usable };
  }

  // Risk control / captcha trip: 24h cooldown, never auto-bypassed.
  trip(accountId: string, reason: string, now = new Date()): PoolAccount | null {
    const account = this.file.accounts.find((a) => a.id === accountId);
    if (!account) return null;
    account.status = "cooldown";
    account.cooldownUntil = new Date(now.getTime() + COOLDOWN_MS).toISOString();
    account.cooldownReason = reason;
    return account;
  }

  markUsed(accountId: string, now = new Date()): void {
    const account = this.file.accounts.find((a) => a.id === accountId);
    if (account) account.lastUsedAt = now.toISOString();
  }
}

function loadPool(path: string): AccountPoolFile {
  if (!existsSync(path)) return { version: 1, accounts: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as AccountPoolFile;
    if (raw.version !== 1 || !Array.isArray(raw.accounts)) throw new Error("bad shape");
    return raw;
  } catch {
    // A corrupt pool file must not crash collection; treat as empty pool.
    return { version: 1, accounts: [] };
  }
}

function resetDailyBucket(account: PoolAccount, today: string): PoolAccount {
  if (account.dailyQuotaDate !== today) {
    account.dailyQuotaDate = today;
    account.dailyUsed = 0;
  }
  return account;
}

function earliestRecovery(accounts: PoolAccount[], platform: AccountPlatform): string {
  const times = accounts
    .filter((a) => a.platform === platform && a.status === "cooldown" && a.cooldownUntil)
    .map((a) => a.cooldownUntil!)
    .sort();
  if (times[0]) return times[0];
  const disabled = accounts.some((a) => a.platform === platform && a.status === "disabled");
  return disabled ? "never (disabled accounts need manual review)" : "unknown";
}
