import { describe, expect, test } from "bun:test";
import { makeFirecrawlAdapter, parseHotList, parsePublicHtml } from "../../src/adapters/firecrawl.ts";

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

  test("reads Firecrawl v1 markdown from data.markdown", async () => {
    const markdown = await Bun.file(new URL("../fixtures/douyin-hot.md", import.meta.url)).text();
    const adapter = makeFirecrawlAdapter("douyin", {
      fetchImpl: async () => new Response(JSON.stringify({ success: true, data: { markdown } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const result = await adapter.fetch({ firecrawlBaseUrl: "http://firecrawl.test", agentReachBin: "agent-reach", timeoutMs: 5_000 });
    expect(result.degraded).toBe(false);
    expect(result.items).toHaveLength(5);
  });

  test("extracts stable IDs from the current douyin public hot-topic URLs", () => {
    const items = parseHotList("douyin", "[短剧反转话题](https://www.douyin.com/hot/2630652/%E7%9F%AD%E5%89%A7)");
    expect(items).toHaveLength(1);
    expect(items[0]!.contentId).toBe("2630652");
  });

  test("falls back to stable links in Firecrawl rawHtml", async () => {
    const rawHtml = `
      <a href="/hot/2630652/%E7%9F%AD%E5%89%A7%E5%8F%8D%E8%BD%AC"><span>短剧反转话题</span></a>
      <a href="/hot/2630652/%E9%87%8D%E5%A4%8D">重复</a>
    `;
    const adapter = makeFirecrawlAdapter("douyin", {
      fetchImpl: async () => new Response(JSON.stringify({ success: true, data: { markdown: "shell", rawHtml } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const result = await adapter.fetch({ firecrawlBaseUrl: "http://firecrawl.test", agentReachBin: "agent-reach", timeoutMs: 5_000 });
    expect(result.items).toEqual([expect.objectContaining({ contentId: "2630652", title: "短剧反转话题", confidence: 40 })]);
  });

  test("extracts xiaohongshu note titles without image-only duplicate anchors", () => {
    const rawHtml = `
      <a class="cover" href="/explore/6a6e51720000000022015f13"><img alt="cover"></a>
      <a class="title" href="/explore/6a6e51720000000022015f13?xsec_token=opaque">短剧钩子拆解</a>
    `;
    expect(parsePublicHtml("xiaohongshu", rawHtml)).toEqual([
      expect.objectContaining({ contentId: "6a6e51720000000022015f13", title: "短剧钩子拆解" }),
    ]);
  });
});
