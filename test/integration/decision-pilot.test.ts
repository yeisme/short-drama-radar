import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type RadarDb } from "../../src/db/client.ts";
import { decisionPacks, decisionExperiments, decisionResults, marketSettings, marketEvidence, marketSignals } from "../../src/db/schema.ts";
import { ProfileService } from "../../src/profile/service.ts";
import { marketDigest } from "../../src/market/repository.ts";
import { validateEnvelope } from "../../src/output/envelope.ts";
import { addDecisionCandidate, addDecisionEvidence, createDecision, listDecisions, lockDecisionExperiment, readDecision,
  readDecisionExperiment, readDecisionResult, recordDecisionResult, resumeDecision, reviewDecision, setDecisionBaseline } from "../../src/decision/service.ts";
import type { DecisionCandidate, DecisionPack, ExperimentPlan, ResultInput } from "../../src/decision/domain.ts";

const opened: ReturnType<typeof openDb>[] = [], homes: string[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.$client.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const at = (minute = 0) => new Date(Date.UTC(2026, 8, 16, 8, minute));
function dbAt(path = ":memory:") { const db = openDb(path); opened.push(db); return db; }
function home() { const value = mkdtempSync(join(tmpdir(), "radar-decision-")); homes.push(value); return value; }
const meta = (pack: DecisionPack, key: string) => ({ pack_ref: pack.ref, revision: pack.revision, key });
const plan: ExperimentPlan = { kind: "hypothesis", sample_per_arm: 32, min_lift_pp: 15,
  max_completion_drop_pp: 10, max_failure_percent: 10, budget_note: "Test budget only", recruitment_note: "Test cohort only", protocol_note: "Same test protocol" };
const candidate = (ref: string): DecisionCandidate => ({ ref, name: ref, market: "US", locale: "en", audience: "Adult animation viewers",
  hypothesis: "A testable original hypothesis", rationale: "Related supply evidence", risk: "Demand unknown", falsifier: "No continuation gain",
  cost_note: "Quote unavailable", evidence_refs: ["source"] });
function draft(db: RadarDb, independent = false) {
  let p = createDecision(db, { title: "Test decision", objective: "Select a testable direction", topics: ["fantasy"], key: "create" }, at()).pack;
  p = addDecisionEvidence(db, meta(p, "evidence"), { ref: "source", kind: "background", note: "Synthetic source, not market data",
    url: "https://example.com/reference", observed_at: at().toISOString() }, at()).pack;
  p = setDecisionBaseline(db, meta(p, "baseline"), { status: independent ? "independent" : "missing", note: "Test baseline declaration",
    evidence_ref: independent ? "source" : null }, at()).pack;
  for (const ref of ["treatment", "control"]) p = addDecisionCandidate(db, meta(p, ref), candidate(ref), at()).pack;
  return p;
}
function lock(db: RadarDb, p: DecisionPack, key: string, minute = 1, override: Partial<ExperimentPlan> = {}) {
  return lockDecisionExperiment(db, meta(p, key), { candidate_ref: "treatment", control_ref: "control", plan: { ...plan, ...override } }, at(minute)).experiment;
}
function outcome(start = 2, overrides: Partial<ResultInput> = {}): ResultInput {
  // Synthetic aggregate fixtures exercising manual-ingress rules, never a
  // claim that a real audience was recruited or observed.
  return { origin: "manual", measurement: "observed", quality: "comparable", source_ref: "synthetic-study",
    started_at: at(start).toISOString(), finished_at: at(start + 1).toISOString(), reason: null,
    treatment: { assigned: 32, continued: 12, completed: 24, technical_failures: 0 },
    control: { assigned: 32, continued: 16, completed: 24, technical_failures: 0 }, ...overrides };
}

test("history, replay and stale edits leave old revisions and unrelated rows intact", () => {
  const db = dbAt(); const p = draft(db);
  const first = readDecision(db, p.ref, 1);
  expect(first.candidates).toHaveLength(0);
  const replay = addDecisionCandidate(db, { pack_ref: p.ref, revision: p.revision - 1, key: "control" }, candidate("control"), at(1));
  expect(replay.reused).toBe(true);
  expect(replay.pack.digest).toBe(p.digest);
  expect(() => addDecisionCandidate(db, meta(first, "stale"), candidate("other"), at(1))).toThrow("revision changed");
  expect(() => addDecisionCandidate(db, { pack_ref: p.ref, revision: p.revision - 1, key: "control" }, { ...candidate("control"), risk: "Different" }, at())).toThrow("different input");
  expect(db.select().from(decisionPacks).all()).toHaveLength(5);
  expect(readDecision(db, p.ref, 1)).toEqual(first);
});

test("missing and late baselines cannot become independent method controls", () => {
  const db = dbAt(); const p = draft(db);
  expect(() => lock(db, p, "method", 1, { kind: "method" })).toThrow("independent baseline");
  expect(() => setDecisionBaseline(db, meta(p, "replace-baseline"), { status: "independent", note: "Late", evidence_ref: "source" }, at())).toThrow("already recorded");
  expect(db.select().from(decisionExperiments).all()).toHaveLength(0);
  const db2 = dbAt(); let q = createDecision(db2, { title: "Late baseline", objective: "Test", topics: ["fantasy"], key: "late" }, at()).pack;
  q = addDecisionEvidence(db2, meta(q, "ev"), { ref: "source", kind: "background", note: "Synthetic", url: "https://example.com/", observed_at: at().toISOString() }, at()).pack;
  q = addDecisionCandidate(db2, meta(q, "cand"), candidate("treatment"), at()).pack;
  expect(() => setDecisionBaseline(db2, meta(q, "late-baseline"), { status: "independent", note: "After candidates", evidence_ref: "source" }, at())).toThrow("before adding candidates");
});

test("method experiment requires a control citing the independent baseline", () => {
  const db = dbAt(); const p = draft(db, true);
  const experiment = lock(db, p, "method", 1, { kind: "method" });
  expect(experiment.plan.kind).toBe("method");
  expect(experiment.registration_scope).toBe("local");
  expect(experiment.pack.baseline?.verification).toBe("operator_attestation");
});

test("experiment snapshots survive later pack edits; results cannot predate the lock", () => {
  const db = dbAt(); const p = draft(db); const experiment = lock(db, p, "round-1");
  const changed = addDecisionCandidate(db, meta(p, "new-candidate"), candidate("next"), at(2)).pack;
  expect(changed.candidates).toHaveLength(3);
  expect(readDecisionExperiment(db, experiment.ref).pack.candidates).toHaveLength(2);
  expect(readDecisionExperiment(db, experiment.ref).digest).toBe(experiment.digest);
  expect(() => recordDecisionResult(db, { experiment_ref: experiment.ref, revision: 0, key: "backdate" }, outcome(0), at(3))).toThrow("after the lock");
  expect(() => recordDecisionResult(db, { experiment_ref: experiment.ref, revision: 0, key: "future" }, outcome(4), at(3))).toThrow("record time");
  expect(() => lock(db, changed, "pending", 3)).toThrow("previous experiment outcome");
  expect(db.select().from(decisionResults).all()).toHaveLength(0);
});

test("results replay, append corrections and retain exact historical versions", () => {
  const db = dbAt(); const p = draft(db); const experiment = lock(db, p, "round-1");
  const input = outcome(); const m = { experiment_ref: experiment.ref, revision: 0, key: "result-1" };
  const first = recordDecisionResult(db, m, input, at(4));
  expect(recordDecisionResult(db, m, input, at(5)).reused).toBe(true);
  expect(() => recordDecisionResult(db, m, { ...input, quality: "not_comparable" }, at(5))).toThrow("different input");
  expect(() => recordDecisionResult(db, { ...m, revision: 1, key: "no-reason" }, input, at(5))).toThrow("require a reason");
  const correction = { ...input, reason: "Correct a transcription error", treatment: { ...input.treatment, continued: 22 } };
  recordDecisionResult(db, { ...m, revision: 1, key: "correction" }, correction, at(5));
  expect(readDecisionResult(db, experiment.ref, 1)).toEqual(first.result);
  expect(reviewDecision(db, p.ref).rounds[0]).toMatchObject({ verdict: "directional_support", result_revision: 2 });
  expect(() => recordDecisionResult(db, { ...m, revision: 2, key: "launder" }, { ...correction, origin: "fixture" }, at(6))).toThrow("original origin");
  expect(db.select().from(decisionResults).all()).toHaveLength(2);
});

test("two failed comparable rounds pause new locks until an explicit review", () => {
  const db = dbAt(); let p = draft(db);
  const one = lock(db, p, "round-1", 1);
  recordDecisionResult(db, { experiment_ref: one.ref, revision: 0, key: "r1" }, outcome(2), at(4));
  const two = lock(db, p, "round-2", 5);
  recordDecisionResult(db, { experiment_ref: two.ref, revision: 0, key: "r2" }, outcome(6), at(8));
  expect(reviewDecision(db, p.ref).pause_required).toBe(true);
  expect(() => lock(db, p, "blocked", 9)).toThrow("require review");
  p = resumeDecision(db, meta(p, "review"), "Review source coverage before another bounded test", at(9)).pack;
  expect(reviewDecision(db, p.ref).pause_required).toBe(false);
  expect(lock(db, p, "round-3", 10).sequence).toBe(3);
  expect(readDecision(db, p.ref, p.revision - 1).resume_after_sequence).toBe(0);
});

test("fixture rounds never count as audience success or trigger a pause", () => {
  const db = dbAt(); const p = draft(db);
  for (let i = 0; i < 2; i++) {
    const exp = lock(db, p, `fixture-${i}`, 1 + i * 4);
    recordDecisionResult(db, { experiment_ref: exp.ref, revision: 0, key: `r-${i}` }, outcome(2 + i * 4, { origin: "fixture" }), at(4 + i * 4));
  }
  const report = reviewDecision(db, p.ref);
  expect(report.pause_required).toBe(false);
  expect(report.rounds.map(r => r.verdict)).toEqual(["inconclusive", "inconclusive"]);
});

test("a fixture rehearsal cannot erase a real failure streak", () => {
  const db = dbAt(); const p = draft(db);
  for (let i = 0; i < 3; i++) {
    const exp = lock(db, p, `mixed-${i}`, 1 + i * 4);
    recordDecisionResult(db, { experiment_ref: exp.ref, revision: 0, key: `mixed-result-${i}` },
      outcome(2 + i * 4, { origin: i === 1 ? "fixture" : "manual" }), at(4 + i * 4));
  }
  expect(reviewDecision(db, p.ref).pause_required).toBe(true);
});

test("different protocols do not create a combined two-round failure", () => {
  const db = dbAt(); const p = draft(db);
  const one = lock(db, p, "one", 1);
  recordDecisionResult(db, { experiment_ref: one.ref, revision: 0, key: "r1" }, outcome(2), at(4));
  const two = lock(db, p, "two", 5, { min_lift_pp: 20 });
  recordDecisionResult(db, { experiment_ref: two.ref, revision: 0, key: "r2" }, outcome(6), at(8));
  expect(reviewDecision(db, p.ref).pause_required).toBe(false);
});

test("cross-market controls are refused and two incomparable manual rounds pause", () => {
  const db = dbAt(); let p = draft(db);
  p = addDecisionCandidate(db, meta(p, "other-market"), { ...candidate("other-market"), market: "CN" }, at()).pack;
  expect(() => lockDecisionExperiment(db, meta(p, "mixed"), { candidate_ref: "treatment", control_ref: "other-market", plan }, at(1))).toThrow("same explicit market");
  for (let i = 0; i < 2; i++) {
    const exp = lock(db, p, `intent-${i}`, 1 + i * 4);
    recordDecisionResult(db, { experiment_ref: exp.ref, revision: 0, key: `result-${i}` }, outcome(2 + i * 4, { measurement: "intent" }), at(4 + i * 4));
  }
  expect(reviewDecision(db, p.ref)).toMatchObject({ pause_required: true });
});

test("profile switching and changed policy block reads, replay and result writes", () => {
  const db = dbAt(); const profiles = new ProfileService(db);
  const owner = profiles.create("owner"); const p = draft(db); const exp = lock(db, p, "one");
  const other = profiles.create("other"); profiles.activate(other.ref);
  expect(listDecisions(db).packs).toHaveLength(0);
  expect(() => readDecision(db, p.ref)).toThrow("active profile");
  expect(() => readDecisionExperiment(db, exp.ref)).toThrow("active profile");
  profiles.activate(owner.ref);
  profiles.set(owner.ref, { blocked_topics: ["fantasy"] });
  expect(listDecisions(db).packs).toHaveLength(0);
  expect(() => readDecision(db, p.ref, 1)).toThrow("blocked");
  expect(() => lock(db, p, "one")).toThrow("blocked");
  expect(() => recordDecisionResult(db, { experiment_ref: exp.ref, revision: 0, key: "r" }, outcome(), at(4))).toThrow("blocked");
  expect(db.select().from(decisionResults).all()).toHaveLength(0);
});

test("local research packs remain accessible after creating a first profile, subject to its policy", () => {
  const db = dbAt(); const p = draft(db);
  const profiles = new ProfileService(db); const owner = profiles.create("first");
  expect(readDecision(db, p.ref).profile_ref).toBeNull();
  expect(listDecisions(db).packs.map(p => p.ref)).toContain(p.ref);
  profiles.set(owner.ref, { blocked_topics: ["fantasy"] });
  expect(listDecisions(db).packs).toHaveLength(0);
});

test("market evidence must belong to a readable signal and cannot become demand", () => {
  const db = dbAt(); let p = createDecision(db, { title: "Evidence", objective: "Test", topics: ["fantasy"], key: "create" }, at()).pack;
  db.insert(marketEvidence).values({ ref: "market-ev", sourceRef: "hongguo", observedAt: at().toISOString(),
    payload: { title: "Synthetic catalog", public_url: "https://example.com/", source_item_id: "work", origin: "fixture" } }).run();
  const signal = { spec: "radar.market_signal.v1" as const, signal_ref: "signal", revision: 1, claim_kind: "newly_observed" as const,
    assertion_level: "observed" as const, lifecycle: "active" as const, subject_ref: "work", source_ref: "hongguo", market: "CN",
    title: "Synthetic", topics: ["fantasy"], observed_at: at().toISOString(), observation_refs: [], evidence_refs: ["market-ev"],
    comparison: null, limitations: [], analysis_version: "test", mapping_version: "test", origin: "fixture" as const };
  db.insert(marketSignals).values({ ref: "signal", revision: 1, sourceRef: "hongguo", observedAt: at().toISOString(), fingerprint: marketDigest(signal), payload: signal }).run();
  const input = { ref: "attached", kind: "supply" as const, note: "Synthetic evidence binding", observed_at: at().toISOString(), signal_ref: "signal", signal_revision: 1, market_evidence_ref: "market-ev" };
  expect(() => addDecisionEvidence(db, meta(p, "missing"), { ...input, market_evidence_ref: "another" }, at())).toThrow("not attached");
  expect(() => addDecisionEvidence(db, meta(p, "demand"), { ...input, kind: "demand" }, at())).toThrow("cannot establish audience demand");
  p = addDecisionEvidence(db, meta(p, "attach"), input, at()).pack;
  expect(p.evidence[0]).toMatchObject({ source: "market_signal", source_origin: "fixture" });
  expect(p.evidence[0]!.source_digest).toStartWith("sha256:");
  expect(() => setDecisionBaseline(db, meta(p, "baseline"), { status: "independent", note: "Invalid fixture baseline", evidence_ref: "attached" }, at())).toThrow("fixture evidence");
});

test("additive migration preserves old rows and a second connection rejects stale edits", () => {
  const path = join(home(), "radar.db"); const old = new Database(path);
  old.exec("CREATE TABLE market_settings (ref TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL)");
  old.query("INSERT INTO market_settings VALUES (?, ?, ?)").run("local", 3, JSON.stringify({ timezone: "UTC", blocked_topics: [] })); old.close();
  const db1 = dbAt(path), db2 = dbAt(path);
  expect(db2.select().from(marketSettings).where(eq(marketSettings.ref, "local")).get()?.revision).toBe(3);
  const p = draft(db1);
  addDecisionCandidate(db1, meta(p, "first-writer"), candidate("extra"), at(1));
  expect(() => addDecisionCandidate(db2, meta(p, "second-writer"), candidate("conflicting"), at(1))).toThrow("revision changed");
  expect(readDecision(db2, p.ref).candidates).toHaveLength(3);
});

test("real CLI persists a draft and exposes safe standard output modes", () => {
  const root = home(), cli = join(import.meta.dir, "../../src/cli.ts");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { env: { ...process.env,
    RADAR_HOME: root, RADAR_DB_PATH: join(root, "radar.db"), RADAR_CONFIG_PATH: join(root, "absent.json") } });
  const created = run(["decision", "create", "--title", "CLI draft", "--objective", "Local comparison", "--topic", "fantasy", "--key", "cli-create", "--json"]);
  expect(created.exitCode).toBe(0);
  const envelope = JSON.parse(created.stdout.toString()); expect(validateEnvelope(envelope).ok).toBe(true);
  const pack = envelope.data.pack;
  const invoke = (words: string[], values: Record<string, string>) => {
    const output = run(["decision", ...words, ...Object.entries(values).flatMap(([key, value]) => ["--" + key, value]), "--json"]);
    const response = JSON.parse(output.stdout.toString());
    expect(output.exitCode).toBe(0);
    expect(validateEnvelope(response).ok).toBe(true);
    return response.data;
  };
  let revision = pack.revision;
  const metadata = (key: string) => ({ pack: pack.ref, revision: String(revision), key });
  revision = invoke(["evidence", "add"], { ...metadata("cli-evidence"), evidence: "source", kind: "supply", note: "Synthetic public reference",
    "observed-at": "2026-01-01T00:00:00Z", url: "https://example.com/reference" }).pack.revision;
  revision = invoke(["baseline", "set"], { ...metadata("cli-baseline"), status: "missing", note: "No independent baseline" }).pack.revision;
  for (const name of ["treatment", "control"]) {
    revision = invoke(["candidate", "add"], { ...metadata("cli-" + name), candidate: name, name, market: "US", locale: "en",
      audience: "Adult animation viewers", hypothesis: "Synthetic hypothesis", rationale: "Synthetic comparison", risk: "Demand unknown",
      falsifier: "No observed gain", "cost-note": "No paid actions", evidence: "source" }).pack.revision;
  }
  const experiment = invoke(["experiment", "lock"], { ...metadata("cli-lock"), candidate: "treatment", control: "control", kind: "hypothesis",
    "budget-note": "Fixture only", "recruitment-note": "No participants", "protocol-note": "Offline CLI exercise" }).experiment;
  const recorded = invoke(["result", "record"], { experiment: experiment.ref, revision: "0", key: "cli-result", origin: "fixture",
    measurement: "observed", quality: "comparable", "source-ref": "synthetic-cli-run", "started-at": experiment.locked_at,
    "finished-at": experiment.locked_at, "treatment-assigned": "32", "treatment-continued": "22", "treatment-completed": "24",
    "treatment-failures": "0", "control-assigned": "32", "control-continued": "16", "control-completed": "24", "control-failures": "0" });
  expect(recorded.result.verification).toBe("operator_reported");
  expect(invoke(["report"], { pack: pack.ref }).rounds[0].verdict).toBe("inconclusive");
  for (const mode of ["--json", "--agent", "--explain", "--events"]) {
    const output = run(["decision", "show", "--pack", pack.ref, mode]); expect(output.exitCode).toBe(0);
    const text = output.stdout.toString();
    if (mode === "--json") expect(validateEnvelope(JSON.parse(text)).ok).toBe(true);
    if (mode === "--agent") expect(text).toContain("mode=agent");
    if (mode === "--explain") expect(text).toContain("Conclusion");
    if (mode === "--events") expect(text.trim().split("\n").map(l => JSON.parse(l).event)).toEqual(["start", "end"]);
  }
  const errors = [
    ["decision", "help", "--pack", "unsafe;value"],
    ["decision", "show", "extra", "--pack", pack.ref],
    ["decision", "show", "--pack", pack.ref, "--pack", pack.ref],
    ["decision", "create", "--title", "bad", "--objective", "Authorization: Bearer synthetic-private-value", "--topic", "fantasy", "--key", "bad"],
  ];
  for (const args of errors) {
    const output = run([...args, "--json"]); expect(output.exitCode).not.toBe(0);
    expect(validateEnvelope(JSON.parse(output.stdout.toString())).ok).toBe(true);
    expect(output.stdout.toString() + output.stderr.toString()).not.toContain("synthetic-private-value");
  }
  const stream = run(["decision", "show", "--pack", "missing", "--events"]);
  expect(stream.exitCode).not.toBe(0);
  expect(stream.stdout.toString().trim().split("\n").map(l => JSON.parse(l).event)).toEqual(["start", "error"]);
  expect(run(["decision", "help"]).stdout.toString()).toContain("result record");
}, 30000);
