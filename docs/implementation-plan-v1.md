# ML-Driven Cetus DLMM Market-Making Agent — v1 实施方案

> 版本:v2.0(重写,取代 v1.0 的 Rust napi / 六态方案)
> 配套文档:`prediction-service-design.md`(sidecar 架构)、`decision-engine-design.md`(三态状态机)、
> `risk-monitoring-design.md`、`backtest-framework-design.md`、`data-sources.md`、`forecasting-approach.md`

## Context

LiquidityManager 当前是一个**规则驱动**的 Cetus DLMM 自动做市 Agent(~7 kLOC TS / 172 tests),挂载 3 个规则策略(`singleBin` / `multiBinSpot` / `emaTrend`)、单一 PoolProfile(`sui-usdc`)、双源行情(Binance + Cetus on-chain),靠 EWMA / Parkinson σ 估计 + 几何 bin 权重做被动报价。

v1 目标:把决策中心从"基于当前 active_bin + 历史 σ"切换到"基于 **LightGBM 分位数预测**的 future center_bin + 模型 width + 穿越概率",并引入**三态状态机**(NORMAL / TREND / EXTREME)统一调度评估间隔、半宽、lending 比例、容忍偏移。新增 `mlAgent` 策略作为主策略,旧策略保留作 Tier 0 降级兜底。

**与 v1.0 计划的关键差异**(决策记录):

1. **推理架构:Python sidecar,不是 Rust napi。** 决策频率是每池 15–30 分钟一次,延迟预算是分钟级;Rust 推理的亚毫秒优势在这个工作负载下没有价值,而代价是双语言特征契约(train/serve skew 的经典事故源)+ 第三条工具链 + 已知的 macOS arm64 踩坑史。推理留在 Python,训练与推理**共享同一份特征代码**。TS 侧通过 `PredictionProvider` 接口隔离,Rust 实现留作 v2 的可选演进(触发条件:决策频率进入秒级,或推理路径出现真算力消耗)。
2. **`Strategy.plan` 改为异步签名。** `rebalancer.tickOne` 本身就是 async,`plan()` 在 async 上下文中被调用——改成 `plan(input): Promise<StrategyOutput>` 是一处接口改动 + 4 个现有策略补 `async`。v1.0 计划里整套 `predictSync` / 同步缓存 / 陈旧预测兜底的复杂度因此消失。
3. **状态机从六态收敛到三态。** NARROW/WIDE 不是离散状态——模型已经输出 `widthSigma`,半宽应是 σ̂ 的连续函数,不要把连续量再离散化回档位。TREND_W/TREND_S 合并为 TREND,偏置强度 = f(p_above − p_below) 连续化。自由度从 ~40 个手拍参数降到 ~12 个。
4. **训练窗口从 30 天拉长到 6–12 个月。** 30 天 1min 数据(~43k 行,30min 重叠标签自相关严重)对 60–120 维模型必然过拟合。Binance SUI 现货有数年历史;Cetus 侧特征(active_bin drift、swap flow)因历史只有数周,**v1 不进特征集**,v1.1 数据积累够了再加。特征从 60–120 维砍到 20–30 维起步。
5. **验收 gate 从单窗口 PnL 换成预测质量 + 单位经济学。** "30d PnL ≥ 1.2× baseline"、"24h 实盘 PnL ≥ 影子 60%" 在 $500 量级上是统计噪声,且 L1 回测的 fill 模型有系统性偏差。主 gate 改为 pinball loss / 区间覆盖率 / 方向准确率(可证伪、与模拟器无关)+ 每状态的"期望日成本 vs 期望日 fee 收入"预算表;PnL 降为 ≥30 天观察指标。
6. **风控与影子基建提前到 W1–2,模型最后接入。** 对一个量化流动性托管开源项目,熔断/风控/审计日志是产品本体,模型是可换的 alpha。影子模式用 dummy 预测器先打通全链路,跑得越早,模型上线时对照数据越厚。

---

## 1. 八周路线图

每周一行,列出本周交付物 + 关键文件路径 + 验收标志。

