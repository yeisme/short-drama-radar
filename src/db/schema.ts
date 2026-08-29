import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Raw fetch receipts. One row per adapter item per fetch attempt.
export const rawSnapshots = sqliteTable("raw_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  platform: text("platform").notNull(), // douyin | xiaohongshu
  layer: integer("layer").notNull(), // 0 public, 1 backend cli, 2 browser, 3 manual
  source: text("source").notNull(), // adapter name, e.g. firecrawl, agent-reach-xhs
  contentId: text("content_id").notNull(),
  title: text("title").notNull().default(""),
  url: text("url").notNull().default(""),
  authorId: text("author_id").notNull().default(""),
  authorName: text("author_name").notNull().default(""),
  publishedAt: text("published_at").notNull().default(""),
  metricsJson: text("metrics_json").notNull().default("{}"), // raw metrics snapshot
  payloadHash: text("payload_hash").notNull().default(""),
  confidence: integer("confidence").notNull().default(60), // 0-100
  degraded: integer("degraded").notNull().default(0), // 0|1
  fetchedAt: text("fetched_at").notNull(),
});

// Normalized per-day items, deduped by (date, platform, content_id).
export const dailyItems = sqliteTable("daily_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD
  platform: text("platform").notNull(),
  contentId: text("content_id").notNull(),
  title: text("title").notNull().default(""),
  url: text("url").notNull().default(""),
  authorId: text("author_id").notNull().default(""),
  publishedAt: text("published_at").notNull().default(""),
  metricsJson: text("metrics_json").notNull().default("{}"),
  tagsJson: text("tags_json").notNull().default("{}"), // hook/topic/emotion tags
  score: integer("score").notNull().default(0), // 0-100
  confidence: integer("confidence").notNull().default(0), // 0-100
  isNew: integer("is_new").notNull().default(0), // first seen yesterday->today window
  degraded: integer("degraded").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

// Pipeline run receipts, written only by the CLI.
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), // run-<timestamp>
  kind: text("kind").notNull(), // collect | score | card | daily
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull().default(""),
  status: text("status").notNull().default("ok"), // ok | degraded | failed
  summaryJson: text("summary_json").notNull().default("{}"),
});
