import { hashSampleFile, normalizeSample, type SampleInput } from "./materials.ts";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { decisionPacks, decisionExperiments, decisionResults, decisionCancellations, personalProfiles } from "../db/schema.ts";
import { marketDigest, MarketStoreError } from "../market/repository.ts";
import { assertMarketContentReadable, marketReadPolicy } from "../market/policy.ts";
import { evidenceForSignal } from "../market/question.ts";
import { signalByRef } from "../market/signals.ts";
import {
  candidateInput, choice, cleanText, evaluateExperiment, identifier, instant, integer, invalid,
  planInput, publicUrl, refs, resultInput, withDigest,
  type DecisionPack, type DecisionEvidence, type DecisionCandidate, type DecisionBaseline,
  type DecisionSample, type ExperimentMaterials, type DecisionCancellation, type DecisionExperiment, type ExperimentPlan, type DecisionResult, type ResultInput,
} from "./domain.ts";

export interface Mutation { pack_ref: string; revision: number; key: string }

function scope(db: RadarDb): string | null {
  return db.select({ ref: personalProfiles.ref }).from(personalProfiles).where(eq(personalProfiles.active, 1)).get()?.ref ?? null;
}

function guard(db: RadarDb, pack: DecisionPack): void {
  // Packs created without a profile remain local shared research, so adding
  // the first profile cannot orphan them. Named profile packs stay isolated.
  if (pack.profile_ref !== null && pack.profile_ref !== scope(db)) invalid("decision_not_found", "Decision is unavailable in the active profile.");
  assertMarketContentReadable(db, pack.topics);
}

function clock(now: Date): string {
  if (!Number.isFinite(now.getTime())) invalid("decision_input_invalid", "The local clock must be valid.");
  return now.toISOString();
}