| 周 | 交付物 | 关键文件 | 验收标志 |
|---|---|---|---|
| **W1** | ① 多源行情采集:Binance SUIUSDC / BTC / ETH 1m+5m 实时 + **6–12 个月历史回填**,衍生品 funding/OI/清算,落 parquet。② **Cetus swap 事件历史扫块**(一等公民:fee 模型标定 + 影子验证的唯一事实来源)。③ 风控骨架:`risk_events` 表 + `riskMonitor.checkPreTick` 接入现有规则策略 + EXTREME 全撤路径。 | `src/data/feeds/binanceMulti.ts`、`src/data/feeds/derivatives.ts`、`src/data/feeds/cetusEvents.ts`、`src/risk/{monitor,circuits}.ts`、`ml/data/collectors/*.py`、`scripts/collect-historical.ts`、`scripts/backfill-cetus-events.ts` | ≥ 180 天 Binance parquet,与上游 API 对账误差 < 0.1%;Cetus 事件回填到链上可得的最早时点;`risk_events` 在模拟触发下正确落库;EXTREME 全撤路径在 testnet 演练通过 |
| **W2** | ① `Strategy.plan` 异步化(全仓重构)。② `PredictionProvider` 接口 + `NullPredictionProvider`(dummy:center=0、width=EWMA σ)。③ `mlAgent` 骨架 + 三态状态机拓扑 + `predictions` / `market_state_history` 表(按 pool 键)。④ **影子模式开始跑**(mlAgent-dummy vs 现役规则策略,只记录不执行)。 | `src/strategies/types.ts`、`src/prediction/{types,provider,nullProvider}.ts`、`src/strategies/mlAgent.ts`、`src/state/{machine,transitions,params}.ts`、`src/db/schema.sql` | `bun test` 全绿(plan 异步化不破坏 172 个现有测试);影子模式 24h 连跑,`predictions` 与 `market_state_history` 持续落库,三态各至少触发一次(EXTREME 用模拟数据注入) |
| **W3** | 标签生成 + 特征工程(**20–30 维**,纯 Binance 源)+ LightGBM 分位回归训练管线 + walk-forward(purged k-fold + embargo) | `ml/data/labels.py`、`ml/data/alignment.py`、`ml/features/{momentum,volatility,cross_asset,derivatives,time}.py`、`ml/training/{train_quantile,walk_forward}.py` | `pytest ml/tests/` 全过(vwap 边界、bin 舍入、未来窗口截断);walk-forward 报告 `ml/reports/wf_<date>.json`:**pinball loss < 0.9× baseline**(baseline = center=0 + EWMA σ),q10/q90 经验覆盖 76–84%,方向准确率 > 52% 且 binomial test p < 0.05 |
| **W4** | Python 推理 sidecar(FastAPI:/predict、/health、/reload)+ PSI 漂移监控 + 模型版本管理;TS 侧 `SidecarPredictionProvider`(超时 → fallback 标记);模型接入影子模式 | `ml/serving/{app,psi,registry}.py`、`ml/artifacts/v1.0.0/`、`src/prediction/sidecarProvider.ts`、`tests/prediction/sidecarProvider.test.ts` | `bun test tests/prediction/` 通过(正常推理、超时 fallback、版本切换);sidecar p99 < 200ms;影子模式切到真模型,`fallback` 占比 < 20% |
| **W5** | 回测与标定:L1 回测(**只做同模拟器相对排序**)+ fee 模型用 Cetus 真实事件标定 + **单位经济学预算表**(每状态:期望日 gas + treasury 扣费 vs 期望日 fee 收入)+ 三态参数 grid search | `ml/backtest/l1_runner.py`、`ml/backtest/fee_model.py`、`ml/reports/economics_<date>.md`、`src/backtest/cli.ts`(加 `--strategy=mlAgent`) | L1 下 mlAgent 相对排序 ≥ multiBinSpot(同一模拟器、同期);每状态经济学预算表通过:期望日成本 < 期望日 fee 收入 × 50%;参数表冻结进 `src/state/params.ts` |
| **W6** | 决策引擎完善:差量执行、PTB ≤ 6 op、容忍偏移、库存修正、Ask 最小利润、TREND 反向仓位;lending router 加 `stateBias`;L3 紧急停机 | `src/decision/{diffPlanner,inventory,ageStopLoss}.ts`、`src/sui/lending/router.ts`、`src/risk/emergency.ts` | PTB size 单元测试(≤6 op 硬约束);影子模式含完整决策链 48h 连跑;模拟数据中断触发一次 Tier 0 回退(`emaTrend`)并自动恢复 |
| **W7** | 影子模式 **14 天**连跑 + 监控/告警/PnL 归因接线 + 影子报告 | `src/risk/pnlAttribution.ts`、`reports/shadow_<date>.md` | 14 天无 L3;fallback 占比 < 20%;状态切换 5–50 次/天;在线区间覆盖率与离线 walk-forward 差 < 5pp;不达标 → 回 W3 重训或回 W5 调参,**不进 W8** |
| **W8** | 小额实盘(≤ $500)+ runbook + 退出标准 | `docs/runbook-v1.md`、`scripts/live-canary-start.ts`、`scripts/live-canary-kill.ts` | 实盘 72h:无 L3;交易成功率 > 95%;fee 收入 > gas + treasury 扣费;Cetus-Binance 价差 < 0.5% 时间占比 ≥ 95%。**PnL 只记录不作 gate**(72h 无统计意义) |

