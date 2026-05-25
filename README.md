# LiquidityManager

> Sui DLMM 自动调仓 agent 模板:算法化重置仓位、闲置资产存借贷协议获利、用户充值与按次扣费。Bun + TypeScript + SQLite,~7K LOC,160 tests。

**这是一个模板**,不是即开即用的产品。带着自己的策略、自己的池子、自己的智能层接进来 — 模板提供链路、扩展点和参考实现。

## 它能做什么

- **算法调节仓位** — 三种内置策略(`singleBin` / `multiBinSpot` / `emaTrend`),概率分布 + 趋势偏侧两种范式,原子单 PTB 提交
- **闲置资产借贷** — Scallop + Kai SAV 集成,APY-aware router (Scallop tie-break 25 bps),per-coin dust 阈值
- **多源价格 feed** — 链上 Cetus SwapEvent 与 Binance REST 两路实现,统一 `PriceFeed` 接口 + 共享 `price_observations` 历史表
- **PM 自动发现** — 用 `MNEMONICS` 派生 agent 地址 → 监听链上 `AgentAdded` → 自动加入监控库;`AgentRemoved` / `PositionManagerClosed` → 自动从监控库删除
- **用户充值记录** — Per-user 派生地址,SQLite credit ledger,周期 watcher 入账,APY-aware 兑换率
- **CDPM 权限边界** — 通过 LeafSheep `PositionManager` 操作,用户资金不离开自己的 vault

## 它**不**做什么(故意留给二次开发者)

- ❌ 没有 LLM 信号层 / 新闻摄取 / σ-jump 智能 — 这些是 alpha,你带自己的
- ❌ 没有跨链(只 Sui 主网)
- ❌ 没有 HTTP API(只 SQLite + CLI scripts;v2 加 HTTP)
- ❌ 没有用户主动退款(运营手工 sweep)

## 快速开始

```bash
# 1. 安装
bun install                              # aftermath override 已锁定 2.0.1

# 2. 配置(.env 文件)
cp .env.example .env                     # 编辑填密钥
                                         # 必填:
                                         #   - AGENT_MNEMONICS 或 AGENT_PRIVATE_KEY
                                         #   - EXPECTED_AGENT_ADDRESS(防止换错助记词)
                                         #   - SUI_USDC_POOL_ID(mainnet 池 id)
                                         # 没填会在启动时一次性列出所有缺失字段

# 3. 验证密钥派生
bun run scripts/verify-agent-address.ts  # ✅ 应该 match

# 4. 静态完整性
bun run typecheck && bun test            # 应该 160 pass

# 5. 跑起来
bun start
```

## 扩展点(模板的核心价值)

模板已经划好的 4 个清晰扩展点 — 每个都有现成的接口,加一行注册或一个文件就能用:

### 1. 加新策略 (strategy)

```ts
// src/strategies/myStrategy.ts
import type { Strategy } from "./types.ts";

export function createMyStrategy(): Strategy {
  return {
    name: "myStrategy",
    plan(input) {
      // 返回 { kind: "plan_and_reconcile", plan } | { kind: "quiet" } | ...
    },
  };
}
```

注册:`src/strategies/registry.ts` 加一行,`StrategyName` union 加一项。`STRATEGY=myStrategy bun start` 即用。参考 `singleBin.ts` / `multiBinSpot.ts`。

### 2. 加新池子 (pool profile)

```ts
// src/pools/eth-usdc.ts
export function buildEthUsdcProfile(): PoolProfile { /* ... */ }
```

`src/pools/index.ts` 的 `BUILDERS` map 加一行。`POOL_PROFILE=eth-usdc bun start` 即用。

### 3. 加新借贷协议 (lending adapter)

镜像 `src/sui/lending/scallop.ts` 写 adapter,在 `src/sui/lending/router.ts` 的 `pickHighestApy` 加协议分支,`src/sui/lending/types.ts` 的 `LendingProtocol` union 加一项。

### 4. 加新可借贷资产 (lendable coin)

`src/sui/lending/lendingConfig.ts` 改三处:
- `LENDING_OPPORTUNITIES` 加 `(protocol, coin)` 对
- `MIN_LENDING_DELTA_RAW` 加该 coin 的 dust 阈值
- (Scallop 路径)`SCALLOP_RESERVES` 加 BalanceSheet 引用
- (Kai 路径)`src/sui/lending/kaiVaults.ts` 加 vault 元数据

