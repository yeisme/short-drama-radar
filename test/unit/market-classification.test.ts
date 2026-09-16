import { expect, test } from "bun:test";
import { classifyLabels } from "../../src/market/classification.ts";

test.each([
  ["zh-CN", "复仇"], ["en-US", "Revenge"], ["es-MX", "Venganza"],
  ["pt-BR", "Vingança"], ["id-ID", "Balas dendam"], ["hi-IN", "बदला"],
])("maps explicit %s platform label without losing the source label", (locale, label) => {
  const result = classifyLabels({ locale, labels: [label] });
  expect(result.topics).toEqual(["revenge"]);
  expect(result.matched[0].label).toBe(label);
  expect(result.mapping_version).toBe("market-label-mapping.v1");
});

test("unknown languages and plot prose are not silently classified", () => {
  expect(classifyLabels({ locale: "unknown", labels: ["revenge"] }).unknown_labels).toEqual(["revenge"]);
  expect(classifyLabels({ locale: "en", labels: ["A story about revenge", "Fantasy"] })).toMatchObject({
    topics: ["fantasy"], unknown_labels: ["A story about revenge"], status: "partial",
  });
  expect(classifyLabels({ locale: "zh", labels: [] }).status).toBe("unknown");
  expect(classifyLabels({ locale: "en", labels: ["constructor"] }).topics).toEqual([]);
});

// Every zh entry below is evidenced by the 2026-09-16 hongguo public category
// sample (hongguo-anchor-layout.v1 tag spans); unmapped labels still stay raw.
test.each([
  ["古装", "period_costume"], ["重生逆袭", "rebirth_comeback"], ["日久生情", "slow_burn_romance"],
  ["都市爱情", "urban_romance"], ["先婚后爱", "marriage_before_love"], ["家庭伦理", "family_ethics"],
])("maps hongguo page-evidenced zh label %s", (label, topic) => {
  const result = classifyLabels({ locale: "zh", labels: [label] });
  expect(result.topics).toEqual([topic]);
  expect(result.mapping_version).toBe("market-label-mapping.v1");
  expect(classifyLabels({ locale: "zh", labels: [label, "页面没写的标签"] })).toMatchObject({
    status: "partial", unknown_labels: ["页面没写的标签"],
  });
});