W7 是硬闸门:影子不达标不进实盘,退回重训/调参,时间从 v2 排期里扣,不压缩 W8。

---

## 2. 仓库结构变更

两条工具链:**Bun(TS 运行时)+ uv(Python 训练与推理 sidecar)**。无 Rust、无 napi、无 workspace 化的必要——`ml/` 是独立 uv 项目,不进 `package.json`。

```
LiquidityManager/
├── package.json                   # 不变(不需要 workspace root)
├── ml/                            # Python(uv 管理)
│   ├── pyproject.toml
│   ├── data/{collectors/,labels.py,alignment.py,parquet_writer.py}
│   ├── features/{momentum,volatility,cross_asset,derivatives,time}.py
│   │                              # ← 训练与 serving 共享,这是砍掉 Rust 的核心收益
│   ├── training/{train_quantile.py,walk_forward.py,export.py}
│   ├── serving/{app.py,psi.py,registry.py}      # FastAPI sidecar
│   ├── backtest/{l1_runner.py,fee_model.py}
│   ├── artifacts/v1.0.0/{q10,q50,q90,vol}.txt + models_meta.json + psi_baseline.json
│   └── tests/
├── src/
│   ├── prediction/                # 新增:推理客户端(接口 + 实现)
│   │   ├── types.ts               # PredictionResponse / MarketSnapshot
│   │   ├── provider.ts            # PredictionProvider 接口(开源接缝)
│   │   ├── nullProvider.ts        # dummy 实现(W2 打通链路 / 测试)
│   │   └── sidecarProvider.ts     # HTTP → Python sidecar
│   ├── state/                     # 新增:三态状态机
│   │   ├── machine.ts
│   │   ├── transitions.ts
│   │   └── params.ts              # 三态参数表(本 plan §5)
│   ├── risk/                      # 新增:三层风控(W1 先行)
│   │   ├── monitor.ts             # L1 软熔断
│   │   ├── circuits.ts            # L2 进 EXTREME
│   │   ├── emergency.ts           # L3 紧急停机
│   │   └── pnlAttribution.ts      # PnL 归因
│   ├── decision/                  # 新增
│   │   ├── diffPlanner.ts
│   │   ├── inventory.ts
│   │   └── ageStopLoss.ts
│   ├── data/
│   │   ├── marketAggregator.ts    # 多源 snapshot 汇总 + 心跳
│   │   └── feeds/
│   │       ├── binanceMulti.ts    # SUIUSDC + BTC + ETH
│   │       ├── derivatives.ts     # funding/OI/清算
│   │       └── cetusEvents.ts     # active_bin / TVL / swaps + 历史扫块
│   └── strategies/
│       ├── mlAgent.ts             # 新主策略
│       ├── registry.ts            # 加入 mlAgent
│       └── (singleBin/multiBinSpot/emaTrend 保留为 Tier 0)
└── docs/runbook-v1.md             # W8
```

