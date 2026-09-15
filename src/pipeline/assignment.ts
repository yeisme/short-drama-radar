import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { radarAssignments } from "../db/schema.ts";
import { marketDigest, MarketStoreError } from "../market/repository.ts";
import { marketBriefByRef } from "../market/brief.ts";
import { editionByRef, latestEdition, type EditionEntry, type EditionRecord } from "./edition.ts";
import { addFeedback } from "./feedback.ts";
import type { ProfileRecord } from "../profile/service.ts";

export const ASSIGNMENT_SPEC = "radar.production_assignment.v1" as const;
export type AssignmentStatus = "ready" | "do_not_shoot" | "rejected";
export type AssignmentRejectKind = "too_risky" | "not_relevant";
export type DownstreamStatus = "not_submitted" | "submitted" | "produced";

export interface AuctraHandoff {
  project_ref: string;
  proposal_ref: string;
  review_ref: string;
  unit_ref: string;
}

export interface ScaenaHandoff {
  project_ref: string;
  receipt_ref: string;
}

export interface AssignmentWhyNot {
  opportunity_ref: string;
  personal_fit: number;
  reason_codes: string[];
}

export interface ProductionAssignment {
  spec: typeof ASSIGNMENT_SPEC;
  assignment_ref: string;
  digest: string;
  status: AssignmentStatus;
  target_owner: "auctra";
  downstream_status: DownstreamStatus;
  auctra: AuctraHandoff | null;
  scaena: ScaenaHandoff | null;
  profile_ref: string;
  profile_revision: number;
  edition_ref: string;
  edition_digest: string;
  opportunity_ref: string | null;
  brief_ref: string | null;
  scores: { market_score: number | null; personal_fit: number | null; evidence_confidence: number | null };
  why_this: string[];
  why_not_others: AssignmentWhyNot[];
  limitations: string[];
  idempotency_key: string;
  created_at: string;
}

export function createAssignment(db: RadarDb, input: {
  profile: ProfileRecord;
  editionRef?: string;
  opportunityRef?: string;
  briefRef?: string;
  idempotencyKey?: string;
}, now = new Date()) {
  const edition = resolveEdition(db, input.profile, input.editionRef);
  if (edition.profileRef !== input.profile.ref) {
    throw new MarketStoreError("assignment_stale", "Edition belongs to a different profile.");
  }
  if (edition.profileRevision !== input.profile.headRevision) {
    throw new MarketStoreError("assignment_stale", "Profile changed after this edition; rebuild the edition before assigning.");
  }
  let briefRef: string | null = null;
  if (input.briefRef) {
    const brief = marketBriefByRef(db, input.briefRef);
    if (!brief) throw new MarketStoreError("brief_not_found", "Requested market brief does not exist.");
    briefRef = brief.brief_ref;
  }
  const picked = pickEntry(edition, input.opportunityRef);
  const status: AssignmentStatus = picked ? "ready" : "do_not_shoot";
  const key = input.idempotencyKey ?? defaultAssignmentKey(edition.editionRef, picked?.opportunityRef ?? "", edition.profileRevision, briefRef);
  const existing = db.select().from(radarAssignments).where(eq(radarAssignments.idempotencyKey, key)).get();
  if (existing) {
    const prior = existing.payload;
    const same = prior.edition_ref === edition.editionRef && prior.opportunity_ref === (picked?.opportunityRef ?? null)
      && prior.profile_revision === edition.profileRevision && prior.brief_ref === briefRef;
    if (!same) throw new MarketStoreError("idempotency_conflict", "Idempotency key was reused with different assignment parameters.");
    return { assignment: prior, reused: true };
  }
  const whyNot = picked
    ? edition.entries.filter(entry => entry.opportunityRef !== picked.opportunityRef)
      .map(entry => ({ opportunity_ref: entry.opportunityRef, personal_fit: entry.personalFit, reason_codes: entry.reasonCodes }))
    : [];
  const limitations = [
    ...edition.limitations,
    "Assignment is not an Auctra proposal; downstream_status stays not_submitted until an owner ingress writes a receipt.",
    "used feedback is not recorded at assignment create.",
  ];
  if (status === "do_not_shoot") limitations.push("Empty or below-threshold edition: do not shoot today.");
  if (briefRef) limitations.push("Attached market brief is evidence context, not a combined market+personal score.");
  const content = {
    spec: ASSIGNMENT_SPEC, status, target_owner: "auctra" as const, downstream_status: "not_submitted" as const, auctra: null, scaena: null,
    profile_ref: edition.profileRef, profile_revision: edition.profileRevision,
    edition_ref: edition.editionRef, edition_digest: edition.digest,
    opportunity_ref: picked?.opportunityRef ?? null, brief_ref: briefRef,
    scores: {
      market_score: picked?.marketScore ?? null,
      personal_fit: picked?.personalFit ?? null,
      evidence_confidence: picked?.evidenceConfidence ?? null,
    },
    why_this: picked?.reasonCodes ?? ["edition_empty"],
    why_not_others: whyNot, limitations, idempotency_key: key,
  };
  const digest = marketDigest(content);
  const assignment: ProductionAssignment = {
    ...content, assignment_ref: "assignment-" + digest.slice(7, 39), digest, created_at: now.toISOString(),
  };
  db.insert(radarAssignments).values({
    ref: assignment.assignment_ref, idempotencyKey: key, profileRef: assignment.profile_ref,
    profileRevision: assignment.profile_revision, editionRef: assignment.edition_ref,
    opportunityRef: assignment.opportunity_ref, briefRef: assignment.brief_ref,
    status: assignment.status, payload: assignment, createdAt: assignment.created_at,
  }).run();
  return { assignment, reused: false };
}

