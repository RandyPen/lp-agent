# LiquidityManager — 模块划分与测试指南

> 与 `project-overview.md` 互补:`project-overview` 回答"现状与下一步",本文档回答"系统由哪几大块组成,每一块怎么验证"。
> 最后更新:2026-05-24。配套测试套件 **160 tests / 13 files**,全部通过。代码量约 7 kLOC。

---

## 模块总览

按照"职责"而非"目录"切分,系统由 **6 个大模块** 组成。下表展示了模块之间的依赖方向(↓ 表示依赖)。

```
┌─────────────────────────────────────────────────────────────────────┐
│         模块 6 — 编排与持久化 (Orchestration & Persistence)         │
│         rebalancer / executor / 调度器 / SQLite / config            │
└─────────────────────────────────────────────────────────────────────┘
       ↓                  ↓                  ↓                  ↓
┌─────────────┐  ┌────────────────┐  ┌──────────────┐  ┌─────────────┐
│  模块 4     │  │  模块 5        │  │  模块 2      │  │  模块 1     │
│  策略引擎    │  │  Treasury      │  │  借贷集成     │  │  核心交易层  │
│             │  │  (用户充值)     │  │              │  │              │
│  multiBin    │  │  watcher /     │  │  Scallop/Kai │  │  PTB 构建    │
│  / singleBin │  │  charges       │  │              │  │              │
└─────┬───────┘  └────────────────┘  └──────────────┘  └─────────────┘
      ↓                                       ↓                  ↓
┌─────────────────────────────────────────────────────────────────────┐
│         模块 3 — 行情与预测 (Market Data & Forecasting)             │
│         priceFeed / GARCH / binWeights                              │
└─────────────────────────────────────────────────────────────────────┘
```

> 第 7 个模块"回测与运维工具"以前是独立一段,现已合并到模块 6 的"调度与脚本"小节里(只是 CLI 入口与运营脚本,无独立运行时角色)。

---

## 模块 1 — 核心交易层 (Core Transaction Layer)

### 职责
所有与 Sui 链交互的代码集中点:RPC 客户端 + 密钥管理(agent + treasury 两角色)+ Move 事件解码 + CDPM 协议常量 + DLMM bin 数学 + PTB(可编程交易块)构造。CDPM 权限模型(只能 add/remove/collect/transfer)在这一层强制 — 不存在能"绕过权限"的代码路径。

### 关键文件

| 文件 | 作用 |
|---|---|
| `src/sui/client.ts` | JSON-RPC 客户端单例 |
| `src/sui/keypair.ts` | 旧的 agent-only keypair 入口(向后兼容)|
| `src/sui/keypairs/resolve.ts` | 纯解析器:`KeyRoleEnvConfig` → `{ keypair, address, source }`,做 expected-address 校验 |
| `src/sui/keypairs/agent.ts` | Agent 角色 singleton + 缓存,优先读 `AGENT_PRIVATE_KEY`,fallback `AGENT_MNEMONICS` |
| `src/sui/keypairs/treasury.ts` | Treasury master singleton + per-user 派生(模块 5 用)|
| `src/sui/pool.ts` | Cetus DLMM Pool 对象的读取 (active bin, binStep, fee) |
| `src/sui/cdpm/package.ts` | CDPM 包地址、Move 目标、Cetus DLMM 共享对象 ID |
| `src/sui/cdpm/read.ts` | PositionManager 状态读取 + Bag 枚举 |
| `src/sui/cdpm/events.ts` | Move 事件解码器 (AgentLiquidityAdded 等) |
| `src/sui/cdpm/tx.ts` | 旧版每操作 PTB builder (collect/remove/transfer/add) |
| `src/sui/cdpm/tx_lending.ts` | 旧版 Scallop/Kai 借贷 PTB builder |
| `src/sui/cdpm/txUnified.ts` | **统一 PTB builder** (atomic,推荐路径) |
| `src/domain/binMath.ts` | bin↔price 纯 JS 实现 (绕过 Cetus SDK 的 ESM 问题) |
| `src/domain/feeMath.ts` | 含费有效填充价 + bin 买卖侧分类 |

### 对外接口
```ts
buildUnifiedRebalanceTx({ plan, pm, lendingDecisions }) → { tx, description, commandCount }
getPositionManager(pmId) → PMState
getPoolState(poolId) → PoolState
priceFromBinId(binId, binStep, decimalsA, decimalsB) → string
binIdFromPrice(price, binStep, useFloor, decimalsA, decimalsB) → number
isAgentAuthorized(pmId, agentAddress) → boolean
// keypair role 入口
getAgentKeypair() → Ed25519Keypair             // 缓存
getTreasuryMasterKeypair() → Ed25519Keypair    // 缓存,独立
deriveUserDepositAddress(index) → string       // 不缓存
```

