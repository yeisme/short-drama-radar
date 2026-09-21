// radar.reading_judgment.calibration.v1 — the frozen calibration and
// progressive-adoption plan for advisory reading judgments. This capability
// is exploratory: offline contract tests say nothing about real model
// quality, nothing goes live automatically, and every live step needs the
// owner's explicit opt-in. See docs/product/reading-judgment.md (Chinese)
// for the operator-facing version.

export const CALIBRATION_SPEC = "radar.reading_judgment.calibration.v1" as const;
export const READING_JUDGMENT_READINESS = "exploratory" as const;

export interface ReadingJudgmentCalibrationPlan {
  spec: typeof CALIBRATION_SPEC;
  readiness: typeof READING_JUDGMENT_READINESS;
  auto_live: false;
  baseline: {
    kind: "deterministic_order";
    surfaces: ["radar edition build/show", "radar market reading list"];
    note: string;
  };
  holdout: {
    languages: ["zh-Hans", "zh-Hant", "en"];
    calibration_per_language: true;
    shared_items_across_languages: false;
    exploratory_set_size: { min: 20; max: 30 };
    mature: false;
    note: string;
  };
  metrics: readonly [
    "useful_retention_vs_baseline",
    "missed_items_vs_baseline",
    "false_positive_rate",
    "false_negative_rate",
    "abstention_rate",
    "latency_ms",
    "known_usage",
  ];
  reporting: string;
  success_rule: string;
  disable_and_restore: {
    default_mode: "off";
    disable: string;
    restore: string;
    data: string;
  };
  live_canary: string;
}

export const READING_JUDGMENT_CALIBRATION: ReadingJudgmentCalibrationPlan = {
  spec: CALIBRATION_SPEC,
  readiness: READING_JUDGMENT_READINESS,
  auto_live: false,
  baseline: {
    kind: "deterministic_order",
    surfaces: ["radar edition build/show", "radar market reading list"],
    note: "The existing deterministic ranker and reading-list order are the baseline; suggestions are compared against them, never applied over them.",
  },
  holdout: {
    languages: ["zh-Hans", "zh-Hant", "en"],
    calibration_per_language: true,
    shared_items_across_languages: false,
    exploratory_set_size: { min: 20, max: 30 },
    mature: false,
    note: "20-30 labeled items per language are an exploratory starting point only and cannot be marked mature; the calibration set and the holdout set stay separate.",
  },
  metrics: [
    "useful_retention_vs_baseline",
    "missed_items_vs_baseline",
    "false_positive_rate",
    "false_negative_rate",
    "abstention_rate",
    "latency_ms",
    "known_usage",
  ],
  reporting:
    "False positives and false negatives are reported per language (Chinese and English separately); success is measured by useful-item retention and missed items against the baseline, never by the model's self-reported scores or confidence.",
  success_rule:
    "Contract tests passing does not certify effectiveness; promotion beyond exploratory requires owner-reviewed calibration and holdout results recorded in docs/product/reading-judgment.md.",
  disable_and_restore: {
    default_mode: "off",
    disable: "Judgment is off unless a command explicitly passes --mode shadow|assist; no config, schedule, timer or upgrade ever enables it.",
    restore: "Turning it off is simply not passing --mode: every original command, output and canonical state remains unchanged; stored judgment evidence stays read-only history.",
    data: "Disabling or restoring deletes nothing: no user data, feedback, translations or credentials are removed by this capability.",
  },
  live_canary:
    "Any live evaluation needs an explicit owner opt-in with a real transport from the public SDK package, an exact model pin and a visible budget; it is never triggered by upgrades, schedules or read/status commands.",
} as const;