不改代码、不改 schema、不重启 service。详见 `docs/module-and-testing.md` Module 2。

## 你需要带进来的

| 你想加 | 模板提供 | 你要做 |
|---|---|---|
| LLM 信号源 | `Strategy.plan()` 入参里有 `history: PriceObservation[]` | 用你自己的 LLM 客户端 / RSS 抓取 / Twitter API,在 strategy 里塞进决策 |
| 跨链 | (无) | 引入桥接 SDK,在主进程外作为独立服务跑;不要污染 treasury 模块 |
| HTTP API | (无) | Bun 自带 `Bun.serve()`,在 `src/index.ts` 加路由;treasury layer 已经有 `attemptCharge` / `findUserBySuiAddress` 等可调函数 |

## 项目结构

```
src/
├── index.ts                  # 进程入口,启动所有 service
├── config.ts                 # env → AppConfig
├── domain/                   # 跨层共享类型 + bin/fee 数学
├── pools/                    # 池子配置(sui-usdc 示例)
├── sui/                      # Sui 链交互
│   ├── client.ts             # JSON-RPC 客户端单例
│   ├── pool.ts               # 池子状态读取
│   ├── keypairs/             # 多角色密钥(agent + treasury)
│   ├── cdpm/                 # CDPM PTB 构造器(unified + legacy)
│   └── lending/              # 借贷整合(Scallop + Kai + router + math + config)
├── data/                     # 价格 feed
├── forecast/                 # σ 估计 (volatility.ts: EWMA/Parkinson/GK) + bin 权重映射
├── strategies/               # 策略实现 + registry
├── treasury/                 # 用户充值 + credit ledger + watcher + charges
├── services/                 # 编排层(rebalancer / executor / subscriptions / treasuryService)
├── db/                       # SQLite 单文件 schema (CREATE IF NOT EXISTS,无 migration)
├── lib/                      # 工具:logger / locks / errors
└── backtest/                 # 离线策略回放工具
```

## 详细文档

- `docs/project-overview.md` — 当前实现状态 + 已知局限 + 优化路线图
- `docs/module-and-testing.md` — 6 大模块的"做什么 / 怎么测"
- `docs/treasury-role-design.md` — Treasury 层设计(数据模型、charge 公式、Seal 阅读身份与 deposit 地址三合一约定、运营 runbook)
- `docs/seal-integration.md` — v2 Seal 加密研报集成(per-user 模型、Move 合约骨架、SessionKey 生命周期)
- `docs/forecasting-approach.md` — EWMA / Parkinson / Garman-Klass 数学背景 + 升级到 ML 模型的扩展点

## 安全约定

- **不要把 `.env` 提交到 git**(默认 gitignored)
- **不要把 `MNEMONICS` 写入日志**(代码已经避免)
- **`AGENT_MNEMONICS` 和 `TREASURY_MNEMONICS` 必须用不同的助记词** — agent 被攻破不能波及 treasury
- **`EXPECTED_AGENT_ADDRESS` 是必填字段**(在 `.env` 没设或格式错误,`loadConfig` 会一次性列出所有缺失项再退出)
- **TOFU 身份文件**(`./data/agent.identity.json` / `./data/treasury.identity.json`)首次运行写入,后续启动自动比对 — 助记词被换会立即 fail-fast;主动轮换时 `rm ./data/*.identity.json` 重启

## `.gitignore` 量子坑

仓库的 `.gitignore` 故意把 `*.md`, `/scripts`, `/tests` 全忽略 — 历史原因。**模板用户克隆后注意**:

- `README.md` 要用 `git add -f README.md` 才进新仓
- `docs/*.md` 同上(详细文档要 `-f` 才能跟踪)
- `tests/` 和 `scripts/` 整目录被 ignore — fork 模板后请按需调整 `.gitignore` 把它们加回 git

## 许可证

`LICENSE` 是占位文件,**在公开 fork 前请敲定真实许可证**(MIT / Apache-2.0 / GPL 等)。

## 致谢

模板灵感来自:
- [Cetus DLMM](https://docs.cetus.zone/cetus-developer-docs/cetus-dlmm) — Sui 上的 DLMM 协议
- [CDPM (LeafSheep)](https://github.com/...) — PositionManager 权限抽象,用户资金不离开自己的 vault
- Scallop + Kai SAV — 借贷 yield 来源
- [SuiAgentsTopUp](https://github.com/...) — Treasury 模式参考实现
