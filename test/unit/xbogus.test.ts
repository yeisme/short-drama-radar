import { describe, expect, test } from "bun:test";
import { generateXBogus, signUrl, DOUYIN_WEB_UA } from "../../src/adapters/xbogus.ts";

// Vectors generated from the reference Python implementation (Evil0ctal
// Douyin_TikTok_Download_API) with time frozen at 1759459200.
describe("generateXBogus (reference vectors)", () => {
  test("matches reference output for a full search query", () => {
    const query =
      "device_platform=webapp&aid=6383&channel=global&keyword=%E7%9F%AD%E5%89%A7&search_source=normal_search&offset=0&count=10&cookie_enabled=true&platform=PC&downlink=10";
    expect(generateXBogus(query, DOUYIN_WEB_UA, 1759459200)).toBe("DFSzswVYP8hANxu0C9Frae9WX7nN");
  });

  test("matches reference output for a short query and another UA", () => {
    const query = "device_platform=webapp&aid=6383&keyword=test&count=20&cookie_enabled=true&platform=PC&downlink=10";
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(generateXBogus(query, ua, 1759459200)).toBe("DFSzswVYsdkANVokC9Frae9WX7n6");
  });

  test("output shape is the canonical 28 chars", () => {
    const xb = generateXBogus("aid=6383&keyword=x&count=10&cookie_enabled=true&platform=PC&downlink=10", DOUYIN_WEB_UA, 1759459200);
    expect(xb).toHaveLength(28);
    expect(xb).toMatch(/^[A-Za-z0-9\/+=-]+$/);
  });

  test("deterministic for identical inputs; changes with time", () => {
    const q = "aid=6383&keyword=x&count=10&cookie_enabled=true&platform=PC&downlink=10";
    expect(generateXBogus(q, DOUYIN_WEB_UA, 1000)).toBe(generateXBogus(q, DOUYIN_WEB_UA, 1000));
    expect(generateXBogus(q, DOUYIN_WEB_UA, 1000)).not.toBe(generateXBogus(q, DOUYIN_WEB_UA, 1001));
  });

  test("signUrl appends the X-Bogus parameter", () => {
    const signed = signUrl("aid=6383&keyword=x", DOUYIN_WEB_UA, 1759459200);
    expect(signed).toMatch(/&X-Bogus=[A-Za-z0-9+/=-]{28}$/);
  });
});
