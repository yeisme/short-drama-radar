import { expect, test } from "bun:test";
import { candidateInput, cleanText, countsInput, evaluateExperiment, instant, publicUrl,
  type DecisionExperiment, type DecisionResult } from "../../src/decision/domain.ts";

const experiment = { plan: { sample_per_arm: 32, min_lift_pp: 15, max_completion_drop_pp: 10, max_failure_percent: 10 } } as DecisionExperiment;
const result = () => ({ origin: "manual", measurement: "observed", quality: "comparable",
  treatment: { assigned: 32, continued: 22, completed: 24, technical_failures: 0 },
  control: { assigned: 32, continued: 16, completed: 24, technical_failures: 0 },
}) as DecisionResult;

test("behavioral gate uses the assigned denominator and completion guardrail", () => {
  expect(evaluateExperiment(experiment, null).verdict).toBe("pending");
  expect(evaluateExperiment(experiment, result())).toMatchObject({ verdict: "directional_support", lift_pp: 18.75 });
  const lowCompletion = result(); lowCompletion.treatment.completed = 20;
  expect(evaluateExperiment(experiment, lowCompletion).verdict).toBe("no_advantage");
  const tied = result(); tied.treatment.continued = 16;
  expect(evaluateExperiment(experiment, tied).verdict).toBe("no_advantage");
  // An early continuation is not necessarily a completed first episode.
  expect(countsInput({ assigned: 32, continued: 22, completed: 10, technical_failures: 0 }).continued).toBe(22);
});

test("fixture, intent, undersampling, zero denominators and excess failures cannot pass", () => {
  const cases = [
    { ...result(), origin: "fixture" }, { ...result(), measurement: "intent" },
    { ...result(), quality: "not_comparable" },
    { ...result(), treatment: { assigned: 31, continued: 22, completed: 24, technical_failures: 0 } },
    { ...result(), treatment: { assigned: 0, continued: 0, completed: 0, technical_failures: 0 } },
    { ...result(), control: { assigned: 32, continued: 16, completed: 24, technical_failures: 4 } },
  ];
  for (const sample of cases) expect(evaluateExperiment(experiment, sample as DecisionResult).verdict).toBe("inconclusive");
});

test("rejects malformed counts, timestamps, credential material and unsafe references", () => {
  for (const bad of [-1, 1.5, NaN, Infinity, 33]) {
    expect(() => countsInput({ assigned: 32, continued: bad, completed: 0, technical_failures: 0 })).toThrow();
  }
  expect(() => instant("2026-02-30T00:00:00Z", "observed_at")).toThrow();
  for (const bad of ["Authorization: Bearer synthetic-private-value", "password=synthetic-private-value", "line\nnext", "\u001b[31mred"]) {
    expect(() => cleanText(bad, "note")).toThrow();
  }
  for (const bad of ["https://user:pass@example.com/", "https://example.com/?access_token=example", "file:///etc/passwd", "https://example.com/#private"]) {
    expect(() => publicUrl(bad)).toThrow();
  }
  expect(publicUrl("https://example.com/story?title_no=42")).toBe("https://example.com/story?title_no=42");
});

test("candidate parsing normalizes locale and validates market and references", () => {
  const c = { ref: "en-a", name: "An original direction", market: "US", locale: "en-us", audience: "Adults",
    hypothesis: "A testable hypothesis", rationale: "A reason", risk: "A risk", falsifier: "A counter-result",
    cost_note: "Unknown pending quote", evidence_refs: ["e1", "e1"] };
  expect(candidateInput(c)).toMatchObject({ locale: "en-US", evidence_refs: ["e1"] });
  expect(() => candidateInput({ ...c, market: "United States" })).toThrow();
  expect(() => candidateInput({ ...c, evidence_refs: [] })).toThrow();
});
