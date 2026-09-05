## MODIFIED Requirements

### Requirement: Four-layer collection with loud degradation

The system SHALL collect candidates through ordered layers: Layer 0 public pages via self-hosted Firecrawl, Layer 1 platform backend CLIs (agent-reach xiaohongshu, douyin signed API), Layer 2 Playwright browser fallback, Layer 3 manual import via `radar import --csv`. Any layer failure MUST degrade loudly and tag snapshots with `degraded`; it MUST NOT silently reuse stale data or auto-bypass captcha/risk control.

Layer 2 login material and proxy descriptors SHALL resolve from the user-level secret store (`~/.config/short-drama-radar/secrets/<ref>.json`, mode 0600, overridable via `RADAR_SECRETS_DIR`) BEFORE any browser launch: a missing credential or proxy descriptor is a loud degradation naming the ref and the fix — an account MUST NOT run in an anonymous context, and a configured proxy MUST NOT silently fall back to a direct connection. Secret file contents MUST NOT enter logs, evidence, errors or the database. Layer 2 extraction is a degraded fallback by design: it yields no engagement metrics (`metrics: {}`) and caps confidence at 50; it MUST NOT fabricate numbers.

#### Scenario: Layer 1 backend missing
- **WHEN** the agent-reach xiaohongshu backend is not provisioned
- **THEN** collect still completes from Layer 0 and marks that layer degraded with an explicit error message

#### Scenario: Captcha or risk control encountered
- **WHEN** a browser flow hits a captcha or account risk-control event
- **THEN** that account is circuit-broken for 24h and the pool rotates; if the pool is exhausted the run degrades to Layer 0/3 and alerts

#### Scenario: Manual CSV import
- **WHEN** the user runs `radar import --csv <path>` with required columns platform,title,url
- **THEN** valid rows are stored as Layer 3 items (confidence 50, degraded), bad rows are rejected with line number and reason, the whole run goes through the same dedupe/authority path as other layers, and a kind=import receipt is recorded

#### Scenario: Account credential not provisioned
- **WHEN** a Layer 2 account's credentialRef has no storageState file in the secret store
- **THEN** the browser adapter degrades loudly with the ref and the exact export command; no anonymous browser context is launched for that account

#### Scenario: Proxy descriptor not provisioned
- **WHEN** an account declares a proxyRef whose descriptor file is absent
- **THEN** the browser adapter degrades loudly instead of launching a direct connection that would break the fixed account↔proxy pairing
