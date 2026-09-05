import { describe, expect, test } from "bun:test";
import { backendCommand, normalizeXhsItems, probeXhsBackend, probeXhsReadiness, XHS_MCP_START_COMMAND } from "../../src/adapters/agentreach-xhs.ts";
import { normalizeSearch, searchQuery } from "../../src/adapters/douyin-signed.ts";
import { extractFromHtml, detectRiskControl, makeBrowserAdapter } from "../../src/adapters/browser.ts";
import { AccountPool } from "../../src/accounts/pool.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("probeXhsBackend (agent-reach routing)", () => {
  test("routes by doctor active_backend", async () => {
    const probe = await probeXhsBackend("agent-reach", {
      runJson: async () => ({
        stdout: JSON.stringify({ xiaohongshu: { status: "ok", active_backend: "OpenCLI" } }),
        exitCode: 0,
      }),
    });
    expect(probe.backend).toBe("opencli");
  });

  test("missing backend degrades with the exact install command", async () => {
    const probe = await probeXhsBackend("agent-reach", {
      runJson: async (cmd) => cmd[0] === "mcporter"
        ? { stdout: JSON.stringify({ servers: [] }), exitCode: 0 }
        : {
            stdout: JSON.stringify({
              xiaohongshu: {
                status: "off",
                active_backend: null,
                message: "未安装任何小红书后端。推荐：\n  桌面：agent-reach install --channels opencli\n  （复用 Chrome 登录态）",
              },
            }),
            exitCode: 0,
          },
    });
    expect(probe.backend).toBeNull();
    expect(probe.hint).toContain("agent-reach install");
  });

  test("recognizes a provisioned MCP registration even while its process is offline", async () => {
    const probe = await probeXhsBackend("agent-reach", {
      runJson: async (cmd) => cmd[0] === "mcporter"
        ? {
            stdout: JSON.stringify({ servers: [{ name: "xiaohongshu", transport: "http", baseUrl: "http://127.0.0.1:18060/mcp" }] }),
            exitCode: 0,
          }
        : {
            stdout: JSON.stringify({ xiaohongshu: { status: "off", active_backend: null, message: "not reachable" } }),
            exitCode: 0,
          },
    });
    expect(probe.backend).toBe("xiaohongshu-mcp");
    expect(probe.hint).toBe(XHS_MCP_START_COMMAND);
  });

  test("doctor failure degrades, never guesses", async () => {
    const probe = await probeXhsBackend("agent-reach", { runJson: async () => ({ stdout: "", exitCode: 127 }) });
    expect(probe.backend).toBeNull();
    expect(probe.hint).toContain("exited 127");
  });
});

describe("backendCommand", () => {
  test("opencli searches xiaohongshu with json output", () => {
    expect(backendCommand("opencli", "短剧", 60000)).toEqual(["opencli", "xiaohongshu", "search", "短剧", "-f", "json"]);
  });
  test("xiaohongshu-mcp keeps the 120s browser timeout floor", () => {
    const cmd = backendCommand("xiaohongshu-mcp", "短剧", 5_000);
    expect(cmd).toContain("mcporter");
    expect(cmd.join(" ")).toContain("--timeout 120000");
    expect(cmd.slice(-2)).toEqual(["--output", "json"]);
  });
  test("xhs-cli uses the legacy json flag", () => {
    expect(backendCommand("xhs-cli", "短剧", 60000)).toEqual(["xhs", "search", "短剧", "--json"]);
  });
});

describe("probeXhsReadiness", () => {
  test("blocks an unauthenticated MCP backend with an exact QR command", async () => {
    const state = await probeXhsReadiness("xiaohongshu-mcp", 5_000, async () => ({
      stdout: JSON.stringify({ content: [{ type: "text", text: "❌ 未登录\n请使用 get_login_qrcode" }] }),
      exitCode: 0,
    }));
    expect(state.ready).toBe(false);
    expect(state.detail).toContain("login required");
    expect(state.hint).toContain("get_login_qrcode");
  });

  test("accepts a confirmed MCP login without exposing the returned identity", async () => {
    const state = await probeXhsReadiness("xiaohongshu-mcp", 5_000, async () => ({
      stdout: JSON.stringify({ content: [{ type: "text", text: "✅ 已登录\n用户: private-name" }] }),
      exitCode: 0,
    }));
    expect(state).toEqual({ ready: true, detail: "active backend: xiaohongshu-mcp; login confirmed" });
    expect(state.detail).not.toContain("private-name");
  });

  test("distinguishes a configured but offline MCP process from missing provisioning", async () => {
    const state = await probeXhsReadiness("xiaohongshu-mcp", 5_000, async () => ({
      stdout: JSON.stringify({ error: "SSE error: connect ECONNREFUSED 127.0.0.1:18060", issue: { kind: "offline" } }),
      exitCode: 0,
    }));
    expect(state.ready).toBe(false);
    expect(state.detail).toContain("configured but unreachable");
    expect(state.hint).toBe(XHS_MCP_START_COMMAND);
  });

  test("non-MCP backends rely on the agent-reach readiness probe", async () => {
    expect(await probeXhsReadiness("opencli", 5_000)).toEqual({ ready: true, detail: "active backend: opencli" });
  });
});

