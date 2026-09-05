import { emptyResult, type Adapter, type AdapterContext, type FetchResult, type RawItem } from "./types.ts";
import { AccountPool, type AccountPlatform, type PoolAccount } from "../accounts/pool.ts";
import { openSecretStore, type SecretStore } from "./secrets.ts";

// Layer 2: Playwright browser fallback with fixed account↔proxy pairing,
// least-recently-used rotation, a daily quota, and a 24h circuit breaker on
// captcha/risk control. Login material (storageState) and proxy descriptors
// resolve from the user secret store (adapters/secrets.ts) BEFORE any
// browser launch — a missing credential or proxy is a loud degradation with
// the exact fix, never an anonymous context or a silent direct connection.
// Capability ceiling, by design: Layer 2 extraction yields no engagement
// metrics (metrics: {}) and caps confidence at 50 — it is a degraded
// fallback, never first-class evidence, and never invents numbers.

export const PLAYWRIGHT_INSTALL_HINT = "bun add playwright (or playwright-core with PLAYWRIGHT_BROWSERS_PATH set)";

export interface BrowserFlowDeps {
  // Overridable for tests: launch a browser and run the platform flow.
  launchBrowser?: (account: PoolAccount) => Promise<BrowserSession>;
  pool?: AccountPool;
  dailyQuota?: number;
  now?: () => Date;
}

export interface BrowserSession {
  collect(platform: AccountPlatform, timeoutMs: number): Promise<{ html: string; riskControl: boolean }>;
  close(): Promise<void>;
}

// Real session: dynamic import so a missing playwright module is a degraded
// result, not a startup crash (and typecheck needs no hard dep).
async function launchPlaywright(account: PoolAccount, store: SecretStore = openSecretStore()): Promise<BrowserSession> {
  // Resolve secret-store material FIRST so a misconfigured account fails
  // before any browser launch (cheap fs checks, no wasted startup).
  const credential = store.credential(account.credentialRef);
  if (!credential) {
    throw new BrowserUnavailableError(
      `credential '${account.credentialRef}' not found in ${store.root} — export a Playwright storageState to ${account.credentialRef}.json (chmod 600)`,
    );
  }
  const launchOpts: Record<string, unknown> = { headless: true };
  // The account↔proxy pairing is fixed: an unresolvable proxyRef is an error,
  // never a silent direct connection (the old code passed the opaque ref
  // itself as the proxy server URL, which could only fail at launch).
  if (account.proxyRef) {
    const proxy = store.proxy(account.proxyRef);
    if (!proxy) {
      throw new BrowserUnavailableError(
        `proxy descriptor '${account.proxyRef}' not found in ${store.root} — add ${account.proxyRef}.json { server: "http://host:port", ... } (credentials never enter the repo)`,
      );
    }
    launchOpts["proxy"] = proxy;
  }
  const mod = "playwright";
  let chromium: { launch(opts: Record<string, unknown>): Promise<unknown> };
  try {
    const imported = (await import(/* webpackIgnore: true */ mod)) as { chromium: { launch(opts: Record<string, unknown>): Promise<unknown> } };
    chromium = imported.chromium;
  } catch {
    throw new BrowserUnavailableError(PLAYWRIGHT_INSTALL_HINT);
  }
  const browser = (await chromium.launch(launchOpts)) as Browser;
  return {
    async collect(platform: AccountPlatform, timeoutMs: number) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: credential.storageState });
      const page = await context.newPage();
      try {
        await page.goto(platform === "douyin" ? "https://www.douyin.com/hot" : "https://www.xiaohongshu.com/explore", {
          timeout: timeoutMs,
          waitUntil: "domcontentloaded",
        });
        const html = await page.content();
        // Challenge detection uses visible challenge elements, the URL and
        // the title — NEVER raw substring matching over the whole page:
        // normal douyin/xhs pages embed captcha/sec-sdk script resources,
        // and a false positive costs the account a 24h cooldown.
        const riskControl = detectRiskControl({
          url: page.url(),
          title: await page.title(),
          visibleMarkers: await page.evaluate(visibleChallengeSelectors, CHALLENGE_SELECTORS),
        });
        return { html, riskControl };
      } finally {
        await context.close();
      }
    },
    async close() {
      await browser.close();
    },
  };
}

interface Browser {
  newContext(opts?: Record<string, unknown>): Promise<BrowserContext>;
  close(): Promise<void>;
}
interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}
interface BrowserPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  title(): Promise<string>;
  evaluate<T>(script: string, arg: string[]): Promise<T>;
}

// Selectors for actually-rendered challenge UI. The probe runs IN the page
// (serialized script string — playwright's evaluate accepts string
// expressions) and keeps only elements that are visible.
const CHALLENGE_SELECTORS = [
  "#captcha-verification",
  ".captcha-container",
  ".secsdk-captcha",
  ".verify-bar",
  "#verify-bar",
  'iframe[src*="captcha"]',
  'iframe[src*="verify"]',
];

