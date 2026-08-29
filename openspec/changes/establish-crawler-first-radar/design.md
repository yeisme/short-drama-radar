# 设计：爬虫主路短剧雷达

```mermaid
flowchart TD
    subgraph L0[Layer 0 公共页]
        A1[firecrawl douyin hot]
        A2[firecrawl xhs explore]
    end
    subgraph L1[Layer 1 平台后端]
        B1[agent-reach xhs 后端]
        B2[抖音签名 API 自研层]
    end
    subgraph L2[Layer 2 浏览器]
        C1[Playwright flows 账号池]
    end
    L3[Layer 3 人工导入] --> P
    L0 --> P[collect 适配器 normalize]
    L1 --> P
    L2 --> P
    P --> S[(SQLite Drizzle)]
    S --> T[tags 钩子/题材/情绪]
    T --> SC[score v0 + confidence]
    SC --> CD[card.v1 payload]
    CD --> YW[云婉 投递 外部项目]
```

- 编排器为 TS/Bun CLI，子进程调用上游工具，不重写 firecrawl/agent-reach。
- 所有失败降级必须显式记录；凭据不落库。
- 评分与卡片结构见 `src/pipeline/scoring.ts` 与 `src/pipeline/card.ts`。
