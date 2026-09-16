import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type RadarDb } from "../../src/db/client.ts";
import { marketSettings } from "../../src/db/schema.ts";
import { addDecisionCandidate, addDecisionEvidence, addDecisionSample, cancelDecisionExperiment, createDecision,
  decisionWorkPackage, lockDecisionExperiment, prepareDecision, readDecision, readDecisionCancellation,
  readDecisionExperiment, readDecisionResult, recordDecisionResult, reviewDecision, setDecisionBaseline } from "../../src/decision/service.ts";
import { exportDecisionPackage, hashSampleFile, type SampleInput } from "../../src/decision/materials.ts";
import type { DecisionPack, ExperimentPlan, ResultInput } from "../../src/decision/domain.ts";

const databases: ReturnType<typeof openDb>[] = [], homes: string[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.$client.close()); homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })); });
const at = (n = 0) => new Date(Date.UTC(2026, 8, 16, 8, n));
const meta = (p: DecisionPack, key: string) => ({ pack_ref: p.ref, revision: p.revision, key });
const plan: ExperimentPlan = { kind: "hypothesis", sample_per_arm: 32, min_lift_pp: 15, max_completion_drop_pp: 10,
  max_failure_percent: 10, budget_note: "Unpriced fixture", recruitment_note: "Synthetic cohort", protocol_note: "Separate randomized viewers" };
const materials = { sample_refs: ["a1", "a2", "b1", "b2"], allocation: "randomized" as const,
  recruitment_channel: "synthetic-panel", quality_standard: "Same declared quality rubric" };
const sample = (ref: string, candidate_ref: string, episode: number): SampleInput => ({ ref, candidate_ref, episode, artifact_ref: "clip-" + ref,
  version: "v1", owner: "manual", duration_seconds: 60, locale: "en", format: "animation" });
function setup(withSamples = true, disk = false) {
  const home = mkdtempSync(join(tmpdir(), "radar-workpack-")); homes.push(home);
  const db = openDb(disk ? join(home, "radar.db") : ":memory:"); databases.push(db);
  let p = createDecision(db, { title: "Synthetic work package", objective: "Test material binding", topics: ["fantasy"], key: "create" }, at()).pack;
  p = addDecisionEvidence(db, meta(p, "ev"), { ref: "ev", kind: "supply", note: "Synthetic reference only", observed_at: at().toISOString(), url: "https://example.com/test" }, at()).pack;
  p = setDecisionBaseline(db, meta(p, "baseline"), { status: "missing", evidence_ref: null, note: "No original baseline" }, at()).pack;
  for (const ref of ["a", "b"]) p = addDecisionCandidate(db, meta(p, ref), { ref, name: ref, market: "US", locale: "en", audience: "Test adults",
    hypothesis: "Synthetic continuation hypothesis", rationale: "Test comparison", risk: "Unknown demand", falsifier: "No gain", cost_note: "Not quoted", evidence_refs: ["ev"] }, at()).pack;
  if (withSamples) for (const ref of ["a", "b"]) for (const episode of [1, 2]) {
    const id = ref + episode, file = join(home, id); writeFileSync(file, "synthetic clip bytes " + id);
    p = addDecisionSample(db, meta(p, id), sample(id, ref, episode), file, at()).pack;
  }
  return { db, p, home };
}
function lock(db: RadarDb, p: DecisionPack, key = "lock", minute = 1, notes = {}) {
  return lockDecisionExperiment(db, meta(p, key), { candidate_ref: "a", control_ref: "b", plan: { ...plan, ...notes }, materials }, at(minute)).experiment;
}
function counts(experiment: ReturnType<typeof lock>, minute = 2): ResultInput {
  // Synthetic values exercise manual ingress; no real viewers exist.
  return { origin: "manual", measurement: "observed", quality: "comparable", source_ref: "synthetic-counts", reason: null,
    started_at: at(minute).toISOString(), finished_at: at(minute + 1).toISOString(), materials_digest: experiment.materials!.digest,
    treatment: { assigned: 32, continued: 10, completed: 20, technical_failures: 0 },
    control: { assigned: 32, continued: 16, completed: 20, technical_failures: 0 } };
}

