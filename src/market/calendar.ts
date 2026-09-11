import { MarketStoreError } from "./repository.ts";

// Search for local date boundaries rather than subtracting 24-hour durations:
// a civil day can contain 23 or 25 hours across daylight-saving transitions.
export function previousMarketWindow(timezone: string, period: "day" | "week", now = new Date()) {
  if (!Number.isFinite(now.getTime()) || !["day", "week"].includes(period)) throw new MarketStoreError("window_invalid", "Provide a valid clock and calendar period.");
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { throw new MarketStoreError("timezone_invalid", "Use a supported IANA timezone."); }
  const dateAt = (at: number) => {
    const parts = formatter.formatToParts(at);
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const today = new Date(dateAt(now.getTime()) + "T00:00:00.000Z");
  const endDate = new Date(today);
  if (period === "week") endDate.setUTCDate(endDate.getUTCDate() - (endDate.getUTCDay() + 6) % 7);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - (period === "week" ? 7 : 1));
  const boundary = (date: Date) => {
    const target = date.toISOString().slice(0, 10);
    let low = date.getTime() - 36 * 3600_000, high = date.getTime() + 36 * 3600_000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (dateAt(mid) < target) low = mid + 1;
      else high = mid;
    }
    if (dateAt(low) !== target) throw new MarketStoreError("calendar_date_unavailable", "Requested local calendar date does not exist in this timezone.");
    return new Date(low).toISOString();
  };
  return { start: boundary(startDate), end: boundary(endDate) };
}