### 2.1 开源化硬性整改(随 v1 一起做,不另开计划)

这个仓库将以"量化流动性托管 Agent"的定位开源,以下是 fork 用户的信任前提:

| 项 | 现状 | 整改 |
|---|---|---|
| `tests/` 被 .gitignore | 172 个测试不入库 | **取消 ignore,测试入库**——这是开源项目的第一信任信号 |
| `scripts/` 被 .gitignore | 生产工具脚本不入库 | 拆分:可复用的(verify-address、collect-historical、backfill)入库;含操作者本机信息的保持本地 |
| `*.md` 被 .gitignore | 文档靠 `git add -f` | 取消对 `docs/` 与根 README 的 ignore |
| LICENSE | 无 | 加(建议 Apache-2.0) |
| CI | 无 | GitHub Actions:`bun test` + `pytest ml/tests/` + lint |
| 训练可复现 | — | 固定 seed;`scripts/collect-historical.ts` 让任何 fork 能重建训练集;`models_meta.json` 记录数据窗口与 git sha |

模型产物(`ml/artifacts/`)**不入库**——fork 自己训练,仓库交付的是管线与骨架,不是 alpha 本身。

---

## 3. 关键接口契约

### 3.1 `Strategy.plan` 异步化(W2 前置重构)

```ts
// src/strategies/types.ts — 唯一的破坏性改动
export interface Strategy {
  readonly name: string;
  plan(input: StrategyInput): Promise<StrategyOutput>;   // 原为同步
}
```

`rebalancer.tickOne` 已是 async,调用点改一处 `await`;`singleBin` / `multiBinSpot` / `emaTrend` / `lendingPolicy` 函数体不变,签名补 `async`。`StrategyOutput` 四种 kind 与 `fillBoundary` 语义全部不变。

### 3.2 PredictionProvider(开源接缝)

```ts
// src/prediction/provider.ts
export interface PredictionProvider {
  readonly name: string;
  predict(snapshot: MarketSnapshot, ctx: PmRangeContext): Promise<PredictionResponse>;
  health(): Promise<ProviderHealth>;
}
```

这是 fork 替换模型的唯一接口:换自己的 sidecar、远端服务、或将来的 Rust 实现,框架不动。v1 提供两个实现:

- `NullPredictionProvider` — `centerOffset=0`、`widthSigma=EWMA σ 换算成 bin`、`pAbove/pBelow` 用 log-normal 闭式。W2 打通链路、测试、以及 sidecar 不可用时的最终兜底语义参照。
- `SidecarPredictionProvider` — HTTP POST 到本地 Python sidecar,超时 2s。失败/超时**不抛出也不静默**:返回 `fallback` 字段标记原因,由 `mlAgent` 显式切 Tier 0 并记录。

### 3.3 TS 内类型(`src/prediction/types.ts`)

```ts
export interface MarketSnapshot {
  ts: number;
  cetus: { activeBin: number; price: string; tvlUsd: number; binStep: number };
  binance: { sui: OhlcvBar[]; btc: OhlcvBar[]; eth: OhlcvBar[] };
  derivatives: { funding: number; oi: number; liq1m: number };
  spread: number;            // (cetus - binance) / binance
}

export interface PredictionResponse {
  centerOffset: number;      // q50,bin 单位,相对 active
  centerQ10: number; centerQ90: number;
  widthSigma: number;        // (q90 - q10) / 2.56
  pAbove: number; pBelow: number;
  modelVersion: string;
  featureCompleteness: number;
  psi: number;
  fallback: false | "psi" | "missing" | "stale" | "sidecar_down" | "timeout";
}

export type MarketState = "NORMAL" | "TREND" | "EXTREME";

export interface StateContext {
  state: MarketState; enteredAtMs: number;
  evalIntervalMs: number;
  halfWidth: number;         // 连续值,= f(widthSigma),见 §5
  trendBias: number;         // [-1, 1],TREND 态的单侧偏置强度,= f(pAbove - pBelow)
  lendingPct: number; toleranceBins: number;
  minDwellMs: number;
}
```