### 依赖
- `@mysten/sui` (Transaction, queryEvents, BCS, Ed25519Keypair)
- `src/lib/{logger, errors}`
- `src/config.ts` (network → ID 映射、`cfg.keys.{agent,treasury}` 配置)

### 测试现状

| 测试 | 文件 | 覆盖 |
|---|---|---|
| ✅ Unified PTB 命令顺序+数量 | `tests/txUnified.test.ts` (4) | empty / pure-add / full / 负数拒绝 |
| ✅ bin↔price 单调与往返 | `tests/forecast.test.ts` | priceFromBinId(0)=1000,正负方向单调 |
| ✅ Agent keypair 解析 | `tests/keypairAgent.test.ts` (10) | 优先级、derivation、expected-address 守卫 |
| ✅ 通用 resolveKeypair | `tests/keypairResolve.test.ts` (13) | 缺失输入、坏 bech32、role 错误消息 |
| ✅ Treasury master / per-user 派生 | `tests/treasury/keypair.test.ts` (10) | 确定性、master vs user 不冲突、index < 1 拒绝、与 agent 不冲突 |
| ❌ `tx.ts` 旧版 builder | — | 仅靠集成路径间接验证 |
| ❌ `read.ts` / `events.ts` / `pool.ts` | — | 无 |

### 如何测试
- **单元** (易):给定 `RebalancePlan` 与 `PMState`,断言 `buildUnifiedRebalanceTx` 的 `commandCount` 与 `description`。`tests/txUnified.test.ts` 是模板。
- **单元** (中):用真实样本事件 payload 喂 `decodeEvent`,断言解码结果。需要从 SuiExplorer 抓一条 `AgentLiquidityAdded` 事件保存为 fixture。
- **集成**:链上 dry-run — `bun start` 触发一次 rebalance 后,用 `client.devInspectTransactionBlock(builtTx)` 而不是 `signAndExecute`,检查模拟结果中的 effects/events。
- **手动**:`bun run events:print` 持续输出 CDPM 事件流。

---

## 模块 2 — 借贷集成 (Lending Integration)

### 职责
Scallop + Kai SAV 的接入:APY 查询、协议适配、决策路由(redeem / supply / noop)、按目标净值反推 sCoin / YT 烧毁量的数学。所有借贷的"何时做、做多少"逻辑都在这里。

### 关键文件

| 文件 | 作用 |
|---|---|
| `src/sui/lending/lendingConfig.ts` | **可借贷资产白名单** — `LENDING_OPPORTUNITIES`(USDC/SUI/DEEP × Scallop/Kai 共 6 条)+ `MIN_LENDING_DELTA_RAW` dust 阈值 + `canLend()` / `getMinLendingDeltaRaw()` / `getCandidateOpportunities()` helper。镜像 cdpm_web 模式 |
| `src/sui/lending/router.ts` | `decide()` 决策树:supply 阈值、shortfall 触发的 redeem、APY 切换 |
| `src/sui/lending/math.ts` | **核心数学** — `predictRedeem`、`scoinToBurnForTargetNet`、`ytToBurnForTargetNet`、`applyYieldFee`、`capRedeemBurnRaw`、`SCALLOP_TIE_BREAK_BPS=25` |
| `src/sui/lending/scallop.ts` | Scallop SDK adapter (APY、protocol/market/version ID 解析) |
| `src/sui/lending/kai.ts` | Kai SDK adapter (用 `getVaultDataBatch` + `getVaultStats` 算 APY,只 2 个 SDK import) |
| `src/sui/lending/kaiVaults.ts` | 硬编码 Kai 主网 vault 元数据 (USDC/SUI/DEEP),`KaiVaultEntry[]` + `KAI_SAV_MAINNET` 常量 |
| `src/sui/lending/apyCache.ts` | TTL + inflight 去重 APY 缓存 |
| `src/sui/lending/typeNorm.ts` | Move struct tag 规范化 (短形式 ↔ 长形式) — Treasury 模块也用 |
| `src/sui/lending/types.ts` | LendingDecision、ApySnapshot、LendingState |
| `src/strategies/lendingPolicy.ts` | 每币种策略 (minIdleBuffer / supplyThreshold / redeemHeadroom / apySwitchDeltaBps) |