describe("normalizeXhsItems", () => {
  const payload = {
    notes: [
      { note_id: "661", display_title: "短剧钩子拆解", liked_count: 10, collected_count: 3, comment_count: 1, user: { user_id: "u1", nickname: "n1" }, time: "2026-08-28" },
      { id: "662", title: "无 xsec_url 的行", url: "https://www.xiaohongshu.com/explore/662" },
      { note_id: "", display_title: "无 id 的行" },
    ],
  };

  test("maps documented shapes and skips id-less rows", () => {
    const items = normalizeXhsItems(payload);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      platform: "xiaohongshu",
      contentId: "661",
      metrics: { liked_count: 10, collected_count: 3, comment_count: 1 },
      confidence: 75,
    });
    expect(items[1]!.contentId).toBe("662");
  });

  test("unrecognized payload shape yields zero items", () => {
    expect(normalizeXhsItems({ foo: "bar" })).toEqual([]);
    expect(normalizeXhsItems(null)).toEqual([]);
  });
});

describe("douyin signed layer", () => {
  test("normalizeSearch extracts aweme_info rows with real metrics", () => {
    const payload = {
      status_code: 0,
      data: [
        {
          aweme_info: {
            aweme_id: "7401",
            desc: "赘婿逆袭短剧名场面",
            author: { sec_uid: "s1", nickname: "n1" },
            create_time: 1758931200,
            statistics: { digg_count: 100, comment_count: 5, collect_count: 8, share_count: 2 },
          },
        },
        { not_aweme: true },
      ],
    };
    const { items, errors } = normalizeSearch(payload);
    expect(errors).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ platform: "douyin", contentId: "7401", confidence: 80 });
    expect(items[0]!.metrics).toEqual({ digg_count: 100, comment_count: 5, collect_count: 8, share_count: 2 });
  });

  test("risk-control status codes produce a real reason, not silence", () => {
    const { items, errors } = normalizeSearch({ status_code: 2154, data: [] });
    expect(items).toEqual([]);
    expect(errors[0]).toContain("status_code 2154");
  });

  test("queries stay stable and signed via X-Bogus elsewhere", () => {
    expect(searchQuery("短剧")).toContain("keyword=%E7%9F%AD%E5%89%A7");
  });
});

describe("browser fallback extraction", () => {
  test("extracts content anchors by URL shape across class churn", () => {
    const html = `
      <div class="whatever">
        <a href="https://www.douyin.com/video/740000000000000201?from=hot">总裁的身份藏不住了<span>12万赞</span></a>
        <a href="https://www.douyin.com/user/msxyz">不是视频链接</a>
        <a href="https://v.douyin.com/note/740000000000000202/">倒计时揭秘</a>
      </div>`;
    const items = extractFromHtml("douyin", html);
    expect(items).toHaveLength(2);
    expect(items[0]!.contentId).toBe("740000000000000201");
    expect(items[0]!.title).toContain("总裁");
    expect(items[1]!.contentId).toBe("740000000000000202");
  });

  test("xiaohongshu explore anchors are recognized", () => {
    const html = `<a href="https://www.xiaohongshu.com/explore/660000000000000301?xsec_token=t">三日破亿的短剧复盘</a>`;
    expect(extractFromHtml("xiaohongshu", html)).toHaveLength(1);
  });
});

