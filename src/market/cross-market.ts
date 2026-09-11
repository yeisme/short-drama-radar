import { eq } from "drizzle-orm";
import type { RadarDb } from "../db/client.ts";
import { marketObservations } from "../db/schema.ts";
import { signalByRef } from "./signals.ts";
import { workMapping } from "./identity.ts";
import { assertMarketContentReadable, marketReadPolicy } from "./policy.ts";
import { MarketStoreError, sourceByRef } from "./repository.ts";

export interface ComparisonSelection { signal_ref: string; revision: number }

// This read deliberately does not calculate a cross-platform score or ratio.
export function crossMarketView(db: RadarDb, left: ComparisonSelection, right: ComparisonSelection) {
  for (const selection of [left, right]) {
    if (!selection || typeof selection.signal_ref !== "string" || !Number.isSafeInteger(selection.revision) || selection.revision < 1) {
      throw new MarketStoreError("comparison_invalid", "Select two stored signal references with positive revisions.");
    }
  }
  return db.transaction(tx => {
    const signals = [left, right].map(selection => {
      const signal = signalByRef(tx, selection.signal_ref, selection.revision);
      if (!signal) throw new MarketStoreError("signal_not_found", "Requested signal revision does not exist.");
      assertMarketContentReadable(tx, signal.topics);
      return signal;
    });
    const sides = signals.map(signal => {
      if (signal.observation_refs.length > 10) throw new MarketStoreError("comparison_too_large", "Select a signal with at most ten observations.");
      const observations = signal.observation_refs.map(ref => {
        const observation = tx.select().from(marketObservations).where(eq(marketObservations.ref, ref)).get()?.payload;
        if (!observation) throw new MarketStoreError("evidence_not_found", "Comparison observation is unavailable.");
        assertMarketContentReadable(tx, observation.topics);
        const source = sourceByRef(tx, observation.source_ref, observation.source_revision);
        if (!source) throw new MarketStoreError("source_not_found", "Comparison source revision is unavailable.");
        return {
          observation_ref: ref, original_title: observation.title, market: observation.market,
          market_evidence_refs: observation.market_evidence_refs, locale: observation.locale,
          observed_at: observation.observed_at, source_published_at: observation.source_published_at,
          source_ref: source.source_ref, source_revision: source.revision, platform: source.platform,
          sampling_scope: source.sampling_scope, publisher_group: source.publisher_group,
          facts: observation.facts, evidence_refs: observation.evidence_refs, origin: observation.origin,
        };
      });
      const mapping = workMapping(tx, signal.subject_ref);
      return { signal_ref: signal.signal_ref, signal_revision: signal.revision, subject_ref: signal.subject_ref,
        title: signal.title, market: signal.market, lifecycle: signal.lifecycle,
        comparison: signal.comparison, observations,
        identity: mapping ? { mapping_status: mapping.mapping_status, mapping_revision: mapping.mapping_revision,
          canonical_work_ref: mapping.canonical_work_ref, evidence_refs: mapping.supporting_evidence_refs }
          : { mapping_status: "unmapped" as const, mapping_revision: null, canonical_work_ref: null, evidence_refs: [] },
      };
    });
    const [a, b] = sides;
    const verified = a.identity.mapping_status === "verified" && b.identity.mapping_status === "verified" &&
      !!a.identity.canonical_work_ref && a.identity.canonical_work_ref === b.identity.canonical_work_ref;
    return {
      spec: "radar.market_cross_market.v1", policy_revision: marketReadPolicy(tx).policy_revision,
      sides, identity_relation: verified ? "verified_same_work" : "not_established",
      presentation: "side_by_side", shared_numeric_axis: false, causal_inference: false,
      limitations: ["Titles and candidate mappings do not establish that two works are identical.",
        "Unknown and global markets remain explicit; language does not establish geography.",
        "Metrics retain their own source, sampling scope, definition, unit and window; no combined popularity score."],
    };
  });
}