### 3.4 Python sidecar HTTP 契约

详见 `prediction-service-design.md`。摘要:

```
GET  /health   → { status, model_version, loaded_at, psi_summary }
POST /predict  → 入参 MarketSnapshot(JSON),出参 PredictionResponse(JSON)
POST /reload   → { artifact_dir } → { model_version }   # 热加载,鉴权:仅监听 127.0.0.1
```

特征组装、缺失值默认、归一化全部在 sidecar 内完成,**与训练共享 `ml/features/` 同一份代码**——不存在跨语言特征契约,`models_meta.json` 只需要 `version` / `trained_at` / `data_window` / `sha256`。

### 3.5 `mlAgent` Strategy

```ts
// src/strategies/mlAgent.ts
export function createMlAgentStrategy(deps: {
  provider: PredictionProvider;          // sidecar 或 null 实现
  stateMachine: StateMachine;
  riskMonitor: RiskMonitor;
  marketAggregator: MarketAggregator;    // ws 后台更新,latest() 取缓存
  fallback: Strategy;                    // Tier 0(emaTrend)
}): Strategy {
  return {
    name: "mlAgent",
    async plan(input: StrategyInput): Promise<StrategyOutput> {
      // 1. 前置风控
      const veto = deps.riskMonitor.checkPreTick(input);
      if (veto?.kind === "emergency") return { kind: "quiet", reason: veto.reason };

      // 2. snapshot + 推理(异步,延迟预算分钟级,无需缓存陈旧预测)
      const snapshot = deps.marketAggregator.latest();
      const pred = await deps.provider.predict(snapshot, rangeCtx(input.pm));

      // 3. 模型失败 / PSI 漂移 → Tier 0 兜底(显式记录,不静默)
      if (pred.fallback) {
        recordFallback(input.pm.pmId, pred.fallback);
        return deps.fallback.plan(input);
      }

      // 4. 三态判定 + 连续参数推导
      const ctx = deps.stateMachine.advance(snapshot, pred, input);

      // 5. 差量计算
      const plan = diffPlan(input.pm, input.pool, ctx, pred);
      if (!plan) return { kind: "quiet", reason: "below min threshold" };

      return { kind: "plan_and_reconcile", plan, fillBoundary: targetCenter(pred, ctx) };
    },
  };
}
```

### 3.6 Lending router 扩展(向后兼容,不变)

```ts
export interface RouteOptions {
  pm: PMState; profile: PoolProfile; shortfall: { a: bigint; b: bigint };
  stateBias?: { targetLendingPct: number };   // 由状态机注入
}
```

保留现有 APY-aware 决策树 + 60% 单协议上限 + 跨协议白名单。`targetLendingPct` 只影响 supply 比例,不改变 redeem cover-shortfall 路径。

---

## 4. 复用与新写矩阵

| 领域 | 复用 | 新写 | 删除/放弃 |
|---|---|---|---|
| 波动率 | `src/forecast/volatility.ts`(EWMA/Parkinson/GK)— NullProvider 的 σ 源 + Tier 0 的 σ 输入 | `ml/features/volatility.py` 同三指标作 ML 特征(Python 侧实现一次,训练推理共用) | — |
| Bin 权重 | `src/forecast/binWeights.ts` 几何/正态权重,`diffPlanner` 换 σ 来源后直接复用 | `src/decision/diffPlanner.ts` | — |
| 策略 | `emaTrend` / `multiBinSpot` 保留 Tier 0;`singleBin` 留作 EXTREME 后最小报价备用 | `mlAgent` | — |
| 数据源 | `binance.ts` 的 WS 心跳/重试基建给 `binanceMulti.ts`;`onchain.ts` 给 `cetusEvents.ts` | `binanceMulti` / `derivatives` / `cetusEvents` / `marketAggregator` | — |
| Rebalancer | `tickOne` 整体保留;lending shortfall、Treasury 扣费链不动 | 入口前置 `riskMonitor.checkPreTick`;evalInterval 由状态机提供 | — |
| 推理 | — | `src/prediction/*` + `ml/serving/*` | **Rust crate / napi 绑定(v1.0 计划项,整体放弃;v2 经 PredictionProvider 评估)** |
| 状态机 | — | 三态 `src/state/*` | **六态拓扑及其参数表(v1.0 计划项,放弃)** |
| Backtest | `src/backtest/replay.ts` 骨架 | `ml/backtest/l1_runner.py` + `fee_model.py`(Cetus 事件标定) | — |
| Treasury | 全部保留不动 | — | — |

