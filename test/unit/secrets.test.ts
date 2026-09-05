import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSecretStore } from "../../src/adapters/secrets.ts";
import { probeLayer2 } from "../../src/diagnostics.ts";
import { loadConfig } from "../../src/config.ts";

describe("secret store bridge (Layer 2 unlock)", () => {
  function store(): string {
    const root = mkdtempSync(join(tmpdir(), "radar-secrets-"));
    return root;
  }

  test("credential resolves a storageState object; absent refs are null, not guesses", () => {
    const root = store();
    writeFileSync(join(root, "xhs-01.json"), JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
    const s = openSecretStore(root);
    expect(s.credential("xhs-01")).toEqual({ storageState: { cookies: [], origins: [] } });
    expect(s.credential("missing")).toBeNull();
  });

  test("proxy resolves {server,username,password}; contents never need to leave the store", () => {
    const root = store();
    writeFileSync(join(root, "proxy-a.json"), JSON.stringify({ server: "http://127.0.0.1:8000", username: "u", password: "p" }), { mode: 0o600 });
    const s = openSecretStore(root);
    expect(s.proxy("proxy-a")).toEqual({ server: "http://127.0.0.1:8000", username: "u", password: "p" });
    expect(s.proxy("nope")).toBeNull();
  });

  test("loose permissions are rejected by name only", () => {
    const root = store();
    writeFileSync(join(root, "loose.json"), JSON.stringify({ cookies: [] }));
    chmodSync(join(root, "loose.json"), 0o644);
    const s = openSecretStore(root);
    expect(() => s.credential("loose")).toThrow(/chmod 600/);
  });

  test("invalid shapes are rejected without echoing contents", () => {
    const root = store();
    writeFileSync(join(root, "bad-cred.json"), JSON.stringify({ not: "storageState" }), { mode: 0o600 });
    writeFileSync(join(root, "bad-proxy.json"), JSON.stringify({ server: "not-a-url" }), { mode: 0o600 });
    const s = openSecretStore(root);
    expect(() => s.credential("bad-cred")).toThrow(/storageState/);
    expect(() => s.proxy("bad-proxy")).toThrow(/server/);
  });
});

describe("probeLayer2 readiness (Layer 2 unlock)", () => {
  test("every missing prerequisite produces a named reason; ready only when all present", async () => {
    const home = mkdtempSync(join(tmpdir(), "radar-l2-"));
    process.env.RADAR_HOME = home;
    process.env.RADAR_ACCOUNTS_PATH = join(home, "none.json");
    process.env.RADAR_SECRETS_DIR = join(home, "secrets");
    const cfg = loadConfig();
    const empty = await probeLayer2(cfg);
    expect(empty.ok).toBe(false);
    expect(empty.reasons.some((r) => r.includes("account pool"))).toBe(true);

    // Full provisioning except the chromium executable (never downloaded in
    // test environments): the reason must name it, not fake readiness.
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "accounts.json"), JSON.stringify({
      version: 1,
      accounts: [{ id: "xhs-01", platform: "xiaohongshu", handleMasked: "x***1", credentialRef: "xhs-01", status: "active", dailyUsed: 0 }],
    }));
    writeFileSync(join(home, "secrets", "xhs-01.json"), JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
    const almost = await probeLayer2(cfg);
    expect(almost.ok).toBe(false);
    expect(almost.reasons.some((r) => r.includes("chromium executable not installed"))).toBe(true);
    // No credential reason remains: the descriptor + secret file are complete.
    expect(almost.reasons.some((r) => r.includes("credential"))).toBe(false);
  });
});
