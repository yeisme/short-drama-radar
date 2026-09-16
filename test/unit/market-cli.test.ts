import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { marketCommand } from "../../src/market/cli.ts";
import { MarketStoreError } from "../../src/market/repository.ts";
import { marketReaderReceipts } from "../../src/db/schema.ts";

// Task 4.1: the market command group validates input, reports planned vs
// available honestly, and returns recoverable English errors. All state
// changes flow through the services; failed commands leave zero writes.

function flags(entries: Record<string, string[]> = {}): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

function run(db: ReturnType<typeof openDb>, command: string[], f: Record<string, string[]> = {}) {
  return marketCommand(command, flags(f), db);
}

test("init is idempotent and lists the seeded sources", async () => {
  const db = openDb(":memory:");
  try {
    const first = await run(db, ["market", "init"]);
    expect(first.status).toBe("success");
    expect((first.facts as Record<string, unknown>).external_collection).toBe(false);
    const second = await run(db, ["market", "init"]);
    expect(second.status).toBe("success");
    const listed = await run(db, ["market", "source", "list"]);
    const refs = (listed.data as { sources: Array<{ source_ref: string }> }).sources.map(s => s.source_ref);
    expect(refs).toContain("hongguo");
    expect(refs).toContain("reelshort");
    expect(new Set(refs).size).toBe(refs.length);
  } finally { db.$client.close(); }
});

test("missing values, unknown flags and unknown commands give recoverable English errors", async () => {
  const db = openDb(":memory:");
  try {
    await run(db, ["market", "init"]);
    const expects = (promise: Promise<unknown>, code: string, message: string) =>
      promise.then(() => { throw new Error("expected " + code); }, (error: MarketStoreError) => {
        expect(error.code).toBe(code);
        expect(error.message).toContain(message);
      });
    // Missing flag value.
    await expects(run(db, ["market", "source", "show"], { source: [] }), "value_required", "--source");
    await expects(run(db, ["market", "source", "show"]), "value_required", "--source");
    // Unsupported flag.
    await expects(run(db, ["market", "source", "list"], { verbose: ["true"] }), "flag_invalid", "Unsupported market command flag");
    // Unknown command lists the supported surface.
    await expects(run(db, ["market", "nope"]), "command_unknown", "Supported market commands");
    // Invalid ref formats are refused by the services, not the shell.
    await expects(run(db, ["market", "source", "show"], { source: ["not a ref!"] }), "source_not_found", "not registered");
    await expects(run(db, ["market", "signal", "show"], { signal: ["does-not-exist"] }), "signal_not_found", "does not exist");
    await expects(run(db, ["market", "brief", "show"], { brief: ["latest"] }), "brief_not_found", "No completed market brief");
  } finally { db.$client.close(); }
});

test("planned capabilities are disclosed honestly and never fake success", async () => {
  const db = openDb(":memory:");
  try {
    await run(db, ["market", "init"]);
    const planned: Array<[string[], Record<string, string[]>, string]> = [
      [["market", "canary", "report"], { days: ["14"] }, "not started"],
    ];
    for (const [command, f, hint] of planned) {
      await marketCommand(command, flags(f), db).then(() => { throw new Error("expected capability_unavailable"); },
        (error: MarketStoreError) => {
          expect(error.code).toBe("capability_unavailable");
          expect(error.message).toContain(hint);
          expect(error.message).toContain("observation quality");
        });
    }
  } finally { db.$client.close(); }
});

