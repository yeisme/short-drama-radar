// Adapter contract. Every fetch layer returns RawItem lists plus a health
// report; failures must degrade, never throw away the run silently.
export interface RawItem {
  platform: "douyin" | "xiaohongshu";
  contentId: string;
  title: string;
  url: string;
  authorId?: string;
  authorName?: string;
  publishedAt?: string;
  metrics: Record<string, number>;
  confidence: number; // 0-100, adapter-reported data quality
}

export interface FetchResult {
  source: string;
  layer: number;
  items: RawItem[];
  degraded: boolean;
  errors: string[];
}

export interface Adapter {
  name: string;
  layer: number;
  platform: "douyin" | "xiaohongshu" | "both";
  fetch(ctx: AdapterContext): Promise<FetchResult>;
}

export interface AdapterContext {
  firecrawlBaseUrl: string;
  agentReachBin: string;
  timeoutMs: number;
  fixtureDir?: string; // tests inject fixtures here; live runs leave it empty
  accountsPath?: string; // Layer 2 account pool descriptor file (user-level, no credentials)
}

export function emptyResult(name: string, layer: number, errors: string[]): FetchResult {
  return { source: name, layer, items: [], degraded: errors.length > 0, errors };
}
