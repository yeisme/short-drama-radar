## MODIFIED Requirements

### Requirement: Snapshot and dedup storage

The system SHALL store every raw fetch receipt in SQLite (via Drizzle) and upsert normalized items keyed by (date, platform, content_id). For the same content id the record with the highest data authority SHALL win — authority order is Layer 1 (signed API) > Layer 2 (controlled browser) > Layer 3 (manual import) > Layer 0 (public-page scrape) — and the losing observation SHALL fill per-field gaps (metric keys, title, url, author, publishedAt) instead of being discarded. `daily_items.source_layer` SHALL record which layer owns the current metrics, and `degraded` SHALL be recomputed from that owning layer on every upsert; a re-observation that changes nothing SHALL not refresh `updated_at`.

#### Scenario: Same content seen from two layers
- **WHEN** the same content id arrives from Layer 0 and Layer 1 in one run
- **THEN** the daily item keeps the Layer 1 (more authoritative) record — its metrics, confidence and identity fields win — the Layer 0 observation fills any missing fields, and both raw receipts are retained

#### Scenario: Lower-authority re-observation
- **WHEN** a content id already owned by Layer 1 is re-observed by Layer 0 with no metrics
- **THEN** the stored metrics stay owned by Layer 1, `source_layer` is unchanged, and the row is not marked degraded by the Layer 0 pass

#### Scenario: Repeated observation produces engagement deltas
- **WHEN** the same content id is collected again on the same day
- **THEN** the upsert computes `*_delta` engagement increments and `delta_window_hours` against the previously stored observation, and each observation's deltas describe only its own window

### Requirement: Scoring v0 with confidence gate

The system SHALL score each daily item as 0.40*spread + 0.25*topic-frequency + 0.20*hook-density + 0.15*emotion-intensity, with all signals normalized 0-100 within (platform, day). Items with confidence below 0.6 MUST NOT enter the card automatically. XHS spread MUST use engagement increments as proxy; play counts MUST NOT be fabricated. When an observation carries any engagement delta the spread SHALL use the increment basis only (missing deltas count as 0, never mixed with absolute totals); a single-pass observation MAY fall back to absolute totals. The topic-frequency denominator SHALL count only days strictly before the scoring day so same-day re-runs are deterministic; an unseen or untagged topic has frequency 0.

#### Scenario: XHS item without play count
- **WHEN** a xiaohongshu item has like/collect/comment increments but no play count
- **THEN** its spread signal uses the increment proxy and no play metric is invented

#### Scenario: Low confidence item
- **WHEN** an item scores with confidence 40
- **THEN** it stays in daily_items but is excluded from automatic card entry pending human review

#### Scenario: Same-day re-score
- **WHEN** score runs twice for the same platform and day over unchanged data
- **THEN** every stored score, tag and isNew value is identical between runs

### Requirement: Four-layer collection with loud degradation

The system SHALL collect candidates through ordered layers: Layer 0 public pages via self-hosted Firecrawl, Layer 1 platform backend CLIs (agent-reach xiaohongshu, douyin signed API), Layer 2 Playwright browser fallback, Layer 3 manual import via `radar import --csv`. Any layer failure MUST degrade loudly and tag snapshots with `degraded`; it MUST NOT silently reuse stale data or auto-bypass captcha/risk control.

#### Scenario: Layer 1 backend missing
- **WHEN** the agent-reach xiaohongshu backend is not provisioned
- **THEN** collect still completes from Layer 0 and marks that layer degraded with an explicit error message

#### Scenario: Captcha or risk control encountered
- **WHEN** a browser flow hits a captcha or account risk-control event
- **THEN** that account is circuit-broken for 24h and the pool rotates; if the pool is exhausted the run degrades to Layer 0/3 and alerts

#### Scenario: Manual CSV import
- **WHEN** the user runs `radar import --csv <path>` with required columns platform,title,url
- **THEN** valid rows are stored as Layer 3 items (confidence 50, degraded), bad rows are rejected with line number and reason, the whole run goes through the same dedupe/authority path as other layers, and a kind=import receipt is recorded

## ADDED Requirements

### Requirement: Run receipts must cover every execution path

Every pipeline execution SHALL append a run receipt with kind from the vocabulary `collect | score | card | cluster | import | daily`. A combined `radar run` MUST additionally record its collect pass as a kind=collect receipt so card degradation notes and health reports (which read collect receipts) can see those days. Receipt listings and edition lineage SHALL be ordered queries (recency), not unordered slices.

#### Scenario: radar run day inspected later
- **WHEN** the user runs `radar run` and later `radar card` or `radar health`
- **THEN** the day's degraded layers are visible to both readers via the collect receipt