function mutation(input: Mutation): Mutation {
  return { pack_ref: identifier(input.pack_ref, "pack"), revision: integer(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
    key: identifier(input.key, "key") };
}

export function readDecision(db: RadarDb, ref: string, revision?: number): DecisionPack {
  identifier(ref, "pack");
  if (revision !== undefined) integer(revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  const row = db.select().from(decisionPacks).where(revision === undefined ? eq(decisionPacks.ref, ref)
    : and(eq(decisionPacks.ref, ref), eq(decisionPacks.revision, revision))).orderBy(desc(decisionPacks.revision)).get();
  if (!row) invalid("decision_not_found", "Decision or requested revision does not exist; use radar decision list.");
  guard(db, row.payload);
  return row.payload;
}

export function listDecisions(db: RadarDb, limit = 50) {
  integer(limit, "limit", 1, 100);
  const profile = scope(db);
  // ponytail: scan personal history for heads; add a head projection only
  // if measured local history size makes this read a bottleneck.
  const rows = db.select().from(decisionPacks).where(profile === null ? isNull(decisionPacks.profileRef)
    : or(isNull(decisionPacks.profileRef), eq(decisionPacks.profileRef, profile))).orderBy(desc(decisionPacks.revision), asc(decisionPacks.ref)).all();
  const seen = new Set<string>();
  const packs: Array<{ ref: string; revision: number; title: string; digest: string }> = [];
  for (const row of rows) {
    if (seen.has(row.ref)) continue;
    seen.add(row.ref);
    try { guard(db, row.payload); } catch (error) {
      if (error instanceof MarketStoreError && ["content_blocked", "decision_not_found"].includes(error.code)) continue;
      throw error;
    }
    packs.push({ ref: row.ref, revision: row.revision, title: row.payload.title, digest: row.payload.digest });
  }
  return { packs: packs.slice(0, limit), truncated: packs.length > limit };
}

function appendPack(db: RadarDb, pack: DecisionPack, key: string, requestDigest: string): void {
  guard(db, pack);
  db.insert(decisionPacks).values({ ref: pack.ref, revision: pack.revision, profileRef: pack.profile_ref,
    key, requestDigest, payload: pack }).run();
}

export function createDecision(db: RadarDb, input: { title: string; objective: string; topics: string[]; key: string }, now = new Date()) {
  const title = cleanText(input.title, "title", 200), objective = cleanText(input.objective, "objective");
  const topics = refs(input.topics, "topics", 30), key = identifier(input.key, "key");
  const at = clock(now);
  return db.transaction(tx => {
    const profile = scope(tx), request = marketDigest({ operation: "create", title, objective, topics, profile });
    const prior = tx.select().from(decisionPacks).where(eq(decisionPacks.key, key)).get();
    if (prior) {
      guard(tx, prior.payload);
      if (prior.requestDigest !== request) invalid("idempotency_conflict", "Decision key was used for different input.");
      return { pack: prior.payload, reused: true };
    }
    const pack = withDigest<DecisionPack>({ spec: "radar.decision_pack.v1", ref: "decision-" + marketDigest(key).slice(7, 31),
      revision: 1, profile_ref: profile, title, objective, topics, evidence: [], candidates: [], baseline: null,
      resume_after_sequence: 0, resume_reason: null, created_at: at, updated_at: at, digest: "" });
    appendPack(tx, pack, key, request);
    return { pack, reused: false };
  }, { behavior: "immediate" });
}

function revise(db: RadarDb, input: Mutation, operation: string, payload: unknown,
  change: (pack: DecisionPack, tx: RadarDb) => void, now: Date) {
  const meta = mutation(input), at = clock(now);
  const request = marketDigest({ operation, ...meta, payload });
  return db.transaction(tx => {
    const prior = tx.select().from(decisionPacks).where(eq(decisionPacks.key, meta.key)).get();
    if (prior) {
      guard(tx, prior.payload);
      if (prior.requestDigest !== request) invalid("idempotency_conflict", "Decision key was used for different input.");
      return { pack: prior.payload, reused: true };
    }
    const pack = readDecision(tx, meta.pack_ref);
    if (pack.revision !== meta.revision) invalid("state_conflict", "Decision revision changed; read radar decision show before editing.");
    if (at < pack.updated_at) invalid("clock_regression", "The local clock precedes the latest decision revision.");
    change(pack, tx);
    const next = withDigest({ ...pack, revision: pack.revision + 1, updated_at: at });
    appendPack(tx, next, meta.key, request);
    return { pack: next, reused: false };
  }, { behavior: "immediate" });
}

export interface EvidenceInput {
  ref: string; kind: DecisionEvidence["kind"]; note: string; observed_at: string;
  url?: string; signal_ref?: string; signal_revision?: number; market_evidence_ref?: string;
}

export function addDecisionEvidence(db: RadarDb, meta: Mutation, input: EvidenceInput, now = new Date()) {
  const ref = identifier(input.ref, "evidence"), kind = choice(input.kind, "kind", ["supply", "demand", "counterevidence", "background"]);
  const note = cleanText(input.note, "note"), observed_at = instant(input.observed_at, "observed_at");
  if (observed_at > clock(now)) invalid("decision_input_invalid", "Evidence cannot be observed in the future.");
  const url = input.url === undefined ? null : publicUrl(input.url);
  const signal_ref = input.signal_ref === undefined ? null : identifier(input.signal_ref, "signal");
  const signal_revision = input.signal_revision === undefined ? null : integer(input.signal_revision, "signal_revision", 1);
  const market_evidence_ref = input.market_evidence_ref === undefined ? null : identifier(input.market_evidence_ref, "market_evidence");
  if (url ? signal_ref !== null || signal_revision !== null || market_evidence_ref !== null : !signal_ref || !signal_revision || !market_evidence_ref) {
    invalid("decision_input_invalid", "Provide either --url or all of --signal, --signal-revision and --market-evidence.");
  }
  const normalized = { ref, kind, note, observed_at, url, signal_ref, signal_revision, market_evidence_ref };
  return revise(db, meta, "evidence.add", normalized, (pack, tx) => {
    if (pack.evidence.length >= 64) invalid("decision_limit", "A decision pack supports at most 64 evidence references.");
    if (pack.evidence.some(e => e.ref === ref)) invalid("evidence_conflict", "Evidence ref already exists; use a new ref for new evidence.");
    let source_origin = "manual", source_digest: string | null = null;
    if (signal_ref && signal_revision && market_evidence_ref) {
      const source = evidenceForSignal(tx, signal_ref, signal_revision, market_evidence_ref);
      if (kind === "demand") invalid("evidence_kind_invalid", "Stored catalog evidence cannot establish audience demand; use supply or background.");
      if (instant(source.observed_at, "stored observation time") !== observed_at) invalid("evidence_time_conflict", "Use the stored evidence observation time.");
      source_origin = source.origin;
      source_digest = marketDigest(source);
      const signal = signalByRef(tx, signal_ref, signal_revision)!;
      pack.topics = [...new Set([...pack.topics, ...signal.topics])].sort();
    }
    pack.evidence.push({ ...normalized, source: url ? "manual_reference" : "market_signal", source_origin, source_digest });
  }, now);
}

export function addDecisionCandidate(db: RadarDb, meta: Mutation, input: DecisionCandidate, now = new Date()) {
  const candidate = candidateInput(input);
  return revise(db, meta, "candidate.add", candidate, pack => {
    if (pack.candidates.length >= 30) invalid("decision_limit", "A decision pack supports at most 30 candidates.");
    if (pack.candidates.some(c => c.ref === candidate.ref)) invalid("candidate_conflict", "Candidate ref already exists; use a new ref for a revised hypothesis.");
    if (candidate.evidence_refs.some(ref => !pack.evidence.some(e => e.ref === ref))) invalid("evidence_not_found", "Candidate evidence must belong to this pack.");
    pack.candidates.push(candidate);
  }, now);
}

export function setDecisionBaseline(db: RadarDb, meta: Mutation,
  input: { status: DecisionBaseline["status"]; note: string; evidence_ref: string | null }, now = new Date()) {
  const status = choice(input.status, "baseline status", ["missing", "independent"]), note = cleanText(input.note, "note");
  const evidence_ref = input.evidence_ref === null ? null : identifier(input.evidence_ref, "evidence");
  if (status === "missing" && evidence_ref !== null) invalid("baseline_invalid", "A missing baseline cannot carry independent evidence.");
  return revise(db, meta, "baseline.set", { status, note, evidence_ref }, pack => {
    if (pack.baseline) invalid("baseline_locked", "Baseline is already recorded; create a new pack for a new independent comparison.");
    if (status === "independent" && (pack.candidates.length || !pack.evidence.some(e => e.ref === evidence_ref && e.source_origin !== "fixture"))) {
      invalid("baseline_invalid", "Record independent evidence before adding candidates; fixture evidence does not qualify.");
    }
    pack.baseline = { status, note, evidence_ref, recorded_at: clock(now), verification: "operator_attestation" };
  }, now);
}

export function readDecisionExperiment(db: RadarDb, ref: string): DecisionExperiment {
  identifier(ref, "experiment");
  const row = db.select().from(decisionExperiments).where(eq(decisionExperiments.ref, ref)).get();
  if (!row) invalid("experiment_not_found", "Experiment does not exist; use radar decision report.");
  guard(db, row.payload.pack);
  readDecision(db, row.packRef);
  return row.payload;
}

export function readDecisionResult(db: RadarDb, ref: string, revision?: number): DecisionResult | null {
  readDecisionExperiment(db, ref);
  if (revision !== undefined) integer(revision, "result revision", 1);
  const row = db.select().from(decisionResults).where(revision === undefined ? eq(decisionResults.experimentRef, ref)
    : and(eq(decisionResults.experimentRef, ref), eq(decisionResults.revision, revision))).orderBy(desc(decisionResults.revision)).get();
  if (!row && revision !== undefined) invalid("result_not_found", "Requested result revision does not exist.");
  return row?.payload ?? null;
}

export function reviewDecision(db: RadarDb, packRef: string) {
  return db.transaction(tx => {
    const pack = readDecision(tx, packRef);
    const experiments = tx.select().from(decisionExperiments).where(eq(decisionExperiments.packRef, packRef)).orderBy(asc(decisionExperiments.sequence)).all();
    const rounds = experiments.map(row => {
      guard(tx, row.payload.pack);
      const result = readDecisionResult(tx, row.ref);
      const cancellation = readDecisionCancellation(tx, row.ref);
      return { lifecycle: cancellation ? "cancelled" : result ? "recorded" : "locked", cancellation, experiment_ref: row.ref, sequence: row.sequence, kind: row.payload.plan.kind,
        protocol_digest: row.payload.protocol_digest, result_revision: result?.revision ?? null,
        origin: result?.origin ?? null, ...evaluateExperiment(row.payload, result) };
    });
    // Only consecutive manual rounds with the same protocol count. Fixture
    // rehearsals neither contribute to nor erase a real failure streak.
    const tail: typeof rounds = [];
    for (const round of [...rounds].reverse()) {
      if (round.sequence <= pack.resume_after_sequence) break;
      if (round.origin === "fixture" || round.lifecycle === "cancelled") continue;
      if (round.origin !== "manual" || round.verdict === "pending") break;
      if (tail.length && round.protocol_digest !== tail[0]!.protocol_digest) break;
      tail.push(round);
      if (tail.length === 2) break;
    }
    const pause = tail.length === 2 && (tail.every(r => r.verdict === "no_advantage") || tail.every(r => r.verdict === "inconclusive"));
    return { spec: "radar.decision_review.v1", pack_ref: pack.ref, pack_revision: pack.revision,
      baseline_status: pack.baseline?.status ?? "unrecorded", pause_required: pause,
      next_action: pause ? "pause_and_review" : "review_evidence", rounds,
      limitations: ["Counts are operator-reported, not independently verified audience behavior.",
        "Hypothesis experiments do not establish superiority of a selection method.",
        "Directional support is not statistical proof, a production approval or a source qualification."] };
  });
}

export function lockDecisionExperiment(db: RadarDb, metaInput: Mutation,
  input: { candidate_ref: string; control_ref: string; plan: ExperimentPlan; materials?: MaterialsInput }, now = new Date()) {
  const meta = mutation(metaInput), plan = planInput(input.plan), at = clock(now);
  const candidate_ref = identifier(input.candidate_ref, "candidate"), control_ref = identifier(input.control_ref, "control");
  if (candidate_ref === control_ref) invalid("experiment_invalid", "Use two distinct candidates; identical choices do not establish an advantage.");
  const materialInput = input.materials === undefined ? undefined : normalizeMaterials(input.materials);
  const request = marketDigest({ ...meta, plan, candidate_ref, control_ref, ...(materialInput ? { materials: materialInput } : {}) });
  return db.transaction(tx => {
    const prior = tx.select().from(decisionExperiments).where(eq(decisionExperiments.key, meta.key)).get();
    if (prior) {
      readDecisionExperiment(tx, prior.ref);
      if (prior.requestDigest !== request) invalid("idempotency_conflict", "Experiment key was used for different input.");
      return { experiment: prior.payload, reused: true };
    }
    const pack = readDecision(tx, meta.pack_ref);
    if (pack.revision !== meta.revision) invalid("state_conflict", "Decision revision changed; read the current decision before locking.");
    if (at < pack.updated_at) invalid("clock_regression", "The local clock precedes the latest decision revision.");
    const candidate = pack.candidates.find(c => c.ref === candidate_ref), control = pack.candidates.find(c => c.ref === control_ref);
    if (!candidate || !control) invalid("candidate_not_found", "Both candidates must belong to this decision pack.");
    if ([candidate.market, candidate.locale, candidate.audience].join("\0") !== [control.market, control.locale, control.audience].join("\0") || ["unknown", "global"].includes(candidate.market)) {
      invalid("experiment_incomparable", "Lock two candidates for the same explicit market, language and audience.");
    }
    if (!pack.baseline || (plan.kind === "method" && pack.baseline.status !== "independent")) {
      invalid("baseline_required", "Record the baseline explicitly; method comparisons require a prior independent baseline.");
    }
    if (plan.kind === "method" && !control.evidence_refs.includes(pack.baseline.evidence_ref!)) {
      invalid("baseline_mismatch", "The control candidate must cite the recorded independent baseline evidence.");
    }
    const report = reviewDecision(tx, pack.ref);
    if (report.pause_required) invalid("review_required", "Two rounds require review; use radar decision resume with a reason before locking another experiment.");
    if (report.rounds.at(-1)?.lifecycle === "locked") invalid("experiment_pending", "Record the previous experiment outcome before starting another round.");
    if (report.rounds.length >= 200) invalid("decision_limit", "A pack supports at most 200 experiments; start a new bounded decision.");
    const last = report.rounds.at(-1);
    if (last) {
      const result = readDecisionResult(tx, last.experiment_ref);
      const endedAt = result?.recorded_at ?? last.cancellation!.cancelled_at;
      if (at < endedAt) invalid("clock_regression", "The new lock precedes the previous outcome record.");
    }
    const metric_version = "continued-15s-completed-90pct.v1" as const;
    const materials = materialInput ? freezeMaterials(pack, candidate_ref, control_ref, materialInput) : undefined;
    const { budget_note: _budget, recruitment_note: _recruitment, ...conditions } = plan;
    const protocol_digest = marketDigest({ plan: materials ? conditions : plan,
      ...(materials ? { protocol_version: "materials.v1", allocation: materials.allocation, recruitment_channel: materials.recruitment_channel,
        quality_standard: materials.quality_standard, durations: materials.samples.map(s => s.duration_seconds), format: materials.samples[0]!.format } : {}), market: candidate.market, locale: candidate.locale, audience: candidate.audience,
      baseline: pack.baseline, metric_version });
    const experiment = withDigest<DecisionExperiment>({ spec: "radar.decision_experiment.v1", ref: "experiment-" + marketDigest(meta.key).slice(7, 31),
      pack_ref: pack.ref, pack_revision: pack.revision, sequence: report.rounds.length + 1, pack,
      candidate_ref, control_ref, plan, ...(materials ? { materials } : {}), metric_version, protocol_digest, policy_revision: marketReadPolicy(tx).policy_revision,
      locked_at: at, registration_scope: "local", digest: "" });
    tx.insert(decisionExperiments).values({ ref: experiment.ref, packRef: pack.ref, sequence: experiment.sequence,
      key: meta.key, requestDigest: request, payload: experiment }).run();
    return { experiment, reused: false };
  }, { behavior: "immediate" });
}

export function recordDecisionResult(db: RadarDb, meta: { experiment_ref: string; revision: number; key: string }, raw: ResultInput, now = new Date()) {
  const experiment_ref = identifier(meta.experiment_ref, "experiment"), revision = integer(meta.revision, "result revision");
  const key = identifier(meta.key, "key"), input = resultInput(raw), at = clock(now);
  const request = marketDigest({ experiment_ref, revision, input });
  return db.transaction(tx => {
    const experiment = readDecisionExperiment(tx, experiment_ref);
    const prior = tx.select().from(decisionResults).where(eq(decisionResults.key, key)).get();
    if (prior) {
      readDecisionExperiment(tx, prior.experimentRef);
      if (prior.requestDigest !== request) invalid("idempotency_conflict", "Result key was used for different input.");
      return { result: prior.payload, reused: true };
    }
    if (readDecisionCancellation(tx, experiment_ref)) invalid("experiment_cancelled", "Cancelled experiments cannot receive results; lock a new experiment.");
    if (experiment.materials ? input.materials_digest !== experiment.materials.digest : input.materials_digest !== undefined) {
      invalid("materials_mismatch", "Result materials digest must match the frozen experiment materials contract.");
    }
    const previous = readDecisionResult(tx, experiment_ref);
    if ((previous?.revision ?? 0) !== revision) invalid("state_conflict", "Result revision changed; read the current result before recording a correction.");
    if (previous && (!input.reason || previous.origin !== input.origin)) invalid("result_correction_invalid", "Corrections require a reason and must retain the original origin.");
    if (input.started_at < experiment.locked_at || input.finished_at < input.started_at || input.finished_at > at || (previous && previous.recorded_at > at)) {
      invalid("result_time_invalid", "Observation must start after the lock and finish no later than the record time.");
    }
    const result = withDigest<DecisionResult>({ ...input, spec: "radar.decision_result.v1", experiment_ref,
      revision: revision + 1, recorded_at: at, verification: "operator_reported", digest: "" });
    tx.insert(decisionResults).values({ experimentRef: experiment_ref, revision: result.revision, key,
      requestDigest: request, payload: result }).run();
    return { result, reused: false };
  }, { behavior: "immediate" });
}

export function resumeDecision(db: RadarDb, meta: Mutation, reasonInput: string, now = new Date()) {
  const reason = cleanText(reasonInput, "reason");
  return revise(db, meta, "resume", { reason }, (pack, tx) => {
    const report = reviewDecision(tx, pack.ref);
    if (!report.pause_required) invalid("review_not_required", "No pause requires a resume decision.");
    const last = report.rounds.at(-1)!;
    const latest = readDecisionResult(tx, last.experiment_ref);
    if (clock(now) < (latest?.recorded_at ?? last.cancellation!.cancelled_at)) invalid("clock_regression", "The review clock precedes the latest outcome record.");
    pack.resume_after_sequence = report.rounds.at(-1)!.sequence;
    pack.resume_reason = reason;
  }, now);
}

export function readDecisionCancellation(db: RadarDb, experimentRef: string): DecisionCancellation | null {
  readDecisionExperiment(db, experimentRef);
  return db.select().from(decisionCancellations).where(eq(decisionCancellations.experimentRef, experimentRef)).get()?.payload ?? null;
}

export function cancelDecisionExperiment(db: RadarDb, input: { experiment_ref: string; key: string; reason: string }, now = new Date()) {
  const experiment_ref = identifier(input.experiment_ref, "experiment"), key = identifier(input.key, "key");
  const reason = cleanText(input.reason, "reason"), at = clock(now), request = marketDigest({ experiment_ref, reason });
  return db.transaction(tx => {
    const experiment = readDecisionExperiment(tx, experiment_ref);
    const prior = tx.select().from(decisionCancellations).where(eq(decisionCancellations.key, key)).get();
    if (prior) {
      readDecisionExperiment(tx, prior.experimentRef);
      if (prior.requestDigest !== request) invalid("idempotency_conflict", "Cancellation key was used for different input.");
      return { cancellation: prior.payload, reused: true };
    }
    if (readDecisionCancellation(tx, experiment_ref)) invalid("experiment_cancelled", "Experiment is already cancelled.");
    if (readDecisionResult(tx, experiment_ref)) invalid("result_exists", "An observed experiment cannot be cancelled; correct its result with a reason.");
    if (at < experiment.locked_at) invalid("clock_regression", "Cancellation cannot precede the experiment lock.");
    const cancellation = withDigest<DecisionCancellation>({ spec: "radar.decision_cancellation.v1", experiment_ref,
      experiment_digest: experiment.digest, reason, cancelled_at: at, verification: "operator_attestation", digest: "" });
    tx.insert(decisionCancellations).values({ experimentRef: experiment_ref, key, requestDigest: request, payload: cancellation }).run();
    return { cancellation, reused: false };
  }, { behavior: "immediate" });
}

export function addDecisionSample(db: RadarDb, meta: Mutation, input: SampleInput, file: string, now = new Date()) {
  // Validate scope and metadata before opening a user-selected local artifact.
  const pack = readDecision(db, meta.pack_ref);
  const normalized = normalizeSample(input);
  if (!pack.candidates.some(c => c.ref === normalized.candidate_ref)) invalid("candidate_not_found", "Sample candidate must belong to the pack.");
  const sample: DecisionSample = { ...normalized, ...hashSampleFile(file), verification: "local_file_hash", metadata_verification: "operator_attestation" };
  return revise(db, meta, "sample.add", sample, p => {
    if ((p.samples?.length ?? 0) >= 120) invalid("decision_limit", "A decision supports at most 120 samples.");
    if (p.samples?.some(s => s.ref === sample.ref)) invalid("sample_conflict", "Sample ref already exists; register changed bytes under a new ref.");
    if (p.samples?.some(s => s.owner === sample.owner && s.artifact_ref === sample.artifact_ref && s.version === sample.version && s.content_digest !== sample.content_digest)) {
      invalid("sample_version_conflict", "Changed artifact bytes require a new version and sample ref.");
    }
    p.samples = [...(p.samples ?? []), sample];
  }, now);
}

export interface MaterialsInput { sample_refs: string[]; allocation: ExperimentMaterials["allocation"]; recruitment_channel: string; quality_standard: string }
function normalizeMaterials(input: MaterialsInput): MaterialsInput {
  const sample_refs = refs(input.sample_refs, "samples", 4);
  if (sample_refs.length !== 4) invalid("materials_invalid", "Select four samples: two episodes per arm.");
  return { sample_refs, allocation: choice(input.allocation, "allocation", ["randomized", "manual_balanced"]),
    recruitment_channel: identifier(input.recruitment_channel, "recruitment_channel"), quality_standard: cleanText(input.quality_standard, "quality_standard") };
}
function freezeMaterials(pack: DecisionPack, candidate: string, control: string, input: MaterialsInput): ExperimentMaterials {
  const selected = input.sample_refs.map(ref => pack.samples?.find(s => s.ref === ref));
  if (selected.some(s => !s)) invalid("sample_not_found", "All samples must belong to the current decision revision.");
  const samples = [candidate, control].flatMap(ref => [1, 2].map(episode => {
    const matches = selected.filter(s => s!.candidate_ref === ref && s!.episode === episode);
    if (matches.length !== 1) invalid("materials_invalid", "Select exactly episodes 1 and 2 for each arm.");
    return matches[0]!;
  }));
  const locale = pack.candidates.find(c => c.ref === candidate)!.locale;
  if (samples.some(s => s.locale !== locale || s.format !== samples[0]!.format) ||
    samples[0]!.duration_seconds !== samples[2]!.duration_seconds || samples[1]!.duration_seconds !== samples[3]!.duration_seconds) {
    invalid("materials_incomparable", "Both arms require the candidate language, one format and equal per-episode durations.");
  }
  if (samples[0]!.content_digest === samples[2]!.content_digest && samples[1]!.content_digest === samples[3]!.content_digest) {
    invalid("materials_identical", "Identical material bundles cannot establish a candidate advantage.");
  }
  return withDigest({ spec: "radar.experiment_materials.v1" as const, samples, allocation: input.allocation,
    recruitment_channel: input.recruitment_channel, quality_standard: input.quality_standard, digest: "" });
}

export function prepareDecision(db: RadarDb, ref: string) {
  return db.transaction(tx => {
    const pack = readDecision(tx, ref), review = reviewDecision(tx, ref);
    return { spec: "radar.decision_preparation.v1", pack_ref: pack.ref, pack_revision: pack.revision,
      baseline_status: pack.baseline?.status ?? "unrecorded", method_comparison_available: pack.baseline?.status === "independent",
      pause_required: review.pause_required, pending_experiment: review.rounds.find(r => r.lifecycle === "locked")?.experiment_ref ?? null,
      candidates: pack.candidates.map(candidate => {
        const evidence = pack.evidence.filter(e => candidate.evidence_refs.includes(e.ref));
        const count = (kind: DecisionEvidence["kind"]) => evidence.filter(e => e.kind === kind && e.source_origin !== "fixture").length;
        const samples = (pack.samples ?? []).filter(s => s.candidate_ref === candidate.ref);
        return { candidate, evidence_counts: { demand: count("demand"), supply: count("supply"), counterevidence: count("counterevidence"), background: count("background") },
          credibility: "requires_source_review", attractiveness: "unassessed", entry_cost: { status: "operator_estimate", note: candidate.cost_note },
          sample_refs: samples.map(s => s.ref), gaps: [
            ...(!count("demand") ? ["demand_evidence_missing"] : []), ...(!count("counterevidence") ? ["counterevidence_missing"] : []),
            ...(["unknown", "global"].includes(candidate.market) ? ["explicit_market_missing"] : []),
            ...[1, 2].filter(ep => !samples.some(s => s.episode === ep && s.locale === candidate.locale)).map(ep => `episode_${ep}_missing`),
          ] };
      }), limitations: ["Evidence presence does not establish demand, source credibility or production approval.",
        "Sample hashes verify bytes only; duration, language and quality remain operator attestations.",
        "Recruitment availability, cost and sample size require investigation before a real test."] };
  });
}

export function decisionWorkPackage(db: RadarDb, ref: string) {
  return db.transaction(tx => {
    const experiment = readDecisionExperiment(tx, ref);
    if (!experiment.materials) invalid("materials_required", "Legacy experiments have no material binding; register samples and lock a new experiment.");
    if (readDecisionCancellation(tx, ref)) invalid("experiment_cancelled", "Cancelled experiments cannot be exported for execution.");
    return withDigest({ spec: "radar.decision_work_package.v1", handoff_status: "prepared_not_accepted", experiment,
      materials_digest: experiment.materials.digest, production_owner: "auctra_scaena", audience_test_owner: "manual",
      limitations: ["No production or recruitment action has been executed.", "Consumer acceptance and actual playback are not certified."], digest: "" });
  });
}
