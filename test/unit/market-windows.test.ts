import { expect, test } from "bun:test";
import { openDb } from "../../src/db/client.ts";
import { initializeMarket, readSettings, updateSettings } from "../../src/market/sources.ts";
import { previousMarketWindow } from "../../src/market/calendar.ts";
import { buildMarketBrief } from "../../src/market/brief.ts";

test("consecutive daily windows stay contiguous across daylight-saving transitions", () => {
  const zone = "America/New_York";
  // 2026-03-08 is the spring-forward date; windows around it must neither
  // overlap nor leave a gap, and day length follows the real clock.
  const windows = ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]
    .map(date => previousMarketWindow(zone, "day", new Date(date + "T12:00:00Z")));
  // Ascending query dates yield descending windows: each window's start is
  // exactly the next day's window end, proving no overlap and no gap.
  for (let i = 0; i + 1 < windows.length; i++) {
    expect(windows[i + 1].start).toBe(windows[i].end);
    expect(Date.parse(windows[i].start)).toBeLessThan(Date.parse(windows[i].end));
  }
  const hours = (window: { start: string; end: string }) => (Date.parse(window.end) - Date.parse(window.start)) / 3600000;
  expect(hours(windows[2])).toBe(23); // the local day containing spring forward
  expect(hours(windows[1])).toBe(24);
  const autumn = previousMarketWindow(zone, "day", new Date("2026-11-02T12:00:00Z"));
  const dayBefore = previousMarketWindow(zone, "day", new Date("2026-11-01T12:00:00Z"));
  expect(hours(autumn)).toBe(25); // fall back
  expect(autumn.start).toBe(dayBefore.end);
});

test("consecutive weekly windows stay contiguous across year boundaries", () => {
  const first = previousMarketWindow("UTC", "week", new Date("2026-01-05T12:00:00Z"));
  const second = previousMarketWindow("UTC", "week", new Date("2025-12-29T12:00:00Z"));
  expect(first.start).toBe(second.end);
  expect(Date.parse(second.start)).toBeLessThan(Date.parse(second.end));
});

test("UTC is the explicit default and an IANA change moves future windows", () => {
  const db = openDb(":memory:");
  try {
    initializeMarket(db);
    expect(readSettings(db)).toMatchObject({ timezone: "UTC" });
    const brief = buildMarketBrief(db, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z", new Date("2026-09-11T08:00:00Z"));
    expect(brief.brief.timezone).toBe("UTC");
    updateSettings(db, 1, { timezone: "Asia/Shanghai" });
    expect(readSettings(db).timezone).toBe("Asia/Shanghai");
    expect(() => updateSettings(db, 2, { timezone: "not-a-zone" })).toThrow("IANA timezone");
    expect(previousMarketWindow("Asia/Shanghai", "day", new Date("2026-09-11T01:00:00Z")).end)
      .toBe("2026-09-10T16:00:00.000Z");
  } finally { db.$client.close(); }
});