---

## 5. 三态状态机参数(v1 初值,W5 grid search 标定)

### 5.1 连续参数推导(代替 NARROW/WIDE 离散档)

```
halfWidth      = clamp(round(k_w × widthSigma), 2, 8)        # k_w 初值 2.0
toleranceBins  = max(1, round(widthSigma))                    # 容忍偏移随不确定性放宽
maxCenterOffset= uncertainty > u_high ? 1 : clamp(round(widthSigma), 1, 3)
                                                              # 模型没把握时中心贴回 active
trendBias      = clamp((pAbove - pBelow) / 0.5, -1, 1)        # TREND 态单侧偏置强度
lendingPct     = base[state] + 10pp × overWidthPenalty        # L1 软熔断时再 +10pp
```

### 5.2 状态表

| 状态 | 进入条件 | 评估间隔 | 行为 | lending 基线 | 最短驻留 |
|---|---|---|---|---|---|
| NORMAL | 默认 | 20 min(active bin 移动 ≥ toleranceBins 触发额外评估) | 围绕 `active + clip(centerOffset, ±maxCenterOffset)` 布正态权重,半宽 = halfWidth | 35 % | 15 min |
| TREND | `drift_strength > 2.0` 持续 2 个 1min 窗,或 `max(pAbove,pBelow) > 0.6` | 15 min | 不用预测中心(移动靶);单侧偏置权重 1±0.3×trendBias;强趋势(`|trendBias| > 0.7`)收缩为反向 25% 仓位 | 50–70 %(随 trendBias 线性) | 15 min |
| EXTREME | 见 5.3 | 1 min | 全撤 + 100% lending | 100 % | 10 min |

### 5.3 EXTREME 触发与退出(沿用 risk-monitoring-design.md)

- 进入:价格 5min 波动 > 10% / TVL 5min 跌 > 50% / 价差 > 5% 持续 30s / `pAbove + pBelow > 0.7` / 24h PnL < −5% / 数据全源故障
- 退出:全部条件解除 + 稳定 10 min(滞回:波动率恢复阈值 7%)+ 链上对账通过;渐进恢复(先半仓)
- L1 软熔断(价差 0.5–1%):不切状态,lendingPct +10pp 且 halfWidth × 0.7

### 5.4 降级语义(代替六态 α 混合表)

不再有连续 α。两种状态,边界清晰:

- **预测可用**:用预测中心 + 模型宽度;`uncertainty` 高只收紧 `maxCenterOffset`(中心贴回 active),不改其他参数。
- **预测不可用**(`fallback ≠ false`):`mlAgent` 整体让位给 Tier 0 策略(`emaTrend`),并记录 fallback 原因到 `predictions.fallback`。恢复条件:连续 3 次成功推理且 PSI < 0.25。

---

## 6. 数据库 schema 变更

在 `src/db/schema.sql` 末尾追加(`IF NOT EXISTS`,无迁移文件,与现有约定一致)。

**键形状说明**:预测与市场状态是**池级别**事实,按 `pool_id` 键;多 PM 同池不重复落行。PM 维度只出现在 `risk_events`(熔断可能针对单个 PM)。