### 对外接口
```ts
decide({ pm, profile, shortfall }) → { decisions: LendingDecision[] }
canLend(coinType) → boolean
getCandidateOpportunities(coinType) → LendingOpportunity[]
getMinLendingDeltaRaw(coinType) → bigint
scoinToBurnForTargetNet(reserve, vault, desiredNet, feeRateBp) → bigint
ytToBurnForTargetNet(vault, pm, desiredNet, feeRateBp) → bigint
predictScallopRedeem(reserve, vault, wantScoin, feeRateBp) → RedeemPrediction
getApy(protocol, coinType) → ApySnapshot | null
capRedeemBurnRaw(exact, wrapperRaw) → bigint | null
```

### 依赖
- `@scallop-io/sui-scallop-sdk`、`@kunalabs-io/kai` (仅只读路径,不参与 tx 构建)
- 模块 1 的 `src/sui/cdpm/package.ts` (Move targets)

### 测试现状

| 测试 | 文件 | 覆盖 |
|---|---|---|
| ✅ 借贷数学 | `tests/lendingMath.test.ts` (21) | skill 文档 §7.3 worked example 精确匹配;边界 (MAX_U64、零本金);capRedeemBurnRaw |
| ✅ Shortfall 计算 | `tests/computeShortfall.test.ts` (6) | buffer 边界、币种白名单 |
| ✅ Lending 白名单 / 阈值 / 规范化 | `tests/lendingConfig.test.ts` (28) | canLend、getMinLendingDeltaRaw、getCandidateOpportunities、短/长 type tag 等价 |
| ❌ `router.decide()` | — | **关键空缺** — 决策树未单测 |
| ❌ APY 缓存 TTL / 并发 | — | 无 |
| ❌ Scallop / Kai adapter | — | 无 (依赖 SDK 初始化网络调用) |

### 如何测试
- **单元** (推荐先做):为 `router.decide()` 写参数化测试 — 输入 `{pm, profile, shortfall, apys}`,断言输出的 `LendingDecision[]` (kind/protocol/amount)。覆盖:
  - 0 shortfall + 大 idle → supply 至 winner
  - shortfall > buffer → redeem 至当前 protocol
  - APY 差 < 25bps + 已 supplied 在 Kai → 保持现状 (tie-break)
  - APY 差 > apySwitchDeltaBps → redeem 后切换
- **集成 (mainnet 必做一次)**:
  ```bash
  bun run lending:bootstrap      # 验证 SDK 能解析 ID
  ```
  然后用一个小额测试 PM 走完一轮 supply → redeem,SQL 校验:
  ```sql
  SELECT pm_id, protocol, action, amount, status
  FROM lending_actions
  ORDER BY planned_at_ms DESC LIMIT 10;
  ```

---

## 模块 3 — 行情与预测 (Market Data & Forecasting)

### 职责
从 Cetus DLMM 的 SwapEvent 流中提取价格,持久化到 `price_observations`,聚合成 OHLCV,然后用统计方法估计未来 σ,最后把价格分布映射到 bin 权重。

> 早期分支有 LightGBM quantile inference (`src/forecast/quantile/`) 与 σ-jump (`src/forecast/jump.ts`),已删除 — σ 现在只走统计路径 (EWMA / Parkinson / GK)。Forks 想加 ML 推断,新建 `src/forecast/quantile/` 即可,接口约定在 `forecast/types.ts`。

### 关键文件

| 文件 | 作用 |
|---|---|
| `src/data/priceFeed.ts` | PriceFeed 接口 (`getSpot`、`getHistory(windowMs)`、`getOhlcv(bucketMs, windowMs)`) |
| `src/data/feeds/onchain.ts` | Cetus SwapEvent → PriceObservation 实现 + SQLite 持久化 + OHLCV 桶化 |
| `src/forecast/types.ts` | PriceDistribution、OhlcvBar、BinWeight |
| `src/forecast/garch.ts` | **σ 估计** — EWMA(λ=0.94)、Parkinson、Garman-Klass、sqrt-time scaling、`bucketToOhlcv` |
| `src/forecast/binWeights.ts` | log-normal CDF 区间积分 + fee dead-zone derate + uniform fallback + `pickBinRange` |

