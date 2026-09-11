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