test("normal paths work end-to-end through the services with zero residue on failure", async () => {
  const db = openDb(":memory:");
  try {
    await run(db, ["market", "init"]);
    // Default-window analyze and brief build on an empty store are honest.
    const analysis = await run(db, ["market", "analyze"]);
    expect(analysis.status).toBe("success");
    const brief = await run(db, ["market", "brief", "build"], { start: ["2026-09-12T00:00:00Z"], end: ["2026-09-13T00:00:00Z"] });
    expect((brief.data as { status: string }).status).toBe("empty");
    const shown = await run(db, ["market", "brief", "show"]);
    expect((shown.data as { status: string }).status).toBe("empty");
    // A failed reader mutation (wrong policy revision) writes no receipt.
    await run(db, ["market", "reader", "mark"], { signal: ["signal-x"], "signal-revision": ["1"],
      revision: ["1"], "policy-revision": ["bogus"], key: ["k1"] })
      .catch((error: MarketStoreError) => expect(error.code).toBe("state_conflict"));
    expect(db.select().from(marketReaderReceipts).all()).toEqual([]);
    // Config show/set round-trip with revision discipline.
    const config = await run(db, ["market", "config", "show"]);
    expect((config.data as { revision: number }).revision).toBe(1);
    await expectsError(run(db, ["market", "config", "set"], { revision: ["1"], timezone: ["Mars/Olympus"] }), "config_invalid", "IANA");
    const updated = await run(db, ["market", "config", "set"], { revision: ["1"], timezone: ["Asia/Shanghai"] });
    expect((updated.data as { timezone: string }).timezone).toBe("Asia/Shanghai");
  } finally { db.$client.close(); }
});

async function expectsError(promise: Promise<unknown>, code: string, message: string) {
  await promise.then(() => { throw new Error("expected " + code); }, (error: MarketStoreError) => {
    expect(error.code).toBe(code);
    expect(error.message).toContain(message);
  });
}

// radar market sync (tasks 3.1): flag validation and named errors happen
// before any PG connection is opened, so they are unit-testable offline.
describe("market sync flag validation", () => {
  const noPgEnv = () => {
    const saved = { url: process.env.RADAR_PG_URL, cfg: process.env.RADAR_CONFIG_PATH };
    delete process.env.RADAR_PG_URL;
    process.env.RADAR_CONFIG_PATH = "/nonexistent/radar-config.json";
    return () => {
      if (saved.url !== undefined) process.env.RADAR_PG_URL = saved.url;
      if (saved.cfg !== undefined) process.env.RADAR_CONFIG_PATH = saved.cfg;
      else delete process.env.RADAR_CONFIG_PATH;
    };
  };

  test("unknown flags, missing --to and unsupported targets fail with named codes", async () => {
    const db = openDb(":memory:");
    const restore = noPgEnv();
    try {
      await expectsError(run(db, ["market", "sync"], { to: ["pg"], verbose: ["true"] }), "flag_invalid", "Unsupported market command flag");
      await expectsError(run(db, ["market", "sync"], { to: [] }), "value_required", "--to");
      await expectsError(run(db, ["market", "sync"], {}), "value_required", "--to");
      await expectsError(run(db, ["market", "sync"], { to: ["s3"] }), "sync_target_unsupported", "supported targets: pg");
      await expectsError(run(db, ["market", "sync"], { to: ["pg"], verify: ["yes"] }), "flag_invalid", "--verify without a value");
      await expectsError(run(db, ["market", "sync"], { to: ["pg"], "reset-cursor": ["true"] }), "flag_invalid", "--confirm-reset");
      await expectsError(run(db, ["market", "sync"], { to: ["pg"], "chunk-size": ["0"] }), "flag_invalid", "--chunk-size");
    } finally { restore(); db.$client.close(); }
  });

  test("without RADAR_PG_URL or config the command reports pg_config_missing with recovery hints", async () => {
    const db = openDb(":memory:");
    const restore = noPgEnv();
    try {
      await run(db, ["market", "init"]);
      await expectsError(run(db, ["market", "sync"], { to: ["pg"] }), "pg_config_missing", "RADAR_PG_URL");
      await expectsError(run(db, ["market", "sync"], { to: ["pg"] }), "pg_config_missing", "pgArchive.url");
    } finally { restore(); db.$client.close(); }
  });

  test("an unreachable target surfaces pg_unavailable, never a raw driver error", async () => {
    const db = openDb(":memory:");
    const saved = process.env.RADAR_PG_URL;
    process.env.RADAR_PG_URL = "postgres://u:p@127.0.0.1:1/radar";
    try {
      await run(db, ["market", "sync"], { to: ["pg"] }).then(
        () => { throw new Error("expected pg_unavailable"); },
        (error: MarketStoreError) => {
          expect(error.code).toBe("pg_unavailable");
          expect(error.message).not.toContain("postgres://");
          expect(error.message).not.toContain("u:p@");
        },
      );
    } finally {
      if (saved !== undefined) process.env.RADAR_PG_URL = saved; else delete process.env.RADAR_PG_URL;
      db.$client.close();
    }
  });
});