### 对外接口
```ts
priceFeed.getSpot() → PriceObservation
priceFeed.getOhlcv(bucketMs, windowMs) → OhlcvBar[]
ewmaSigma(prices, lambda?) → number
parkinsonSigma(bars) → number
computeBinWeights({ bins, distribution, feeRateBps, ... }) → { bins, rawMass }
```

### 依赖
- `@mysten/sui` (queryEvents)
- 模块 1 的 `priceFromBinId`
- 模块 6 的 `getDb()` (持久化与 OHLCV 读取)

### 测试现状

| 测试 | 文件 | 覆盖 |
|---|---|---|
| ✅ σ 估计器 + scaling + binWeights | `tests/forecast.test.ts` (22) | EWMA 常价 = MIN_SIGMA;Parkinson/GK 输出 > 0;sqrt-time scaling 精确;bucketToOhlcv 桶对齐 + 乱序;权重和=1;tight σ 集中在 active;feeRateBps>0 降低 active 权重;uniform fallback |
| ❌ onchain.ts (价格 feed) | — | 无 (需 RPC mock) |

### 如何测试
- **单元** (已强):上述测试已覆盖大部分。
- **集成**:`bun start` 跑 30 分钟,然后 SQL 校验:
  ```sql
  SELECT COUNT(*), MIN(observed_ms), MAX(observed_ms),
         AVG(CAST(price AS REAL))
  FROM price_observations WHERE pool_id = ?;
  ```
  与 Pyth/CoinGecko 的 SUI/USDC 对照,差应 < 0.5%。
- **手动**:`bun run backtest` 走一遍持久化的 price_observations,检查 multiBinSpot 触发的 σ 估计在合理范围 (0.005 – 0.05 per 30min)。

---

## 模块 4 — 策略引擎 (Strategy Engine)

### 职责
所有策略的实现 + 命名注册表 + 持仓状态 (fillBoundary)。策略消费 PMState/PoolState/PriceObservation,返回 `StrategyOutput`(4 态联合)。

> 模板只保留 `singleBin` 与 `multiBinSpot`。早期分支的骨架策略(`curve` / `bidAsk` / `onlyBid` / `onlySell`)已删除 — 新增策略走 `src/strategies/registry.ts` 一行注册即可(`Strategy` 接口契约见 `types.ts`)。

### 关键文件

| 文件 | 作用 |
|---|---|
| `src/strategies/types.ts` | `Strategy` 接口、`StrategyOutput` (`plan_and_reconcile`/`plan_only`/`reconcile_only`/`quiet`) |
| `src/strategies/registry.ts` | `buildStrategy(name)`、`isStrategyName()`、`listStrategyNames()` — 当前仅 `singleBin` 和 `multiBinSpot` |
| `src/strategies/singleBin.ts` | P0 — 全部入 active bin,漂出范围重新对中 |
| `src/strategies/multiBinSpot.ts` | **v0** — log-normal 分布、out-of-range/drift/fees-only 触发 |
| `src/strategies/positionState.ts` | `saveFillBoundary` / `loadPositionState` — 留给将来 bid-ask 类策略;v0 不写 |
| `src/strategies/lendingPolicy.ts` | per-coin 借贷策略类型定义 |

### 对外接口
```ts
buildStrategy(name: StrategyName) → Strategy
strategy.plan({ pm, pool, spot, history, profile }) → StrategyOutput
saveFillBoundary(pmId, binId, strategyName) → void
loadPositionState(pmId) → PositionState | null
```

### 依赖
- 模块 3 (forecast)
- 模块 6 (db)

### 测试现状

| 测试 | 文件 | 覆盖 |
|---|---|---|
| ✅ 回测端到端 | `tests/backtest.test.ts` (5) | 平价 quiet、漂出触发、multiBin 多 bin 部署、未知策略拒绝、singleTick helper |
| ❌ `multiBinSpot.plan()` 直接单测 | — | 仅靠 backtest 间接验证 |
| ❌ `positionState` | — | 无 |

### 如何测试
- **单元**:为 `multiBinSpot.plan()` 写隔离测试 — 固定 PMState/PoolState/PriceObservation,断言:
  - PM 空 + 有 balance → `plan_and_reconcile` 且 `addBins.length ≥ 5`
  - PM 覆盖 active + 有 fees → `plan_and_reconcile` (fees-only path)
  - PM 覆盖 active + 无 fees → `quiet`
  - 漂出 → `plan_and_reconcile` 中心移到新 active