test("cancellation is immutable, replayable, clock checked and exclusive with results", () => {
  const { db, p } = setup(); const exp = lock(db, p), input = { experiment_ref: exp.ref, key: "cancel", reason: "Recruitment unavailable" };
  expect(() => cancelDecisionExperiment(db, input, at())).toThrow("precede");
  const cancelled = cancelDecisionExperiment(db, input, at(2));
  expect(cancelDecisionExperiment(db, input, at(3)).reused).toBe(true);
  expect(() => cancelDecisionExperiment(db, { ...input, reason: "Changed" }, at(3))).toThrow("different input");
  expect(() => cancelDecisionExperiment(db, { ...input, key: "again" }, at(3))).toThrow("already cancelled");
  expect(readDecisionCancellation(db, exp.ref)).toEqual(cancelled.cancellation);
  expect(readDecisionExperiment(db, exp.ref)).toEqual(exp);
  expect(() => recordDecisionResult(db, { experiment_ref: exp.ref, key: "result", revision: 0 }, counts(exp), at(4))).toThrow("Cancelled");
  expect(readDecisionResult(db, exp.ref)).toBeNull();
  expect(() => lock(db, p, "backwards", 1)).toThrow("precedes");
  expect(reviewDecision(db, p.ref).rounds[0]!.lifecycle).toBe("cancelled");
  const next = lock(db, p, "next", 3);
  recordDecisionResult(db, { experiment_ref: next.ref, key: "record", revision: 0 }, counts(next, 4), at(6));
  expect(() => cancelDecisionExperiment(db, { ...input, experiment_ref: next.ref, key: "late" }, at(7))).toThrow("cannot be cancelled");
});

test("cancellation cannot erase two genuine failed rounds", () => {
  const { db, p } = setup(); const first = lock(db, p);
  recordDecisionResult(db, { experiment_ref: first.ref, revision: 0, key: "r1" }, counts(first), at(4));
  const cancelled = lock(db, p, "cancelled", 5);
  cancelDecisionExperiment(db, { experiment_ref: cancelled.ref, key: "cancel", reason: "Unavailable" }, at(6));
  const second = lock(db, p, "second", 7);
  recordDecisionResult(db, { experiment_ref: second.ref, revision: 0, key: "r2" }, counts(second, 8), at(10));
  expect(reviewDecision(db, p.ref).pause_required).toBe(true);
  expect(() => lock(db, p, "blocked", 11)).toThrow("Two rounds");
});

test("sample registration hashes bytes without paths, preserves history and rejects changed replay", () => {
  const { db, p, home } = setup(false); const file = join(home, "bytes"); writeFileSync(file, "one");
  const next = addDecisionSample(db, meta(p, "sample"), sample("a1", "a", 1), file, at()).pack;
  expect(next.samples![0]!.content_digest).toBe(hashSampleFile(file).content_digest);
  expect(JSON.stringify(next)).not.toContain(home);
  expect(readDecision(db, p.ref, p.revision).samples).toBeUndefined();
  expect(addDecisionSample(db, meta(p, "sample"), sample("a1", "a", 1), file, at()).reused).toBe(true);
  writeFileSync(file, "two");
  expect(() => addDecisionSample(db, meta(p, "sample"), sample("a1", "a", 1), file, at())).toThrow("different input");
  expect(() => addDecisionSample(db, meta(p, "stale"), sample("new", "a", 1), file, at())).toThrow("revision changed");
  expect(() => addDecisionSample(db, meta(next, "duplicate"), sample("a1", "a", 1), file, at())).toThrow("already exists");
  expect(() => addDecisionSample(db, meta(next, "same-version"), { ...sample("new-ref", "a", 1), artifact_ref: "clip-a1" }, file, at())).toThrow("new version");
  expect(() => hashSampleFile(home)).toThrow("regular file");
  const link = join(home, "link"); symlinkSync(file, link);
  expect(() => hashSampleFile(link)).toThrow("symlinks");
  writeFileSync(file, ""); expect(() => hashSampleFile(file)).toThrow("non-empty");
});