export function assignmentByRef(db: RadarDb, ref: string, profileRef?: string): ProductionAssignment {
  const row = ref === "latest"
    ? (profileRef
      ? db.select().from(radarAssignments).where(eq(radarAssignments.profileRef, profileRef))
        .orderBy(desc(radarAssignments.createdAt), radarAssignments.ref).limit(1).get()
      : db.select().from(radarAssignments).orderBy(desc(radarAssignments.createdAt), radarAssignments.ref).limit(1).get())
    : db.select().from(radarAssignments).where(eq(radarAssignments.ref, ref)).get();
  if (!row) throw new MarketStoreError("assignment_not_found", "Assignment does not exist.");
  if (profileRef && row.profileRef !== profileRef) throw new MarketStoreError("assignment_not_found", "Assignment does not exist.");
  return row.payload;
}

export function rejectAssignment(db: RadarDb, input: {
  profile: ProfileRecord;
  assignmentRef: string;
  kind: string;
  idempotencyKey?: string;
}, now = new Date()) {
  if (input.kind !== "too_risky" && input.kind !== "not_relevant") {
    throw new MarketStoreError("flag_invalid", "Reject kind must be too_risky or not_relevant.");
  }
  const current = assignmentByRef(db, input.assignmentRef, input.profile.ref);
  if (current.downstream_status === "submitted") {
    throw new MarketStoreError("assignment_already_submitted", "Submitted assignments cannot be rejected here; review them in Auctra.");
  }
  if (current.status === "rejected") return { assignment: current, reused: true };
  if (current.profile_revision !== input.profile.headRevision) {
    throw new MarketStoreError("assignment_stale", "Profile changed after this assignment; rebuild before rejecting.");
  }
  let feedbackDuplicate = false;
  if (current.opportunity_ref) {
    const receipt = addFeedback(db, {
      profileRef: input.profile.ref,
      opportunityRef: current.opportunity_ref,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey ?? `assignment-reject:${current.assignment_ref}:${input.kind}`,
    }, now);
    feedbackDuplicate = receipt.duplicate;
  }
  const next: ProductionAssignment = {
    ...current,
    status: "rejected",
    limitations: [...current.limitations, `Rejected as ${input.kind}; Auctra was not opened.`],
  };
  db.update(radarAssignments).set({ status: "rejected", payload: next }).where(eq(radarAssignments.ref, current.assignment_ref)).run();
  return { assignment: next, reused: false, feedback_duplicate: feedbackDuplicate };
}

function resolveEdition(db: RadarDb, profile: ProfileRecord, ref?: string): EditionRecord {
  const edition = ref && ref !== "latest" ? editionByRef(db, ref) : latestEdition(db, profile.ref);
  if (!edition) throw new MarketStoreError("edition_not_found", "No edition found; run radar edition build first.");
  return edition;
}

function pickEntry(edition: EditionRecord, opportunityRef?: string): EditionEntry | null {
  if (edition.status === "empty" || edition.entries.length === 0) {
    if (opportunityRef) throw new MarketStoreError("opportunity_not_in_edition", "Empty edition has no opportunities.");
    return null;
  }
  if (!opportunityRef) return edition.entries[0] ?? null;
  const entry = edition.entries.find(item => item.opportunityRef === opportunityRef);
  if (!entry) throw new MarketStoreError("opportunity_not_in_edition", "Opportunity is not in this edition.");
  return entry;
}

