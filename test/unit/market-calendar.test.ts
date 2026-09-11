import { expect, test } from "bun:test";
import { previousMarketWindow } from "../../src/market/calendar.ts";

test("previous complete day follows local date rather than UTC date", () => {
  expect(previousMarketWindow("Asia/Shanghai", "day", new Date("2026-09-11T01:00:00Z"))).toEqual({
    start: "2026-09-09T16:00:00.000Z", end: "2026-09-10T16:00:00.000Z",
  });
});
test("DST spring and autumn days retain their 23 and 25 hour boundaries", () => {
  const spring = previousMarketWindow("America/New_York", "day", new Date("2026-03-09T12:00:00Z"));
  expect(spring).toEqual({ start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T04:00:00.000Z" });
  const autumn = previousMarketWindow("America/New_York", "day", new Date("2026-11-02T12:00:00Z"));
  expect(autumn).toEqual({ start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z" });
});
test("previous week is Monday to Monday across year and DST boundaries", () => {
  expect(previousMarketWindow("UTC", "week", new Date("2026-01-01T12:00:00Z"))).toEqual({
    start: "2025-12-22T00:00:00.000Z", end: "2025-12-29T00:00:00.000Z",
  });
  expect(previousMarketWindow("America/New_York", "week", new Date("2026-03-09T12:00:00Z"))).toEqual({
    start: "2026-03-02T05:00:00.000Z", end: "2026-03-09T04:00:00.000Z",
  });
});
test("invalid timezone and skipped local date return explicit errors", () => {
  expect(() => previousMarketWindow("Invalid/Zone", "day")).toThrow("IANA timezone");
  expect(() => previousMarketWindow("UTC", "day", new Date(NaN))).toThrow("valid clock");
  expect(() => previousMarketWindow("Pacific/Apia", "day", new Date("2011-12-30T12:00:00Z"))).toThrow("does not exist");
});