test("material pairing rejects missing episodes, duration mismatch and identical bundles", () => {
  const { db, p, home } = setup();
  expect(() => lockDecisionExperiment(db, meta(p, "missing"), { candidate_ref: "a", control_ref: "b", plan,
    materials: { ...materials, sample_refs: ["a1", "a2", "b1", "absent"] } }, at(1))).toThrow("current decision revision");
  let next = addDecisionSample(db, meta(p, "mismatch"), { ...sample("b2short", "b", 2), duration_seconds: 30 }, join(home, "b2"), at()).pack;
  expect(() => lockDecisionExperiment(db, meta(next, "bad-duration"), { candidate_ref: "a", control_ref: "b", plan,
    materials: { ...materials, sample_refs: ["a1", "a2", "b1", "b2short"] } }, at(1))).toThrow("equal per-episode");
  for (const ep of [1, 2]) next = addDecisionSample(db, meta(next, "copy" + ep), sample("copy" + ep, "b", ep), join(home, "a" + ep), at()).pack;
  expect(() => lockDecisionExperiment(db, meta(next, "identical"), { candidate_ref: "a", control_ref: "b", plan,
    materials: { ...materials, sample_refs: ["a1", "a2", "copy1", "copy2"] } }, at(1))).toThrow("Identical");
});

test("result binds exact materials and corrections retain the binding", () => {
  const { db, p } = setup(); const exp = lock(db, p); const meta = { experiment_ref: exp.ref, revision: 0, key: "result" };
  expect(() => recordDecisionResult(db, meta, { ...counts(exp), materials_digest: undefined }, at(4))).toThrow("digest must match");
  expect(() => recordDecisionResult(db, meta, { ...counts(exp), materials_digest: "sha256:" + "0".repeat(64) }, at(4))).toThrow("digest must match");
  const result = recordDecisionResult(db, meta, counts(exp), at(4)).result;
  expect(result.materials_digest).toBe(exp.materials!.digest);
  expect(recordDecisionResult(db, meta, counts(exp), at(5)).reused).toBe(true);
  expect(() => recordDecisionResult(db, { ...meta, revision: 1, key: "correction" }, { ...counts(exp), reason: "Fix", materials_digest: undefined }, at(5))).toThrow("digest must match");
});

test("new protocols ignore operational notes but include substantive conditions", () => {
  const { db, p } = setup(); const first = lock(db, p);
  cancelDecisionExperiment(db, { experiment_ref: first.ref, key: "c1", reason: "Preparation" }, at(2));
  const second = lock(db, p, "second", 3, { budget_note: "Repriced", recruitment_note: "Operator reminder" });
  expect(second.protocol_digest).toBe(first.protocol_digest);
  expect(second.digest).not.toBe(first.digest);
  cancelDecisionExperiment(db, { experiment_ref: second.ref, key: "c2", reason: "Preparation" }, at(4));
  const third = lock(db, p, "third", 5, { protocol_note: "Changed allocation procedure" });
  expect(third.protocol_digest).not.toBe(first.protocol_digest);
});

test("preparation keeps unknowns separate and export preserves existing targets", () => {
  const { db, p, home } = setup(); const prep = prepareDecision(db, p.ref);
  expect(prep.method_comparison_available).toBe(false);
  expect(prep.candidates[0]!.attractiveness).toBe("unassessed");
  expect(prep.candidates[0]!.gaps).toEqual(["demand_evidence_missing", "counterevidence_missing"]);
  const exp = lock(db, p); const work = decisionWorkPackage(db, exp.ref), path = join(home, "export.json");
  expect(work.handoff_status).toBe("prepared_not_accepted");
  exportDecisionPackage(path, work);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(work);
  expect(() => exportDecisionPackage(path, work)).toThrow("new file");
  expect(decisionWorkPackage(db, exp.ref)).toEqual(work);
  cancelDecisionExperiment(db, { experiment_ref: exp.ref, key: "cancel", reason: "Unavailable" }, at(2));
  expect(() => decisionWorkPackage(db, exp.ref)).toThrow("cannot be exported");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(work);
});