- **单元**:`positionState` 的 save/load/clear 配对(需 in-memory SQLite)。
- **集成**:回测对比 `STRATEGY=singleBin` vs `STRATEGY=multiBinSpot` 在同一历史窗口下的触发次数,后者应明显多于前者(更频繁的小幅调整)。

---

## 模块 5 — Treasury (用户充值与服务费扣减)

### 职责
模板可选的"产品化层":让 PM owner 在 agent 之外开一个充值账户,agent 调仓时按规则扣 credits。当 `TREASURY_ENABLED=false`(默认),整个模块完全静默;rebalancer 走原行为。

实现层次:
1. **Keypair** — master(运营 sweep / swap 用)与 per-user 派生地址(用户充值收款),与 agent 角色完全隔离。
2. **Store** — SQL CRUD,所有写入走 SQLite 事务。
3. **Credits 数学** — `delta → credits` 与 `plan → cost`,均 floor。
4. **Registration** — 注册即派生新 index,幂等。
5. **Watcher** — 周期轮询 `getAllBalances`,delta>0 入账,delta<0 仅更新 cache。
6. **Charges** — nonce-based 幂等扣减 + 失败退款。

### 关键文件

| 文件 | 作用 |
|---|---|
| `src/sui/keypairs/treasury.ts` | Master singleton + `deriveUserDepositAddress(index)`(不缓存)。Index 0 留给 master,用户从 1 开始。 |
| `src/treasury/types.ts` | TreasuryUser、CreditRate、DepositRecord、ServiceCharge、TreasuryOp、ChargeResult |
| `src/treasury/store.ts` | 全部 `treasury_*` 表的 CRUD;`attemptChargeTx` / `refundChargeTx` / `recordDepositTx` 都是事务封装 |
| `src/treasury/credits.ts` | `creditsForAmount(delta, rate)` — floor;`estimateRebalanceCost({plan, profile, spot, cfg})` — base + volume × fee_rate |
| `src/treasury/registration.ts` | `registerUser(suiAddress)` → 调 store 的事务 + `deriveUserDepositAddress`,幂等 |
| `src/treasury/watcher.ts` | `createTreasuryWatcher({client, intervalMs})` — `pollOnce()` / `start()`;per-user 一次 `listBalances`,逐 `coin_type` 比 delta;失败隔离 |
| `src/treasury/charges.ts` | `attemptCharge({suiAddress, pmId, cost, nonce, memo?})` 与 `refundCharge(nonce, reason)` — v1 不验签名 |
| `src/services/treasuryService.ts` | runtime 入口:`startTreasuryService(cfg)` 拉起 watcher,返回 `{ stop() }` |
| `scripts/treasury-register-user.ts` | CLI:`<suiAddress>` → 注册并打印 deposit_address |
| `scripts/treasury-list-users.ts` | 列已注册用户 + credits |
| `scripts/treasury-list-balances.ts` | 列每个 deposit_address 当前链上余额 |
| `scripts/treasury-update-rate.ts` | 更新 `treasury_credit_rates` 表(`--coin --num --den`)|
| `scripts/verify-treasury-address.ts` | 验证 master keypair → 地址匹配 `EXPECTED_TREASURY_MASTER_ADDRESS` |

### 对外接口
```ts
// store
registerUserTx(suiAddress, deriveFn) → TreasuryUser
findUserBySuiAddress(suiAddress) → TreasuryUser | null
findUserByDepositAddress(depositAddress) → TreasuryUser | null
listUsers() → TreasuryUser[]
getCreditRate(coinType) → CreditRate | null
upsertCreditRate({ coinType, rateNum, rateDen, updatedBy?, nowMs? }) → void
recordDepositTx({...}) → void                          // 原子:append + credit + cache
attemptChargeTx({ nonce, suiAddress, pmId, cost, memo }) → ServiceCharge
refundChargeTx(nonce, reason) → boolean

// 高层 facade
registerUser(suiAddress) → TreasuryUser               // 含派生地址 + 日志
attemptCharge({ suiAddress, pmId, cost, nonce, memo? }) → ChargeResult
refundCharge(nonce, reason) → boolean
estimateRebalanceCost({ plan, profile, spotPriceUsdcPerA, cfg }) → number

// keypair
getTreasuryMasterKeypair() → Ed25519Keypair
getTreasuryMasterAddress() → string
getUserDepositKeypair(index) → Ed25519Keypair         // 不缓存
deriveUserDepositAddress(index) → string

// service
startTreasuryService(cfg) → { stop(): void }
```