describe("AccountPool rotation and circuit breaker", () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-pool-"));
  const path = join(dir, "accounts.json");

  function freshPool() {
    writeFileSync(path, JSON.stringify({
      version: 1,
      accounts: [
        { id: "xhs-01", platform: "xiaohongshu", handleMasked: "x***1", credentialRef: "secretstore://xhs-01", proxyRef: "proxy-a", status: "active", dailyUsed: 0 },
        { id: "xhs-02", platform: "xiaohongshu", handleMasked: "x***2", credentialRef: "secretstore://xhs-02", status: "active", dailyUsed: 0 },
      ],
    }));
    return new AccountPool(path);
  }

  test("rotates least-recently-used first and counts quota", () => {
    const pool = freshPool();
    const t0 = new Date("2026-08-29T08:10:00Z");
    const first = pool.rotate("xiaohongshu", 200, t0);
    expect(first.account!.id).toBe("xhs-01");
    const second = pool.rotate("xiaohongshu", 200, t0);
    expect(second.account!.id).toBe("xhs-02");
    const third = pool.rotate("xiaohongshu", 200, t0);
    expect(third.account!.id).toBe("xhs-01"); // lru wraps back
    expect(pool.list().find((a) => a.id === "xhs-01")!.dailyUsed).toBe(2);
  });

  test("risk-control trip cools the account for 24h and rotation skips it", () => {
    const pool = freshPool();
    const t0 = new Date("2026-08-29T08:10:00Z");
    pool.trip("xhs-01", "captcha", t0);
    const pick = pool.rotate("xiaohongshu", 200, t0);
    expect(pick.account!.id).toBe("xhs-02"); // cooled account skipped
    // 24h later the breaker self-resets
    const after = pool.rotate("xiaohongshu", 200, new Date(t0.getTime() + 24 * 3600 * 1000 + 1000));
    expect(after.account!.id).toBe("xhs-01");
    expect(after.account!.status).toBe("active");
  });

  test("exhausted daily quota degrades with the quota reason", () => {
    const pool = freshPool();
    const t0 = new Date("2026-08-29T08:10:00Z");
    const r = pool.rotate("xiaohongshu", 0, t0);
    expect(r.account).toBeNull();
    expect(r.reason).toContain("daily quota exhausted");
  });

  test("empty pool tells the user where to add descriptors", () => {
    const pool = new AccountPool(join(dir, "missing.json"));
    const r = pool.rotate("douyin", 200, new Date());
    expect(r.reason).toContain("no douyin accounts configured");
  });

  test("no credential material is ever serialized", () => {
    const pool = freshPool();
    const blob = JSON.stringify(pool.list());
    expect(blob).not.toMatch(/password|cookie|bearer/i);
    expect(blob).toContain("credentialRef"); // opaque refs only
  });
});

describe("risk-control detection is visible-challenge based (B7)", () => {
  test("a normal page whose HTML merely mentions captcha/sec-sdk does not trip", () => {
    // The old implementation substring-matched the whole page: normal
    // douyin/xhs pages embed sec-sdk/captcha script resources and a false
    // positive cost the account a 24h cooldown.
    expect(detectRiskControl({
      url: "https://www.douyin.com/hot",
      title: "抖音热榜",
      visibleMarkers: [],
    })).toBe(false);
  });

  test("challenge URL, challenge title, or visible challenge element trips", () => {
    expect(detectRiskControl({ url: "https://www.douyin.com/verify?...", title: "抖音", visibleMarkers: [] })).toBe(true);
    expect(detectRiskControl({ url: "https://www.xiaohongshu.com/explore", title: "安全验证", visibleMarkers: [] })).toBe(true);
    expect(detectRiskControl({ url: "https://www.douyin.com/hot", title: "抖音热榜", visibleMarkers: ["#captcha-verification"] })).toBe(true);
  });
});

describe("Layer 2 secret-store gating (unlock)", () => {
  const ctx = { firecrawlBaseUrl: "unused", agentReachBin: "unused", timeoutMs: 1000 };

  test("missing credential file degrades with the exact hint, no anonymous context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-l2-gate-"));
    writeFileSync(join(dir, "accounts.json"), JSON.stringify({
      version: 1,
      accounts: [{ id: "xhs-01", platform: "xiaohongshu", handleMasked: "x***1", credentialRef: "xhs-01", status: "active", dailyUsed: 0 }],
    }));
    const secretsRoot = join(dir, "secrets");
    mkdirSync(secretsRoot, { recursive: true });
    process.env.RADAR_SECRETS_DIR = secretsRoot;
    const adapter = makeBrowserAdapter("xiaohongshu");
    const result = await adapter.fetch({ ...ctx, accountsPath: join(dir, "accounts.json") });
    expect(result.degraded).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.errors[0]).toContain("credential 'xhs-01' not found");
    expect(result.errors[0]).toContain("storageState");
    delete process.env.RADAR_SECRETS_DIR;
  });

  test("unresolvable proxyRef is an error, never a silent direct connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-l2-proxy-"));
    writeFileSync(join(dir, "accounts.json"), JSON.stringify({
      version: 1,
      accounts: [{ id: "dy-01", platform: "douyin", handleMasked: "d***1", credentialRef: "dy-01", proxyRef: "proxy-a", status: "active", dailyUsed: 0 }],
    }));
    const secretsRoot = join(dir, "secrets");
    mkdirSync(secretsRoot, { recursive: true });
    // credential exists, proxy descriptor does not
    writeFileSync(join(secretsRoot, "dy-01.json"), JSON.stringify({ cookies: [] }), { mode: 0o600 });
    process.env.RADAR_SECRETS_DIR = secretsRoot;
    const adapter = makeBrowserAdapter("douyin");
    const result = await adapter.fetch({ ...ctx, accountsPath: join(dir, "accounts.json") });
    expect(result.degraded).toBe(true);
    expect(result.errors[0]).toContain("proxy descriptor 'proxy-a' not found");
    delete process.env.RADAR_SECRETS_DIR;
  });
});