const visibleChallengeSelectors = `(selectors) => selectors.filter((selector) => {
  const el = document.querySelector(selector);
  return el !== null && el.offsetParent !== null;
})`;

// Pure decision: a risk-control event is a challenge URL, a challenge title,
// or a visible challenge element. HTML substrings are deliberately ignored.
export function detectRiskControl(signal: { url: string; title: string; visibleMarkers: string[] }): boolean {
  if (/captcha|verify|\/sec\b/i.test(signal.url)) return true;
  if (/验证码|滑块|安全验证|请完成验证/.test(signal.title)) return true;
  return signal.visibleMarkers.length > 0;
}

export function makeBrowserAdapter(platform: AccountPlatform, deps: BrowserFlowDeps = {}): Adapter {
  return {
    name: `playwright-browser-${platform}`,
    layer: 2,
    platform,
    async fetch(ctx: AdapterContext): Promise<FetchResult> {
      // Fixture/offline mode never launches a browser; Layer 2 is skipped
      // with an explicit note so test runs stay hermetic.
      if (ctx.fixtureDir) {
        return emptyResult(`playwright-browser-${platform}`, 2, ["layer 2 skipped in fixture mode (offline run)"]);
      }
      const now = deps.now ?? (() => new Date());
      const quota = deps.dailyQuota ?? ctx.dailyQuotaPerAccount ?? 200;
      let pool = deps.pool;
      if (!pool) {
        const path = ctx.accountsPath ?? defaultPoolPath();
        pool = new AccountPool(path);
      }
      const { account, reason } = pool.rotate(platform, quota, now());
      if (!account) return emptyResult(`playwright-browser-${platform}`, 2, [reason!]);

      const launch = deps.launchBrowser ?? launchPlaywright;
      let session: BrowserSession;
      try {
        session = await launch(account);
      } catch (err) {
        if (err instanceof BrowserUnavailableError) {
          return emptyResult(`playwright-browser-${platform}`, 2, [`playwright runtime unavailable — next step: ${err.hint}`]);
        }
        return emptyResult(`playwright-browser-${platform}`, 2, [`browser launch failed: ${(err as Error).message}`]);
      }

      try {
        const { html, riskControl } = await session.collect(platform, ctx.timeoutMs);
        if (riskControl) {
          // Circuit breaker: 24h cooldown, no auto-bypass — by design.
          pool.trip(account.id, "risk control / captcha detected", now());
          pool.save();
          return emptyResult(`playwright-browser-${platform}`, 2, [
            `risk control hit on ${account.handleMasked}; account cooled down for 24h (no auto-bypass)`,
          ]);
        }
        const items = extractFromHtml(platform, html);
        pool.markUsed(account.id, now());
        pool.save();
        const errors = items.length === 0 ? ["page rendered but no content links matched (layout drift? layer 2 needs a flow update)"] : [];
        return { source: `playwright-browser-${platform}`, layer: 2, items, degraded: items.length === 0, errors };
      } catch (err) {
        pool.markUsed(account.id, now());
        pool.save();
        return emptyResult(`playwright-browser-${platform}`, 2, [`browser flow failed: ${(err as Error).message}`]);
      } finally {
        await session.close().catch(() => {});
      }
    },
  };
}

export class BrowserUnavailableError extends Error {
  constructor(public readonly hint: string) {
    super(hint);
    this.name = "BrowserUnavailableError";
  }
}

function defaultPoolPath(): string {
  const home = process.env.RADAR_HOME ?? `${process.env.HOME ?? "~"}/.short-drama-radar`;
  return `${home}/accounts.json`;
}

// Anchor-pattern extraction, resilient to class-name churn: content links are
// recognized by URL shape, titles from anchor text.
export function extractFromHtml(platform: AccountPlatform, html: string): RawItem[] {
  const pattern =
    platform === "douyin"
      ? /<a[^>]+href="([^"]*douyin\.com\/(?:video|note)\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/g
      : /<a[^>]+href="([^"]*(?:xiaohongshu\.com\/(?:explore|exploration|discovery\/item)\/[0-9a-f]+|xhslink\.com\/\w+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const items: RawItem[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(pattern)) {
    const url = m[1]!.replace(/&amp;/g, "&");
    const title = stripTags(m[2]!).trim();
    const idMatch = platform === "douyin" ? url.match(/\/(?:video|note)\/(\d+)/) : url.match(/\/(?:explore|exploration|discovery\/item)\/([0-9a-f]+)/);
    const contentId = idMatch?.[1];
    if (!contentId || seen.has(contentId)) continue;
    if (title.length < 4) continue;
    seen.add(contentId);
    items.push({
      platform,
      contentId,
      title: title.slice(0, 200),
      url,
      metrics: {},
      // Real page render, but no engagement numbers without an API round trip.
      confidence: 50,
    });
    if (items.length >= 30) break;
  }
  return items;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}
