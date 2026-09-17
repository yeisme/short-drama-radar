import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tasks 1.11-1.21 integration replay: every unadapted target answers
// `radar market source qualify --source <ref>` with its concrete blocked
// receipt, an owner blocked review freezes the decision through the CLI, and
// the gap matrix keeps all blocked sources visible without counting them as
// verified coverage.

const TARGETS: { ref: string; gap: string }[] = [
  { ref: "hongguo-animation", gap: "must not imply AI production" },
  { ref: "huolong", gap: "not collection receipts" },
  { ref: "kuaishou", gap: "risk control" },
  { ref: "xifan", gap: "store introduction is not work-level observation" },
  { ref: "netshort", gap: "must not be mapped to MX/BR audience markets" },
  { ref: "melolo", gap: "store availability is not audience heat" },
  { ref: "dramawave", gap: "extraction failed" },
  { ref: "pinedrama", gap: "never counts as independent corroboration" },
  { ref: "kukutv", gap: "not trend data" },
  { ref: "quicktv", gap: "denominators stay separate from other sources" },
  { ref: "bilibili", gap: "must not masquerade as consumption rankings" },
];

test("every unadapted target returns a concrete blocked receipt through the CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "radar-source-targets-"));
  const invoke = (...args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args, "--json"], {
      cwd: process.cwd(),
      env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_CONFIG_PATH: join(home, "config.json") },
    });
    return { exit: proc.exitCode, body: JSON.parse(proc.stdout.toString()) };
  };
  try {
    expect(invoke("market", "init").exit).toBe(0);
    for (const target of TARGETS) {
      const qualify = invoke("market", "source", "qualify", "--source", target.ref);
      expect(qualify.exit).toBe(0);
      expect(qualify.body.status).toBe("success");
      const report = qualify.body.data;
      expect(report.source_ref).toBe(target.ref);
      expect(report.qualified).toBe(false);
      expect(report.configured_readiness).toBe("planned");
      expect(report.reasons).toContain("identity_evidence_missing");
      // The receipt names the dated per-source gap instead of a placeholder.
      expect(report.limitations.some((line: string) => line.includes(target.gap))).toBe(true);
      expect(report.limitations.some((line: string) => line.includes("2026-09-11"))).toBe(true);
    }
    // Owner blocked review through the CLI freezes one representative
    // decision; replay returns the same receipt.
    const reviewArgs = ["market", "source", "review", "--source", "hongguo-animation",
      "--revision", "1", "--stage", "blocked", "--key", "blocked-cli-review",
      "--reason", "App-only animation entry; no public web work catalog to sample."];
    expect(invoke(...reviewArgs).body.data.receipt.source.readiness).toBe("blocked");
    expect(invoke(...reviewArgs).body.data.reused).toBe(true);
    const after = invoke("market", "source", "qualify", "--source", "hongguo-animation");
    expect(after.body.data.configured_readiness).toBe("blocked");
    expect(after.body.data.reasons).toContain("source_blocked");
    // Blocked sources stay in the ledger and never count as verified markets.
    const gaps = invoke("market", "source", "gaps");
    const blocked = gaps.body.data.sources.filter((source: { source_ref: string }) => source.source_ref === "hongguo-animation");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].configured_readiness).toBe("blocked");
    for (const market of gaps.body.data.markets) {
      expect(market.verified_sources).toEqual([]);
      expect(market.status).toBe("coverage_unverified");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
