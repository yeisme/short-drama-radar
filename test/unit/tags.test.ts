import { describe, expect, test } from "bun:test";
import { tagContent } from "../../src/pipeline/tags.ts";

describe("tagContent", () => {
  test("detects hooks, topics and emotions from a revenge title", () => {
    const tags = tagContent("赘婿逆袭打脸全场，前妻跪求复合");
    expect(tags.hooks).toContain("identity_reversal");
    expect(tags.hooks).toContain("face_slap");
    expect(tags.topics).toContain("revenge");
    expect(tags.emotions).toContain("satisfaction");
    expect(tags.emotionIntensity).toBeGreaterThan(1);
  });

  test("no signal means intensity floor 1", () => {
    const tags = tagContent("今日更新");
    expect(tags.hooks).toEqual([]);
    expect(tags.emotions).toEqual([]);
    expect(tags.emotionIntensity).toBe(1);
  });
});
