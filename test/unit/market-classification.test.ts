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
