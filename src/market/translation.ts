import { and, desc, eq, inArray } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketEvidence, marketObservations, marketTitleTranslations } from "../db/schema.ts";
import { listWorkMappings, workMapping } from "./identity.ts";
import { sourceByRef, marketDigest, MarketStoreError } from "./repository.ts";
import { assertMarketContentReadable } from "./policy.ts";

export type ChineseLocale = "zh-Hans" | "zh-Hant";
export interface TitleTranslation {
  spec: "radar.title_translation.v1";
  work_ref: string; work_revision: number; revision: number;
  target_locale: ChineseLocale; original_title: string; source_locale: string;
  source_digest: string; translated_title: string;
  method: "agent" | "human"; translator_ref: string;
  review_status: "unreviewed"; verification: "operator_reported";
  reason: string | null; created_at: string; digest: string;
}
function fail(code: string, message: string): never { throw new MarketStoreError(code, message); }
function text(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail("translation_invalid", "Provide bounded, non-empty single-line text.");
  if (/(?:authorization\s*:|bearer\s+\S+|(?:password|cookie|token|secret|api[_-]?key)\s*[=:]\s*\S+|-----BEGIN .*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{16,})/i.test(value)) fail("sensitive_input", "Remove credential material before storing a translation.");
  return value.trim();
}
function ref(value: unknown): string {
  const result = text(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail("translation_invalid", "Use an opaque identifier.");
  return result;
}
function revision(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > 1000000) fail("translation_invalid", "Revision must be a bounded integer.");
  return value;
}
export function chineseLocale(value: unknown): ChineseLocale {
  if (value !== "zh-Hans" && value !== "zh-Hant") fail("translation_invalid", "Language must be zh-Hans or zh-Hant.");
  return value;
}
function context(db: RadarDb, work: string) {
  const mapping = workMapping(db, ref(work));
  if (!mapping) fail("identity_not_found", "Work mapping does not exist.");
  const evidence = mapping.supporting_evidence_refs.length ? db.select().from(marketEvidence)
    .where(inArray(marketEvidence.ref, mapping.supporting_evidence_refs)).orderBy(desc(marketEvidence.observedAt)).all() : [];
  const matching = evidence.filter(e => e.payload.title === mapping.original_title);
  if (!matching.length) fail("translation_source_missing", "The original title requires matching stored evidence.");
  const source = matching[0]!;
  // Conservative policy check across matching source history; translation
  // text never supplies topics or overrides the classification of its source.
  const observations = db.select().from(marketObservations).where(and(eq(marketObservations.sourceRef, source.sourceRef),
    eq(marketObservations.itemId, source.payload.source_item_id))).all();
  assertMarketContentReadable(db, [...new Set(observations.flatMap(o => o.payload.topics))]);
  const locale = sourceByRef(db, source.sourceRef)?.locale ?? "unknown";
  const source_digest = marketDigest({ work: mapping.platform_work_ref, original_title: mapping.original_title, source_ref: source.sourceRef, source_locale: locale });
  return { mapping, source, locale, source_digest };
}
function head(db: RadarDb, work: string, target: ChineseLocale, rev?: number) {
  return db.select().from(marketTitleTranslations).where(and(eq(marketTitleTranslations.workRef, work),
    eq(marketTitleTranslations.targetLocale, target), ...(rev === undefined ? [] : [eq(marketTitleTranslations.revision, rev)])))
    .orderBy(desc(marketTitleTranslations.revision)).get()?.payload ?? null;
}
export function recordTitleTranslation(db: RadarDb, input: {
  work_ref: string; work_revision: number; revision: number; target_locale: ChineseLocale;
  translated_title: string; method: TitleTranslation["method"]; translator_ref: string; key: string; reason?: string;
}, now = new Date()) {
  const work = ref(input.work_ref), target = chineseLocale(input.target_locale), key = ref(input.key);
  const expected = revision(input.revision), work_revision = revision(input.work_revision, 1);
  const translated_title = text(input.translated_title), translator_ref = ref(input.translator_ref);
  if (!["agent", "human"].includes(input.method)) fail("translation_invalid", "Method must be agent or human.");
  const reason = input.reason === undefined ? null : text(input.reason, 1000);
  if (!Number.isFinite(now.getTime())) fail("translation_invalid", "A valid local clock is required.");
  const created_at = now.toISOString();
  const request = marketDigest({ work, work_revision, expected, target, translated_title, method: input.method, translator_ref, reason });
  return db.transaction(tx => {
    const ctx = context(tx, work);
    const prior = tx.select().from(marketTitleTranslations).where(eq(marketTitleTranslations.key, key)).get();
    if (prior) {
      context(tx, prior.workRef);
      if (prior.requestDigest !== request) fail("idempotency_conflict", "Translation key was used for different input.");
      // A replay returns its original receipt; it does not re-apply it to a changed source.
      return { translation: prior.payload, reused: true, source_current: prior.payload.source_digest === ctx.source_digest };
    }
    const previous = head(tx, work, target);
    if (ctx.mapping.mapping_revision !== work_revision || (previous?.revision ?? 0) !== expected) fail("state_conflict", "Read current work and translation revisions before writing.");
    if (previous && !reason) fail("translation_reason_required", "A translation correction requires a reason.");
    if (previous && previous.created_at > created_at) fail("clock_regression", "Translation clock precedes the previous revision.");
    const content: Omit<TitleTranslation, "digest"> = { spec: "radar.title_translation.v1", work_ref: work, work_revision,
      revision: expected + 1, target_locale: target, original_title: ctx.mapping.original_title, source_locale: ctx.locale,
      source_digest: ctx.source_digest, translated_title, method: input.method, translator_ref, review_status: "unreviewed",
      verification: "operator_reported", reason, created_at };
    const translation = { ...content, digest: marketDigest(content) };
    tx.insert(marketTitleTranslations).values({ workRef: work, targetLocale: target, revision: translation.revision,
      key, requestDigest: request, payload: translation }).run();
    return { translation, reused: false, source_current: true };
  }, { behavior: "immediate" });
}
export function readTitleTranslation(db: RadarDb, work: string, language: ChineseLocale, rev?: number) {
  const target = chineseLocale(language);
  if (rev !== undefined) revision(rev, 1);
  const ctx = context(db, work), translation = head(db, work, target, rev);
  if (rev !== undefined && !translation) fail("translation_not_found", "Requested translation revision does not exist.");
  const status = !translation ? "missing" : translation.source_digest === ctx.source_digest ? "current" : "stale";
  return { work_ref: work, work_revision: ctx.mapping.mapping_revision, original_title: ctx.mapping.original_title,
    source_ref: ctx.source.sourceRef, source_locale: ctx.locale, public_url: ctx.source.payload.public_url, origin: ctx.source.payload.origin,
    language: target, status, display_title: status === "current" ? translation!.translated_title : ctx.mapping.original_title,
    translation };
}
export function listChineseReading(db: RadarDb, input: { language: ChineseLocale; source?: string; limit?: number }) {
  const language = chineseLocale(input.language), source = input.source === undefined ? undefined : ref(input.source), limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("translation_invalid", "Limit must be between 1 and 100.");
  return db.transaction(tx => {
    const items: ReturnType<typeof readTitleTranslation>[] = [];
    let omitted = 0;
    // ponytail: reuse the personal mapping-head scan; add a paged projection
    // only if measured personal history makes this bounded display too slow.
    for (const mapping of listWorkMappings(tx)) {
      let item;
      try { item = readTitleTranslation(tx, mapping.platform_work_ref, language); }
      catch (error) {
        if (error instanceof MarketStoreError && ["content_blocked", "translation_source_missing"].includes(error.code)) { omitted++; continue; }
        throw error;
      }
      if (!source || item.source_ref === source) items.push(item);
    }
    return { spec: "radar.chinese_reading.v1", language, items: items.slice(0, limit), truncated: items.length > limit, omitted,
      limitations: ["Submitted translations are unreviewed reading aids, not official titles or independent evidence.",
        "Missing or stale translations fall back to the original title; no model or network call is performed."] };
  });
}