test("current content policy guards preparation, cancellation replay and work package", () => {
  const { db, p } = setup(); const exp = lock(db, p), input = { experiment_ref: exp.ref, key: "cancel", reason: "Unavailable" };
  cancelDecisionExperiment(db, input, at(2));
  db.insert(marketSettings).values({ ref: "local", revision: 1, payload: { blocked_topics: ["fantasy"], timezone: "UTC" } }).onConflictDoUpdate({ target: marketSettings.ref, set: { revision: 1, payload: { blocked_topics: ["fantasy"], timezone: "UTC" } } }).run();
  expect(() => prepareDecision(db, p.ref)).toThrow();
  expect(() => cancelDecisionExperiment(db, input, at(3))).toThrow();
  expect(() => decisionWorkPackage(db, exp.ref)).toThrow();
});

test("real CLI registers samples, locks and exports a bound package with safe output", () => {
  const { db, p, home } = setup(false, true);
  const cli = (...args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "decision", ...args, "--json"], {
      cwd: join(import.meta.dir, "../.."), env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_CONFIG_PATH: join(home, "config.yaml") } });
    const stdout = proc.stdout.toString();
    return { exit: proc.exitCode, value: JSON.parse(stdout), stdout };
  };
  let revision = p.revision;
  for (const ref of ["a", "b"]) for (const ep of [1, 2]) {
    const id = ref + ep, file = join(home, id); writeFileSync(file, "synthetic file " + id);
    const result = cli("sample", "add", "--pack", p.ref, "--revision", String(revision), "--key", id, "--sample", id,
      "--candidate", ref, "--artifact", id, "--version", "v1", "--owner", "manual", "--episode", String(ep), "--duration-seconds", "60",
      "--locale", "en", "--format", "animation", "--file", file);
    expect(result.exit).toBe(0); expect(result.stdout).not.toContain(home); revision++;
  }
  expect(cli("prepare", "--pack", p.ref).exit).toBe(0);
  const locked = cli("experiment", "lock", "--pack", p.ref, "--revision", String(revision), "--key", "lock", "--candidate", "a", "--control", "b",
    "--kind", "hypothesis", "--budget-note", "Fixture", "--recruitment-note", "Fixture", "--protocol-note", "Fixture procedure",
    ...materials.sample_refs.flatMap(ref => ["--sample", ref]), "--allocation", "randomized", "--recruitment-channel", "test", "--quality-standard", "Matched");
  expect(locked.exit).toBe(0);
  const exp = locked.value.data.experiment;
  expect(cli("workpack", "show", "--experiment", exp.ref).exit).toBe(0);
  for (const mode of ["--agent", "--events", "--explain"]) {
    const proc = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "decision", "workpack", "show", "--experiment", exp.ref, mode], {
      cwd: join(import.meta.dir, "../.."), env: { ...process.env, RADAR_HOME: home, RADAR_DB_PATH: join(home, "radar.db"), RADAR_CONFIG_PATH: join(home, "config.yaml") } });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain(exp.materials.digest);
    expect(proc.stdout.toString()).not.toContain(home);
  }
  const output = join(home, "work.json");
  expect(cli("workpack", "export", "--experiment", exp.ref, "--output", output).exit).toBe(0);
  expect(cli("workpack", "export", "--experiment", exp.ref, "--output", output).exit).not.toBe(0);
  expect(cli("experiment", "cancel", "--experiment", exp.ref, "--key", "cancel", "--reason", "No real test").exit).toBe(0);
  expect(cli("experiment", "show", "--experiment", exp.ref).value.facts.cancelled).toBe(true);
  expect(cli("workpack", "show", "--experiment", exp.ref).exit).not.toBe(0);
  expect(readDecisionExperiment(db, exp.ref).materials!.samples).toHaveLength(4);
});
