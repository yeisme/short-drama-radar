import { describe, expect, test } from "bun:test";
import { CALIBRATION_SPEC, READING_JUDGMENT_CALIBRATION, READING_JUDGMENT_READINESS } from "../../src/judgment/calibration.ts";

// radar-reading-judgment-v1 task 1.5 — the calibration and progressive
// adoption plan stays exploratory, per-language, offline-first and fully
// reversible; nothing goes live automatically.

describe("calibration plan", () => {
  test("declares exploratory readiness with no automatic live path", () => {
    expect(READING_JUDGMENT_CALIBRATION.spec).toBe(CALIBRATION_SPEC);
    expect(READING_JUDGMENT_READINESS).toBe("exploratory");
    expect(READING_JUDGMENT_CALIBRATION.readiness).toBe("exploratory");
    expect(READING_JUDGMENT_CALIBRATION.auto_live).toBe(false);
    expect(READING_JUDGMENT_CALIBRATION.live_canary).toMatch(/explicit owner opt-in/i);
    expect(READING_JUDGMENT_CALIBRATION.live_canary).toMatch(/never/i);
  });

  test("fixes the baseline surfaces and keeps false positives/negatives per language", () => {
    expect(READING_JUDGMENT_CALIBRATION.baseline.kind).toBe("deterministic_order");
    expect(READING_JUDGMENT_CALIBRATION.baseline.surfaces).toEqual(["radar edition build/show", "radar market reading list"]);
    expect([...READING_JUDGMENT_CALIBRATION.holdout.languages].sort()).toEqual(["en", "zh-Hans", "zh-Hant"]);
    expect(READING_JUDGMENT_CALIBRATION.holdout.calibration_per_language).toBe(true);
    expect(READING_JUDGMENT_CALIBRATION.holdout.shared_items_across_languages).toBe(false);
    expect(READING_JUDGMENT_CALIBRATION.reporting).toMatch(/per language/);
    expect(READING_JUDGMENT_CALIBRATION.reporting).toMatch(/Chinese and English separately/);
    const metrics = READING_JUDGMENT_CALIBRATION.metrics as readonly string[];
    for (const metric of ["useful_retention_vs_baseline", "missed_items_vs_baseline", "false_positive_rate", "false_negative_rate", "abstention_rate", "latency_ms", "known_usage"]) {
      expect(metrics).toContain(metric);
    }
    // The exploratory set is bounded and explicitly not mature.
    expect(READING_JUDGMENT_CALIBRATION.holdout.exploratory_set_size).toEqual({ min: 20, max: 30 });
    expect(READING_JUDGMENT_CALIBRATION.holdout.mature).toBe(false);
  });

  test("documents disable/restore without touching user data", () => {
    const restore = READING_JUDGMENT_CALIBRATION.disable_and_restore;
    expect(restore.default_mode).toBe("off");
    expect(restore.disable).toMatch(/ever enables it/i);
    expect(restore.restore).toMatch(/unchanged/i);
    expect(restore.data).toMatch(/deletes nothing/i);
  });
});
