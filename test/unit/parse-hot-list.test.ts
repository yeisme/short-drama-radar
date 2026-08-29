import { describe, expect, test } from "bun:test";
import { parseHotList } from "../../src/adapters/firecrawl.ts";

describe("parseHotList", () => {
  test("extracts douyin video items and skips user links", async () => {
    const md = await Bun.file(new URL("../fixtures/douyin-hot.md", import.meta.url)).text();
    const items = parseHotList("douyin", md);
    expect(items.length).toBe(5);
    expect(items[0].platform).toBe("douyin");
    expect(items[0].contentId).toBe("7300000000000000001");
    expect(items.every((i) => i.url.includes("douyin.com/video/"))).toBe(true);
    expect(items.every((i) => i.confidence === 40)).toBe(true);
  });

  test("extracts xiaohongshu exploration items", async () => {
    const md = await Bun.file(new URL("../fixtures/xiaohongshu-hot.md", import.meta.url)).text();
    const items = parseHotList("xiaohongshu", md);
    expect(items.length).toBe(4);
    expect(items[0].contentId).toBe("660000000000000001");
  });

  test("empty input yields no items (degraded, not silent)", () => {
    expect(parseHotList("douyin", "anti-bot challenge page")).toEqual([]);
  });
});