function defaultAssignmentKey(editionRef: string, opportunityRef: string, revision: number, briefRef: string | null): string {
  return [editionRef, opportunityRef || "none", String(revision), briefRef ?? "none"].join(":");
}

export interface AuctraRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AuctraRunner = (args: string[]) => AuctraRunResult;

export function submitAssignment(db: RadarDb, input: {
  profile: ProfileRecord;
  assignmentRef: string;
  auctraPath: string;
  auctraBin?: string;
  runAuctra?: AuctraRunner;
}, now = new Date()) {
  const current = assignmentByRef(db, input.assignmentRef, input.profile.ref);
  if (current.status !== "ready") {
    throw new MarketStoreError("assignment_not_ready", "Only a ready assignment can be submitted to Auctra.");
  }
  if (current.profile_revision !== input.profile.headRevision) {
    throw new MarketStoreError("assignment_stale", "Profile changed after this assignment; rebuild before submitting.");
  }
  if (current.downstream_status === "submitted" && current.auctra) {
    return { assignment: current, reused: true };
  }
  const projectRoot = input.auctraPath.trim();
  if (!projectRoot) throw new MarketStoreError("value_required", "Provide --auctra-path <project-root>.");
  const packetDir = join(tmpdir(), "short-drama-radar");
  mkdirSync(packetDir, { recursive: true });
  const packetPath = join(packetDir, `${current.assignment_ref}.json`);
  writeFileSync(packetPath, JSON.stringify(current), { encoding: "utf8", mode: 0o600 });
  try {
    const bin = input.auctraBin?.trim() || process.env.AUCTRA_BIN || "auctra";
    const runner = input.runAuctra ?? defaultAuctraRunner(bin);
    const result = runner(["text", "proposal", "from-radar", "--path", projectRoot, "--from", packetPath, "--json"]);
    if (result.exitCode !== 0) {
      throw new MarketStoreError("auctra_failed", auctraFailureMessage(result));
    }
    const handoff = parseAuctraHandoff(result.stdout, projectRoot);
    const next: ProductionAssignment = {
      ...current,
      downstream_status: "submitted",
      auctra: handoff,
      limitations: [...current.limitations, `Submitted to Auctra proposal ${handoff.proposal_ref}; used is recorded only after this receipt.`],
    };
    db.update(radarAssignments).set({ payload: next }).where(eq(radarAssignments.ref, current.assignment_ref)).run();
    if (current.opportunity_ref) {
      addFeedback(db, {
        profileRef: input.profile.ref,
        opportunityRef: current.opportunity_ref,
        kind: "used",
        projectRef: handoff.proposal_ref,
        idempotencyKey: `assignment-submit:${current.assignment_ref}:used`,
      }, now);
    }
    return { assignment: next, reused: false };
  } finally {
    try { unlinkSync(packetPath); } catch { /* packet is a temp file */ }
  }
}

function defaultAuctraRunner(bin: string): AuctraRunner {
  return (args) => {
    const proc = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: proc.exitCode ?? 1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  };
}

function parseAuctraHandoff(stdout: string, projectRoot: string): AuctraHandoff {
  let envelope: {
    status?: string;
    facts?: { unit_ref?: string };
    data?: { proposal_ref?: string; review_ref?: string; status?: string };
    error?: { message?: string };
  };
  try { envelope = JSON.parse(stdout); }
  catch { throw new MarketStoreError("auctra_failed", "Auctra did not return a JSON envelope."); }
  if (envelope.status !== "success" || envelope.data?.status !== "pending_review" || !envelope.data.proposal_ref || !envelope.data.review_ref) {
    throw new MarketStoreError("auctra_failed", envelope.error?.message ?? "Auctra did not return a pending_review proposal.");
  }
  return {
    project_ref: projectRoot,
    proposal_ref: envelope.data.proposal_ref,
    review_ref: envelope.data.review_ref,
    unit_ref: envelope.facts?.unit_ref ?? "",
  };
}

function auctraFailureMessage(result: AuctraRunResult): string {
  try {
    const envelope = JSON.parse(result.stdout) as { error?: { message?: string } };
    if (envelope.error?.message) return envelope.error.message;
  } catch { /* use stderr */ }
  const stderr = result.stderr.trim();
  if (stderr) return stderr.slice(0, 300);
  return `Auctra exited ${result.exitCode}.`;
}