### 依赖
- 模块 1 的 `keypairs/{resolve,treasury}` 与 `sui/client`
- 模块 2 的 `typeNorm.ts`(`canonicalType` 用于 coin_type 入库前规范化)
- 模块 6 的 `getDb()`、`logger`、`config.treasury`
- **不依赖** agent 模块、不依赖策略/borrowing 决策(只在 rebalancer 拼接处被调用)

### 测试现状(共 51 tests,5 个文件)

| 测试 | 文件 | 覆盖 |
|---|---|---|
| ✅ Master + per-user 派生 | `tests/treasury/keypair.test.ts` (10) | 确定性、master vs user 不冲突、index<1 拒绝、与 agent 不重合、缓存隔离 |
| ✅ Credit 数学 | `tests/treasury/credits.test.ts` (11) | rate=null → 0;rateDen ≤ 0 防御;floor;volume 计算;A/B 边换算 |
| ✅ Store CRUD + 事务 | `tests/treasury/store.test.ts` (18) | registerUserTx 幂等;recordDepositTx 原子;attemptChargeTx 三态;refundChargeTx 幂等;UPSERT 行为 |
| ✅ Registration | `tests/treasury/registration.test.ts` (5) | index 单调;重复注册返回已有行;address 输入校验 |
| ✅ Watcher tick | `tests/treasury/watcher.test.ts` (7) | delta>0 入账;delta<0 仅更新 cache;delta=0 noop;无 rate → credits=0 但仍有 deposit 行;失败隔离 |
| ❌ rebalancer 集成路径 | — | 见模块 6 |

### 如何测试
- **单元 (已强)**:5 个测试文件覆盖 ledger 不变量。补充建议:`refundCharge` 在 `status='refunded'` 行上的重入(应 noop);`creditsForAmount` 上溢到 `Number.MAX_SAFE_INTEGER` 时的 clamp 路径。
- **集成 (mainnet 必做一次)**:
  ```bash
  bun run scripts/verify-treasury-address.ts    # 守卫一次
  bun run scripts/treasury-register-user.ts <sui_address>
  bun run scripts/treasury-update-rate.ts --coin <USDC type> --num 1 --den 10000
  # 用户向打印出来的 deposit_address 转 0.1 USDC
  TREASURY_ENABLED=true bun start &
  # 15 秒后:
  sqlite3 ./data/app.db 'SELECT * FROM treasury_deposits ORDER BY observed_at_ms DESC LIMIT 5;'
  ```
  期望:`credits_granted = 10`(0.1 USDC × 100 credits/USDC),user.credits 同步增加。
- **手动 (rebalancer 集成)**:`TREASURY_ENABLED=true TREASURY_REQUIRE_REGISTRATION=true bun start`,跑一次真实调仓,SQL 验:
  ```sql
  SELECT nonce, sui_address, pm_id, credits_debited, status FROM treasury_service_charges
  ORDER BY created_at_ms DESC LIMIT 5;
  ```
  期望:状态 `ok` 的行 + 对应 user.credits 减去 debited;PTB 失败 → 行变为 `refunded`、user.credits 恢复。

---

## 模块 6 — 编排与持久化 (Orchestration & Persistence)

### 职责
把所有模块串联起来的"主循环层":rebalancer tickOne、executor 签名提交、subscriptions 维护授权 PM 列表、treasury watcher 注入、SQLite 单文件 schema、locks/logger/config 基础设施 + 回测 CLI + 运营脚本。

### 关键文件

