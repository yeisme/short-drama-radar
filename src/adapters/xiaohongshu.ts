import { emptyResult, type Adapter } from "./types.ts";

// Layer 1 (xiaohongshu): shell out to the agent-reach selected backend
// (OpenCLI / xhs-cli / xiaohongshu-mcp, chosen by `agent-reach doctor`).
// Cookie/login material stays inside agent-reach user-level config; this
// adapter never sees or stores credentials.
export const xiaohongshuBackendAdapter: Adapter = {
  name: "agent-reach-xhs",
  layer: 1,
  platform: "xiaohongshu",
  async fetch() {
    return emptyResult("agent-reach-xhs", 1, [
      "Layer 1 backend not provisioned yet: run `agent-reach install --channels=xiaohongshu` and configure login state; radar falls back to Layer 0 today.",
    ]);
  },
};

// Layer 1 (douyin): signed internal API layer (X-Bogus etc.), inspired by the
// data flow of open-source parsers but implemented natively. Intentionally a
// degraded stub until the signer is implemented and verified; Layer 0 remains
// the production douyin source meanwhile.
export const douyinSignedAdapter: Adapter = {
  name: "douyin-signed-api",
  layer: 1,
  platform: "douyin",
  async fetch() {
    return emptyResult("douyin-signed-api", 1, [
      "douyin signed API layer not implemented yet; radar falls back to Layer 0 today.",
    ]);
  },
};

// Layer 2: per-account Playwright flows with account-pool rotation and
// circuit breaking. Placeholder until flows land; never silently bypasses
// captcha/risk control — it degrades instead.
export const browserFallbackAdapter: Adapter = {
  name: "playwright-browser",
  layer: 2,
  platform: "both",
  async fetch() {
    return emptyResult("playwright-browser", 2, ["Playwright fallback flows not implemented yet."]);
  },
};