```sql
CREATE TABLE IF NOT EXISTS predictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         TEXT NOT NULL,
  ts_ms           INTEGER NOT NULL,
  model_version   TEXT NOT NULL,
  active_bin      INTEGER NOT NULL,
  center_q10      REAL NOT NULL,
  center_q50      REAL NOT NULL,
  center_q90      REAL NOT NULL,
  width_sigma     REAL NOT NULL,
  p_above         REAL NOT NULL,
  p_below         REAL NOT NULL,
  feature_completeness REAL NOT NULL,
  psi             REAL NOT NULL,
  fallback        TEXT,
  infer_ms        INTEGER NOT NULL,
  snapshot_digest TEXT              -- 6 个关键字段的压缩摘要;完整特征行落 parquet,不进 SQLite
);
CREATE INDEX IF NOT EXISTS predictions_pool_ts ON predictions(pool_id, ts_ms DESC);

CREATE TABLE IF NOT EXISTS market_state_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         TEXT NOT NULL,
  entered_at_ms   INTEGER NOT NULL,
  exited_at_ms    INTEGER,
  state           TEXT NOT NULL CHECK(state IN ('NORMAL','TREND','EXTREME')),
  trigger         TEXT NOT NULL,
  prev_state      TEXT
);
CREATE INDEX IF NOT EXISTS state_pool_entered
  ON market_state_history(pool_id, entered_at_ms DESC);

CREATE TABLE IF NOT EXISTS risk_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         TEXT,
  pm_id           TEXT,              -- 可空:池级事件无 pm
  ts_ms           INTEGER NOT NULL,
  level           TEXT NOT NULL CHECK(level IN ('L1','L2','L3')),
  kind            TEXT NOT NULL,
  metric          TEXT NOT NULL,
  threshold       REAL NOT NULL,
  observed        REAL NOT NULL,
  action          TEXT NOT NULL,
  resolved_at_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS risk_events_ts ON risk_events(ts_ms DESC);
```

v1.0 计划中的 `feature_log` 表**取消**——特征行是训练数据,统一落 parquet(`ml/data/`),SQLite 不存第二份。

---

## 7. v1 范围内不做的事

- **Rust 推理引擎 / napi 绑定**(v2 经 `PredictionProvider` 接口评估,触发条件:秒级决策频率)
- **六态状态机**(三态 + 连续参数已覆盖;若回测证明需要更细分档再加)
- Cetus 侧特征进模型(swap flow、active_bin drift —— 历史不足,v1.1)
- macro / news / LLM 接入(特征位不预留;接入走 `PredictionProvider` 装饰器或 sidecar 内部,不动框架)
- 多 PM 策略分化(所有 PM 共享同一 `mlAgent` + 池级状态机)
- L2 / L3 高保真回测(网络延迟模拟、真实 RPC 重放)
- Tier 2 深度模型(LSTM / Transformer / MDN)
- 跨链 / 多池 / 多 PoolProfile(锁定 `sui-usdc` 单池)
- 自动重训(W8 后人工触发,灰度部署)
- Seal 加密模型分发(模型明文落 `ml/artifacts/`,不入库)
- 多交易所降级 OKX(仅留接口)

---

## 8. 验证步骤(end-to-end)

**W1–W2 数据 + 风控 + 骨架**
- `pytest ml/tests/` 100% 通过;`scripts/verify-data-coverage.ts`:≥180 天 parquet 无 > 5min 缺口
- Cetus 事件回填行数与 RPC 抽查对账一致
- 风控演练:注入模拟闪崩 → L2 进 EXTREME → 全撤 PTB 在 testnet 成功 → 滞回退出
- 影子模式(dummy 预测)24h 连跑无崩溃

**W3–W4 模型 + sidecar**(主 gate,可证伪、与模拟器无关)
- pinball loss < 0.9× baseline(center=0 + EWMA σ)
- q10/q90 经验覆盖 76–84%(目标 80%)
- q50 方向准确率 > 52%,binomial test p < 0.05
- PSI 自检 < 0.05;sidecar p99 < 200ms;在线推理与离线训练对同一特征行输出一致(共享代码,此项为冒烟而非契约测试)

