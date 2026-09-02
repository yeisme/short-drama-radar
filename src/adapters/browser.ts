import { emptyResult, type Adapter, type AdapterContext, type FetchResult, type RawItem } from "./types.ts";
import { AccountPool, type AccountPlatform, type PoolAccount } from "../accounts/pool.ts";

// Layer 2: Playwright browser fallback with fixed account↔proxy pairing,
// least-recently-used rotation, a daily quota, and a 24h circuit breaker on
// captcha/risk control. The playwright module is optional at runtime (no hard
// dependency): when it is missing, or the pool has no usable account, the
// adapter degrades loudly instead of guessing. Credentials never enter this
// file — the browser context reads them from the user secret store via the
// account's credentialRef at flow time.

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
async function launchPlaywright(account: PoolAccount): Promise<BrowserSession> {
  const mod = "playwright";
  let chromium: { launch(opts: Record<string, unknown>): Promise<unknown> };
  try {
    const imported = (await import(/* webpackIgnore: true */ mod)) as { chromium: { launch(opts: Record<string, unknown>): Promise<unknown> } };
    chromium = imported.chromium;
  } catch {
    throw new BrowserUnavailableError(PLAYWRIGHT_INSTALL_HINT);
  }
  const launchOpts: Record<string, unknown> = { headless: true };
  if (account.proxyRef) launchOpts["proxy"] = { server: account.proxyRef }; // opaque ref resolved by secret store in production flows
  const browser = (await chromium.launch(launchOpts)) as Browser;
  return {
    async collect(platform: AccountPlatform, timeoutMs: number) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      try {
        await page.goto(platform === "douyin" ? "https://www.douyin.com/hot" : "https://www.xiaohongshu.com/explore", {
          timeout: timeoutMs,
          waitUntil: "domcontentloaded",
        });
        const html = await page.content();
        const riskControl = RISK_MARKERS.some((m) => html.includes(m));
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
}

const RISK_MARKERS = ["验证码", "滑块", "请完成验证", "captcha", "verify_url", "sec-sdk"];

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
      const quota = deps.dailyQuota ?? 200;
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
