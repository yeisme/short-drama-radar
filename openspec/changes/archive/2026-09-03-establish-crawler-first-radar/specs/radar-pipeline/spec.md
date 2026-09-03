# radar-pipeline Specification

## ADDED Requirements

### Requirement: Four-layer collection with loud degradation

The system SHALL collect candidates through ordered layers: Layer 0 public pages via self-hosted Firecrawl, Layer 1 platform backend CLIs (agent-reach xiaohongshu, douyin signed API), Layer 2 Playwright browser fallback, Layer 3 manual import. Any layer failure MUST degrade loudly and tag snapshots with `degraded`; it MUST NOT silently reuse stale data or auto-bypass captcha/risk control.

#### Scenario: Layer 1 backend missing
- **WHEN** the agent-reach xiaohongshu backend is not provisioned
- **THEN** collect still completes from Layer 0 and marks that layer degraded with an explicit error message

#### Scenario: Captcha or risk control encountered
- **WHEN** a browser flow hits a captcha or account risk-control event
- **THEN** that account is circuit-broken for 24h and the pool rotates; if the pool is exhausted the run degrades to Layer 0/3 and alerts

### Requirement: Snapshot and dedup storage

The system SHALL store every raw fetch receipt in SQLite (via Drizzle) and upsert normalized items keyed by (date, platform, content_id), preferring lower layers per content id.

#### Scenario: Same content seen from two layers
- **WHEN** the same content id arrives from Layer 0 and Layer 1 in one run
- **THEN** the daily item keeps the Layer 1 (more authoritative) record and both raw receipts are retained

### Requirement: Scoring v0 with confidence gate

The system SHALL score each daily item as 0.40*spread + 0.25*topic-frequency + 0.20*hook-density + 0.15*emotion-intensity, with all signals normalized 0-100 within (platform, day). Items with confidence below 0.6 MUST NOT enter the card automatically. XHS spread MUST use engagement increments as proxy; play counts MUST NOT be fabricated.

#### Scenario: XHS item without play count
- **WHEN** a xiaohongshu item has like/collect/comment increments but no play count
- **THEN** its spread signal uses the increment proxy and no play metric is invented

#### Scenario: Low confidence item
- **WHEN** an item scores with confidence 40
- **THEN** it stays in daily_items but is excluded from automatic card entry pending human review

### Requirement: Card contract v1

The system SHALL emit `short-drama-radar.card.v1` payloads containing date, sourceStatus (degraded flag + notes), trends, and separate top.douyin(5) / top.xiaohongshu(5) lists, each item carrying score, confidence, isNew, tags, url, degraded.

#### Scenario: Degraded day card
- **WHEN** any item for the day was collected in degraded mode
- **THEN** the card payload sets sourceStatus.degraded=true and lists human-readable notes

### Requirement: Integration test evidence

Every integration/component/e2e run SHALL write redacted evidence under `temp/integration-test-runs/<run-id>/` with summary.json, command.txt, stdout.log, stderr.log, env.json, artifacts/, and SHALL exit with the original exit code.

#### Scenario: Failing integration test
- **WHEN** a wrapped test command exits non-zero
- **THEN** the evidence directory contains all six required artifacts and the wrapper exits with the same non-zero code