export function produceAssignment(db: RadarDb, input: {
  profile: ProfileRecord;
  assignmentRef: string;
  scaenaPath: string;
  auctraBin?: string;
  scaenaBin?: string;
  runAuctra?: AuctraRunner;
  runScaena?: AuctraRunner;
}, now = new Date()) {
  const current = assignmentByRef(db, input.assignmentRef, input.profile.ref);
  if (current.downstream_status === "produced" && current.scaena) {
    return { assignment: current, reused: true };
  }
  if (current.downstream_status !== "submitted" || !current.auctra) {
    throw new MarketStoreError("assignment_not_submitted", "Submit the assignment to Auctra and accept the proposal before producing a Scaena project.");
  }
  if (current.profile_revision !== input.profile.headRevision) {
    throw new MarketStoreError("assignment_stale", "Profile changed after this assignment; rebuild before producing.");
  }
  const scaenaRoot = input.scaenaPath.trim();
  if (!scaenaRoot) throw new MarketStoreError("value_required", "Provide --scaena-path <project-root>.");
  const auctraBin = input.auctraBin?.trim() || process.env.AUCTRA_BIN || "auctra";
  const scaenaBin = input.scaenaBin?.trim() || process.env.SCAENA_BIN || "scaena";
  const auctra = (input.runAuctra ?? defaultAuctraRunner(auctraBin))([
    "text", "proposal", "show", current.auctra.proposal_ref, "--path", current.auctra.project_ref, "--json",
  ]);
  if (auctra.exitCode !== 0) throw new MarketStoreError("auctra_failed", auctraFailureMessage(auctra));
  const accepted = parseAuctraAccepted(auctra.stdout);
  const packet = {
    spec: "radar.scaena_skeleton.v1",
    assignment_ref: current.assignment_ref,
    edition_ref: current.edition_ref,
    opportunity_ref: current.opportunity_ref,
    profile_ref: current.profile_ref,
    profile_revision: current.profile_revision,
    auctra: {
      project_ref: current.auctra.project_ref,
      proposal_ref: current.auctra.proposal_ref,
      review_ref: current.auctra.review_ref,
      unit_ref: accepted.unit_ref || current.auctra.unit_ref,
      status: "accepted",
      canonical_revision: accepted.canonical_revision,
    },
    limitations: ["Scaena skeleton only; no storyboard or generation was started."],
  };
  mkdirSync(scaenaRoot, { recursive: true });
  const packetPath = join(scaenaRoot, "radar-skeleton.json");
  writeFileSync(packetPath, JSON.stringify(packet), { encoding: "utf8", mode: 0o600 });
  const scaena = (input.runScaena ?? defaultAuctraRunner(scaenaBin))([
    "handoff", "radar", "import", "--project", scaenaRoot, "--from", "radar-skeleton.json", "--confirm", "--json",
  ]);
  if (scaena.exitCode !== 0) throw new MarketStoreError("scaena_failed", auctraFailureMessage(scaena));
  const receiptRef = parseScaenaReceipt(scaena.stdout);
  const next: ProductionAssignment = {
    ...current,
    downstream_status: "produced",
    scaena: { project_ref: scaenaRoot, receipt_ref: receiptRef },
    limitations: [...current.limitations, `Scaena skeleton ${receiptRef}; storyboard and generation were not started.`],
  };
  db.update(radarAssignments).set({ payload: next }).where(eq(radarAssignments.ref, current.assignment_ref)).run();
  return { assignment: next, reused: false };
}

function parseAuctraAccepted(stdout: string): { canonical_revision: string; unit_ref: string } {
  let envelope: { status?: string; data?: { status?: string; canonical_revision?: string; target_unit_ref?: string } };
  try { envelope = JSON.parse(stdout); }
  catch { throw new MarketStoreError("auctra_failed", "Auctra did not return a JSON envelope."); }
  if (envelope.data?.status !== "accepted") {
    throw new MarketStoreError("auctra_not_accepted", "Auctra proposal is not accepted; Scaena will not create a project.");
  }
  return { canonical_revision: envelope.data.canonical_revision ?? "", unit_ref: envelope.data.target_unit_ref ?? "" };
}

function parseScaenaReceipt(stdout: string): string {
  let envelope: { status?: string; facts?: { receipt_ref?: string }; data?: { receipt?: { receipt_ref?: string } }; output_refs?: string[] };
  try { envelope = JSON.parse(stdout); }
  catch { throw new MarketStoreError("scaena_failed", "Scaena did not return a JSON envelope."); }
  const ref = envelope.facts?.receipt_ref || envelope.data?.receipt?.receipt_ref || envelope.output_refs?.[0];
  if (!ref) throw new MarketStoreError("scaena_failed", "Scaena did not return a receipt_ref.");
  return ref;
}