| 文件 | 作用 |
|---|---|
| `src/index.ts` | 启动点 — 校验 agent / treasury 地址、启所有调度器、SIGINT 优雅关闭 |
| `src/config.ts` | 环境变量解析(network、strategy、UNIFIED_TX、LENDING_*、agent role、treasury role + 价格参数)+ 缓存 |
| `src/services/rebalancer.ts` | **核心** — `tickOne(pmId)` 主流程、`tickId` 关联日志、interval guard 防堆积、Treasury 门槛 + 扣减 + 失败退款 |
| `src/services/executor.ts` | 签名 + 提交 + 事件解码;旧版每操作 method + 新版 `submitUnifiedRebalance` |
| `src/services/subscriptions.ts` | AgentAdded/Removed/PMClosed/Scallop/Kai 事件 → SQLite 状态 |
| `src/services/treasuryService.ts` | 启动 treasury watcher(只在 `TREASURY_ENABLED=true` 时)|
| `src/db/client.ts` | SQLite 打开 + WAL/FK pragma + 启动时跑一遍 `schema.sql`(无 `schema_migrations` 表、无版本追踪) |
| `src/db/schema.sql` | **单一 schema 源文件**,全部 `CREATE … IF NOT EXISTS`。当前 11 张表:`subscriptions`、`event_cursor`、`rebalances`、`price_observations`、`lending_positions`、`lending_actions`、`position_state`、以及 6 张 `treasury_*`(users、credit_rates、address_balances、deposits、service_charges、ops)。**不做版本化迁移** — 改 schema 直接编辑本文件,重启即生效;不兼容变更走 `rm ./data/app.db` 重建。 |
| `src/lib/locks.ts` | per-key async 锁 |
| `src/lib/logger.ts` | JSON 行日志 |
| `src/lib/errors.ts` | typed error 类(`ConfigError` 等) |
| `src/pools/index.ts`、`sui-usdc.ts`、`types.ts` | 池配置 (lazy build,env 驱动) |
| `src/backtest/{cli,replay,types}.ts` | 回测主循环 + `bun run backtest` CLI |
| `scripts/bootstrap-agent-key.ts` / `verify-agent-address.ts` / `verify-treasury-address.ts` | 密钥运维 |
| `scripts/lending-bootstrap.ts` | 验 Scallop+Kai SDK 能解析 ID |
| `scripts/print-events.ts` | 实时打印 CDPM 事件 |
| `scripts/treasury-{register-user,list-users,list-balances,update-rate}.ts` | Treasury 运营脚本 |

### 对外接口
```ts
loadConfig() → AppConfig                              // 缓存
openDb(path) → Database                               // 启动时跑一遍 schema.sql
createRebalancerService(subs, executor, priceFeed) → { start(), tickOne(pmId) }
createExecutorService() → ExecutorService             // 4+1 个 method
createSubscriptionsService() → { pollOnce(), listActive(), get(pmId) }
startTreasuryService(cfg) → { stop(): void }          // 仅 cfg.treasury.enabled=true
withLock(key, fn) → fn 的返回值
```

```bash
bun start
bun run backtest --strategy=multiBinSpot --from=2026-04-01 --to=2026-05-01 [--json]
bun run lending:bootstrap
bun run key:bootstrap
bun run events:print
bun run scripts/verify-agent-address.ts
bun run scripts/verify-treasury-address.ts
bun run scripts/treasury-register-user.ts <suiAddress>
bun run scripts/treasury-list-users.ts
bun run scripts/treasury-list-balances.ts
bun run scripts/treasury-update-rate.ts --coin <type> --num <n> --den <d>
```

### 依赖
所有其他模块都通过它启动 — 在依赖图最顶端。

### 测试现状

| 测试 | 文件 | 覆盖 |
|---|---|---|
| ✅ 回测主循环 | `tests/backtest.test.ts` (5) | 平价 quiet、漂出触发、multiBin 多 bin、未知策略拒绝、singleTick helper |
| ❌ `rebalancer.tickOne()` | — | **关键空缺** |
| ❌ `executor.*` (5 个方法) | — | 无 |
| ❌ `subscriptions` | — | 无 |
| ❌ `locks.withLock` | — | 无 |
| ❌ `config.loadConfig` | — | 无 |

### 如何测试
- **单元** (推荐先做):
  - **`locks.withLock`** — 并发两个 fn,断言串行;一个 throw,另一个仍能拿锁。
  - **`config.loadConfig`** — env 缺失/不合法、parseStrategy 拒绝未注册名、`expectedAgentAddress` / `expectedTreasuryMasterAddress` 不匹配应 throw。
- **集成** (中等):为 `rebalancer.tickOne` 用真实 SQLite + mock Sui client + 假 strategy(返回固定 plan)+ 假 executor,断言:
  - cooldown 内 → skip
  - agent 未授权 → revoke subscription
  - `plan_and_reconcile` → 走完 5 步、`rebalances` 表写入 succeeded 行
  - `TREASURY_ENABLED=true` + 未注册 PM → skip 且不写 rebalances 行
  - `TREASURY_ENABLED=true` + 注册但 credits=0 → skip + warn 日志
  - executor 抛错 → `rebalances.status = failed`、`treasury_service_charges` 同 nonce 状态变 `refunded`