**W5 经济学 gate**(v1.0 计划完全缺失的一项)
- 每状态预算表:`期望日成本(gas + treasury 扣费) < 期望日 fee 收入 × 50%`
- 成本侧:按状态评估间隔 × 状态出现频率(影子数据)× 单次 rebalance 成本
- 收入侧:用 Cetus 真实事件标定的 fee 模型,不用 Binance 量外推
- L1 回测只看相对排序:同模拟器下 mlAgent ≥ multiBinSpot

**W7 影子上线判定(硬闸门)**
- 连续 14 天无 L3;fallback 占比 < 20%
- 状态切换 5–50 次/天(过高 = 状态机抖动,过低 = 阈值失灵)
- 在线区间覆盖率与离线 walk-forward 差 < 5pp(模型在线下没有退化)
- 不达标 → 回 W3 重训或 W5 调参,不进实盘

**W8 小额实盘红线**
- 上线条件:W7 全达标 + 资金 ≤ $500
- 自动监控(全部已在 W1–W6 落地,此处只是启用):
  - 推理 fallback 持续 1h → 自动回退 Tier 0 并报警
  - 24h PnL < −5% → L2 进 EXTREME(全撤 + 100% lending)
  - 价差 > 5% 持续 30s → EXTREME
  - 交易成功率 < 95%(连续 50 笔)→ L1 软熔断 10min
- 72h 通过(无 L3、成功率、fee > 成本)→ 上限提至 $5,000;**PnL 作为观察指标持续记录 ≥ 30 天后才参与 v2 决策**

---

## 9. 关键修改文件清单

- `src/strategies/types.ts` — `Strategy.plan` 改异步(唯一破坏性改动,W2)
- `src/strategies/registry.ts` — 注册 `mlAgent`,加 `FALLBACK_STRATEGY` 配置
- `src/services/rebalancer.ts` — `tickOne` 入口前置 `riskMonitor.checkPreTick`;`strategy.plan` 调用点加 `await`;evalInterval 由状态机提供
- `src/sui/lending/router.ts` — `decide()` 接受 `stateBias?: { targetLendingPct }`
- `src/db/schema.sql` — 末尾追加 3 张表(§6)
- `src/config.ts` — 新增 `prediction.sidecarUrl`、`prediction.timeoutMs`、`ml.shadowMode`、`risk.thresholds.*`;现有 `EXPECTED_*_ADDRESS` 校验链不动
- `src/data/feeds/binance.ts` — WS 心跳/重试基建供 `binanceMulti.ts` 复用
- `.gitignore` — 取消 `tests/`、`docs/*.md`、核心 `scripts/` 的 ignore(§2.1)

---

## 10. 风险与权衡

1. **Cetus 历史事件扫块工作量不确定**:按时间窗扫块受 RPC 限速,W1 给整周并行跑;若链上可得历史 < 90 天,fee 模型标定窗口相应缩短并在经济学报告中标注置信区间。
2. **sidecar 单点**:Python 进程挂掉 → `SidecarPredictionProvider` 超时 → Tier 0 兜底,Agent 不停摆。sidecar 由 supervisor(launchd / systemd / pm2)自动拉起;`/health` 进监控。
3. **30min horizon 方向预测可能就是学不到**:gate 设在 52% 而非 55%,且允许"方向不显著但宽度校准达标"的降级路线——只用 widthSigma 与 pAbove/pBelow(σ 预测价值 > μ,见 forecasting-approach.md),中心保持 active。这条路线仍优于现状(规则 σ)。
4. **三态参数标定**:自由度 ~12,W5 grid search 在影子数据上做;W2 只冻结拓扑(三状态 + 转移条件代码)。
5. **状态抖动**:最短驻留 + 滞回已设计;影子期监控切换次数(5–50 次/天带),超带视为标定失败。
6. **PTB 6-op 上限**:计算错误导致 gas 失败回滚,W6 必须有专门的 PTB size 单元测试。
7. **影子 vs 实盘 fill 差异**:影子是模拟成交,$500 实盘的对手方行为不同;W8 头 24h 人工盯盘,且 PnL 不作 gate 正是为此。
8. **`.gitignore` 整改的迁移成本**:tests/scripts 入库涉及清理硬编码路径与本机信息,W2 顺带做,入库前过一遍 secrets 扫描。
