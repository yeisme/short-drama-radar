import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Adapter, FetchResult, RawItem } from "./types.ts";
import { emptyResult } from "./types.ts";

// Layer 3 manual import: a UTF-8 CSV (RFC 4180 subset — quoted fields with
// "" escapes, comma delimiter, CRLF tolerated, BOM stripped). Header row is
// required; `platform,title,url` are mandatory columns, everything else is
// optional. Bad rows are reported with their line number and never dropped
// silently; confidence is capped at 50 because a human-transcribed source is
// an explicit degraded fallback (Layer 3), never first-class evidence.

const REQUIRED_COLUMNS = ["platform", "title", "url"] as const;
const NUMERIC_COLUMNS: Record<string, string> = {
  likes: "liked_count",
  comments: "comment_count",
  collects: "collected_count",
  shares: "share_count",
};

export interface ManualImportResult extends FetchResult {
  badRows: Array<{ row: number; reason: string }>;
}

export function parseImportCsv(text: string): { items: RawItem[]; badRows: Array<{ row: number; reason: string }>; header: string[] } {
  const clean = text.replace(/^﻿/, "");
  const rows = parseCsvRows(clean);
  if (rows.length === 0) return { items: [], badRows: [], header: [] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  for (const required of REQUIRED_COLUMNS) {
    if (!header.includes(required)) {
      throw new Error(`missing required column '${required}' (header: ${header.join(",")})`);
    }
  }
  const col = (name: string) => header.indexOf(name);
  const items: RawItem[] = [];
  const badRows: Array<{ row: number; reason: string }> = [];
  for (let i = 1; i < rows.length; i++) {
    const rowNumber = i + 1; // 1-based, counting the header row
    const cells = rows[i]!;
    const get = (name: string) => {
      const idx = col(name);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const platform = get("platform").toLowerCase();
    const title = get("title");
    const url = get("url");
    if (platform !== "douyin" && platform !== "xiaohongshu") {
      badRows.push({ row: rowNumber, reason: `invalid platform '${get("platform")}' (expected douyin|xiaohongshu)` });
      continue;
    }
    if (!title) {
      badRows.push({ row: rowNumber, reason: "empty title" });
      continue;
    }
    if (!url) {
      badRows.push({ row: rowNumber, reason: "empty url" });
      continue;
    }
    const metrics: Record<string, number> = {};
    let metricError: string | null = null;
    for (const [csvName, metricKey] of Object.entries(NUMERIC_COLUMNS)) {
      const raw = get(csvName);
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        metricError = `column '${csvName}' must be a non-negative integer, got '${raw}'`;
        break;
      }
      metrics[metricKey] = value;
    }
    if (metricError) {
      badRows.push({ row: rowNumber, reason: metricError });
      continue;
    }
    const publishedRaw = get("publishedat");
    let publishedAt: string | undefined;
    if (publishedRaw) {
      const parsed = normalizeDate(publishedRaw);
      if (!parsed) {
        badRows.push({ row: rowNumber, reason: `column 'publishedAt' is not ISO date or epoch ms, got '${publishedRaw}'` });
        continue;
      }
      publishedAt = parsed;
    }
    const contentIdRaw = get("contentid");
    const contentId = contentIdRaw || `manual-${createHash("sha256").update(`${platform}:${url}`).digest("hex").slice(0, 20)}`;
    items.push({
      platform,
      contentId,
      title,
      url,
      authorName: get("author") || undefined,
      publishedAt,
      metrics,
      confidence: 50,
    });
  }
  return { items, badRows, header };
}

function normalizeDate(raw: string): string | null {
  if (/^\d{13,}$/.test(raw)) {
    const ms = Number(raw);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

// Minimal RFC 4180 row splitter: quoted fields, "" escape, CRLF tolerance.
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

export function makeManualImportAdapter(csvPath: string): Adapter {
  return {
    name: "manual-import",
    layer: 3,
    platform: "both",
    async fetch(): Promise<FetchResult> {
      let text: string;
      try {
        text = readFileSync(csvPath, "utf8");
      } catch (err) {
        return emptyResult("manual-import", 3, [`cannot read ${csvPath}: ${(err as Error).message}`]);
      }
      let parsed: ReturnType<typeof parseImportCsv>;
      try {
        parsed = parseImportCsv(text);
      } catch (err) {
        return emptyResult("manual-import", 3, [(err as Error).message]);
      }
      const errors = parsed.badRows.map((b) => `row ${b.row}: ${b.reason}`);
      // Rows with no metrics at all are still honest candidates, but the
      // import layer degrades loudly whenever anything was rejected.
      return {
        source: "manual-import",
        layer: 3,
        items: parsed.items,
        degraded: parsed.badRows.length > 0,
        errors,
      };
    },
  };
}