- **手动 (mainnet)**:
  ```bash
  bun run key:bootstrap                          # 确认 key 正确
  EXPECTED_AGENT_ADDRESS=0x... bun start         # 跑 30 分钟
  ```
  退出后 SQL:
  ```sql
  SELECT status, COUNT(*) FROM rebalances GROUP BY status;
  SELECT status, COUNT(*) FROM lending_actions GROUP BY status;
  SELECT status, COUNT(*) FROM treasury_service_charges GROUP BY status;  -- 若启用 treasury
  ```
  期望 succeeded 占比 > 90%,失败行有可读 `error` 字段(非 stack trace)。

---

## 测试矩阵 (Test Matrix)

| 模块 | 单元 | 集成 | 手动 | 主要空缺 |
|---|---|---|---|---|
| 1. 核心交易层 | 强 (txUnified + binMath + keypair 全套) | 无 | events:print,devInspect | `tx.ts` 旧版、`read.ts`、`events.ts`、`pool.ts` |
| 2. 借贷集成 | 强 (math + shortfall + lendingConfig) | 无 | lending:bootstrap + 小额循环 | **`router.decide()`** — 关键 |
| 3. 行情与预测 | 强 (garch + binWeights) | 无 | 长跑 agent + SQL 检查 | `onchain.ts` 价格 feed |
| 4. 策略引擎 | 部分 (经 backtest) | backtest 回放 | `STRATEGY=…` 切换观察 | `multiBinSpot.plan()` 直接单测 |
| 5. Treasury | 强 (51 tests / 5 files,覆盖 keypair+credits+store+watcher+registration) | 无 | 小额充值 + 调仓扣减全链路 | rebalancer 集成路径(算在模块 6)|
| 6. 编排与持久化 | 部分 (backtest) | 无 | `bun start` 30 min | **`rebalancer.tickOne()`、`executor.*`、`locks`、`subscriptions`** |

**总计:160 tests / 13 files / 全过。最高 leverage 的下一步是模块 6 的 rebalancer/executor 集成测试 + Treasury 在 rebalancer 内部的三种路径(ok/rejected/refunded),以及模块 2 的 router 决策树单测。**

---

## 端到端 (E2E) 验证 — 准备发布前的清单

按顺序执行,每步通过才能进入下一步:

```bash
# 1. 静态检查
bun install
bun run typecheck       # 应 0 输出
bun test                # 应 160 pass

# 2. 密钥与配置 (agent 角色)
#    生产 agent 地址 (mainnet,已锁定):
#    0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9
#    派生路径:m/44'/784'/1'/0'/0' (Sui Wallet style 账户索引 1,非默认地址)
echo "AGENT_MNEMONICS=<your phrase>" > .env
echo "EXPECTED_AGENT_ADDRESS=0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9" >> .env
echo "SUI_USDC_POOL_ID=0x..." >> .env          # 必须,mainnet 的池 ID
bun run scripts/verify-agent-address.ts        # 应 ✅ match
# 若偏好显式私钥,可设 AGENT_PRIVATE_KEY=suiprivkey1...,它优先级最高。

# 3. (可选) Treasury 角色
echo "TREASURY_ENABLED=true" >> .env
echo "TREASURY_MNEMONICS=<不同于 agent 的 phrase>" >> .env
echo "EXPECTED_TREASURY_MASTER_ADDRESS=0x..." >> .env
bun run scripts/verify-treasury-address.ts     # 应 ✅ match

# 4. 借贷 SDK 接入
bun run lending:bootstrap
# 期望输出:Scallop protocolPackageId/versionId/marketId、Kai vault 元数据

# 5. 短跑校验
bun start &
PID=$!
sleep 1800              # 30 分钟
kill -SIGINT $PID
wait

# 6. SQL 健康检查
sqlite3 ./data/app.db <<EOF
SELECT 'subs',        COUNT(*) FROM subscriptions WHERE status = 'active';
SELECT 'prices',      COUNT(*) FROM price_observations;
SELECT 'rebalances',  status, COUNT(*) FROM rebalances GROUP BY status;
SELECT 'lending',     status, COUNT(*) FROM lending_actions GROUP BY status;
SELECT 'charges',     status, COUNT(*) FROM treasury_service_charges GROUP BY status;
EOF
```

**通过标准:**
- `rebalances` 中 `succeeded` 占比 ≥ 90%
- `lending_actions` 中无 `failed` 行,或失败有可读的 `error` 字段
- `price_observations` 至少 100 条
- `treasury_service_charges` 中 `ok` 占比 ≥ 90%(若启用)
- 日志中无 `level=error` 行(`warn` 可接受)

任一不达标,先看对应模块的单元测试是否有相应覆盖 — 没有就补,有就走 debug。
