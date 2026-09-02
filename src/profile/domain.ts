import { createHash } from "node:crypto";

// radar.personal_profile.v1 — the versioned personal-preference contract.
// Validation fails closed: unknown keys, wrong types and out-of-range values
// are rejected instead of silently coerced.

export const PROFILE_SPEC = "radar.personal_profile.v1" as const;

export interface WeightedTag {
  tag: string;
  weight: number; // 0-100
}

export interface ProfileRange {
  min: number;
  max: number;
}

export type BudgetBand = "micro" | "lean" | "standard" | "premium";

export interface PersonalProfileV1 {
  spec: typeof PROFILE_SPEC;
  genres: WeightedTag[];
  topics: WeightedTag[];
  audiences: WeightedTag[];
  platforms: WeightedTag[];
  formats: WeightedTag[];
  hooks: WeightedTag[];
  emotions: WeightedTag[];
  languages: WeightedTag[];
  budget_band: BudgetBand;
  risk_tolerance: number; // 0-100
  blocked_topics: string[];
  available_asset_tags: string[];
  episode_length_seconds: ProfileRange;
  minimum_fit: number; // 0-100, default 65
  minimum_confidence: number; // 0-100, default 60
}

const WEIGHTED_KEYS = ["genres", "topics", "audiences", "platforms", "formats", "hooks", "emotions", "languages"] as const;
const TAG_KEYS = ["blocked_topics", "available_asset_tags"] as const;
const BUDGET_BANDS = ["micro", "lean", "standard", "premium"] as const;

export function defaultProfile(name = "default"): PersonalProfileV1 {
  return {
    spec: PROFILE_SPEC,
    genres: [],
    topics: [],
    audiences: [],
    platforms: [],
    formats: [],
    hooks: [],
    emotions: [],
    languages: [{ tag: "zh", weight: 100 }],
    budget_band: "lean",
    risk_tolerance: 40,
    blocked_topics: [],
    available_asset_tags: [],
    episode_length_seconds: { min: 60, max: 180 },
    minimum_fit: 65,
    minimum_confidence: 60,
  };
}

export interface ValidationOutcome {
  ok: boolean;
  problems: string[];
}

export function validateProfile(value: unknown): ValidationOutcome {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return { ok: false, problems: ["profile is not an object"] };
  const p = value as Record<string, unknown>;
  if (p["spec"] !== PROFILE_SPEC) problems.push(`spec must be '${PROFILE_SPEC}'`);

  const allowed = new Set<string>(["spec", ...WEIGHTED_KEYS, ...TAG_KEYS, "budget_band", "risk_tolerance", "episode_length_seconds", "minimum_fit", "minimum_confidence"]);
  for (const key of Object.keys(p)) {
    if (!allowed.has(key)) problems.push(`unknown field '${key}'`);
  }

  for (const key of WEIGHTED_KEYS) {
    const result = validateWeighted(p[key], key);
    problems.push(...result);
  }
  for (const key of TAG_KEYS) {
    const v = p[key];
    if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || t.length === 0 || t.length > 60)) {
      problems.push(`${key} must be an array of short non-empty strings`);
    }
  }
  if (!BUDGET_BANDS.includes(p["budget_band"] as BudgetBand)) problems.push(`budget_band must be one of ${BUDGET_BANDS.join("|")}`);
  if (!isRange(p["risk_tolerance"], 0, 100)) problems.push("risk_tolerance must be an integer 0-100");
  if (!isRange(p["minimum_fit"], 0, 100)) problems.push("minimum_fit must be an integer 0-100");
  if (!isRange(p["minimum_confidence"], 0, 100)) problems.push("minimum_confidence must be an integer 0-100");

  const range = p["episode_length_seconds"];
  if (typeof range !== "object" || range === null || typeof (range as ProfileRange)["min"] !== "number" || typeof (range as ProfileRange)["max"] !== "number" || (range as ProfileRange)["min"] > (range as ProfileRange)["max"] || Object.keys(range).some((k) => !["min", "max"].includes(k))) {
    problems.push("episode_length_seconds must be {min,max} with min <= max");
  }

  return { ok: problems.length === 0, problems };
}

function validateWeighted(v: unknown, key: string): string[] {
  if (!Array.isArray(v)) return [`${key} must be an array`];
  const problems: string[] = [];
  v.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`${key}[${i}] must be {tag, weight}`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e);
    if (keys.some((k) => !["tag", "weight"].includes(k))) problems.push(`${key}[${i}] has unknown fields`);
    if (typeof e["tag"] !== "string" || e["tag"].length === 0 || e["tag"].length > 60) problems.push(`${key}[${i}].tag must be a short non-empty string`);
    if (typeof e["weight"] !== "number" || !Number.isInteger(e["weight"]) || e["weight"] < 0 || e["weight"] > 100) problems.push(`${key}[${i}].weight must be an integer 0-100`);
  });
  return problems;
}

function isRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// Canonical digest: sorted-key JSON, so equal profiles always digest equal.
export function profileDigest(profile: PersonalProfileV1): string {
  const canonical = JSON.stringify(sortKeysDeep(profile));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}
