import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCatalog } from "../../src/market/catalog.ts";

test.each([
  { source: "hongguo", file: "hongguo.html", format: "html" as const, first: "7574794690361297944" },
  { source: "reelshort", file: "reelshort.html", format: "html" as const, first: "6a5191d8fa9f9f7a09081789" },
  { source: "dramabox", file: "dramabox.md", format: "markdown" as const, first: "42000021382" },
])("extracts stable work IDs and deduplicates links for $source", async ({ source, file, format, first }) => {
  const result = await parseCatalog(source, readFileSync("test/fixtures/market/" + file, "utf8"), format);
  expect(result.status).toBe("parsed");
  expect(result.items).toHaveLength(2);
  expect(result.items[0].id).toBe(first);
  expect(result.items.every(item => !item.url.includes("tracking"))).toBe(true);
  expect(result.items.some(item => item.title.includes("Privacy") || item.title.includes("Spoof"))).toBe(false);
});

test("missing catalog markup is unavailable, not a successful empty catalog", async () => {
  for (const content of ["", "<html>Please log in</html>", "<html>Captcha challenge</html>", "<script>const id=12345</script>"]) {
    expect((await parseCatalog("hongguo", content, "html")).status).toBe("unavailable");
  }
});

test("rejects unregistered parsers and oversized input", async () => {
  expect(parseCatalog("unknown", "", "html")).rejects.toThrow("registered");
  expect(parseCatalog("hongguo", "a".repeat(2_000_001), "html")).rejects.toThrow("2 MB");
});

test("URL credentials, script URLs and similar hosts never become evidence", async () => {
  const html = [
    '<a href="https://user:password@novelquickapp.com/detail?series_id=123456">Credential URL</a>',
    '<a href="http://novelquickapp.com/detail?series_id=123456">Plain HTTP</a>',
    '<a href="javascript:alert(1)">Script link</a>',
    '<a href="https://novelquickapp.com.evil.example/detail?series_id=123456">Wrong host</a>',
  ].join("");
  expect((await parseCatalog("hongguo", html, "html")).items).toEqual([]);
});

test("nested anchor children never pollute localized titles; fully nested anchors keep theirs (M4)", async () => {
  // HTMLRewriter delivers descendant text to the anchor handler too: genre
  // <span>s and episode <p>s used to glue themselves onto ja/ko titles
  // ("Title GenreA Episode free"). The anchor's own text wins; an anchor
  // that nests its whole title still extracts it via the collected-text
  // fallback (reelshort-style card layouts).
  const html = `<html><body><h2>おすすめ</h2>
<a href="/ja/movie/通常の物語-333333333333333333333333">直タイトル <span>ジャンルA</span><p>エピソード</p>無料</a>
<a href="/ja/movie/全ネスト-444444444444444444444444"><span>全ネストの題名</span></a>
<a href="/ja/movie/バッジ-555555555555555555555555">バッジ付き <b>全シリーズ</b></a>
</body></html>`;
  const result = await parseCatalog("reelshort-ja", html, "html");
  expect(result.status).toBe("parsed");
  expect(result.items).toHaveLength(3);
  const titles = result.items.map((item) => item.title);
  expect(titles).toContain("直タイトル 無料");
  expect(titles).toContain("全ネストの題名");
  // The nested suffix alone never carries a title, and nested badges never
  // leak into any extracted title.
  expect(titles.some((t) => t.includes("ジャンルA") || t.includes("エピソード"))).toBe(false);
  expect(titles).toContain("バッジ付き");
});
