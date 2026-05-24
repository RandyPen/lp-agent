# DLMM 价格分布预测方案

> 日期：2026-05-17
> 目标：为 DLMM LP rebalancer 提供"未来 Δt 内价格在每个 bin 上的概率分布"的预测能力。

## 问题重写

DLMM LP 不需要"下一时刻价格"，需要的是**未来 Δt 内价格的概率密度**，再积分到每个 bin。三个量按重要性：

- **σ（波动率宽度）** — 决定 bin range，错了直接 IL 爆 / 没 fee。**预测相对容易，影响最大。**
- **μ（方向漂移）** — 决定 bin 中心。**预测难，影响小。**
- **形态（厚尾 / 多峰）** — log‑normal 够用，crypto 极端行情上 Student‑t。

策略沿"**波动率优先 → 分布预测 → 概率到 bin 的映射**"展开，不直接做"价格预测"。

## 技术方案：三层递进

### Tier 0：统计基线（v0 上线版）

| 模型 | 输出 | 备注 |
|---|---|---|
| **EWMA 波动率** | σ_{t+1} | 一行代码，crypto 短期基线 |
| **Parkinson / Garman‑Klass** | OHLC 估 σ，效率比 close‑close 高 4–8× | 直接用 swap 数据 |
| **GARCH(1,1)** | σ 的条件分布，捕捉波动率聚类 | 金融业标准基线（`arch` 库即可） |
| **HAR‑RV** | 多尺度（日/周/月）vol | 在 crypto 上常胜过深度模型 |

**输出**：(μ ≈ current_price, σ = GARCH 预测) → log‑normal → 数值积分到每个 bin → 归一化为权重。

**经验**：1h–24h horizon 上，GARCH + log‑normal 经常打败花哨模型 10–20%。一周可上线。

### Tier 1：概率梯度提升（v1 增强版）

- **LightGBM / XGBoost + pinball loss**：直接预测 10/30/50/70/90 分位数，拼出分布。
- **NGBoost**：原生输出参数化分布。
- **Conformal Prediction**：套在任何点预测器外面，保证 90% PI 真覆盖 90%。**LP 极其需要这种校准**。

**特征**：log return 滞后、Parkinson vol、RSI/MACD、funding rate、Cetus active bin drift、过去 N 个 swap 的方向流量。

### Tier 2：概率深度模型（数据充裕再上）

| 模型 | 适配 |
|---|---|
| **DeepAR**（GluonTS）| 概率 RNN，原生输出预测分布 ★★★★ |
| **Mixture Density Network** | NN 输出 Gaussian 混合权重，建模多峰分布 ★★★★ |
| **PatchTST / N‑HiTS** | 2023–2024 时序 SOTA ★★★ |
| **Chronos / Moirai / TimeGPT** | 时序基础模型，可 zero‑shot ★★★ |

**前提**：Cetus SUI/USDC 历史深度足够 + 严格 walk‑forward 回测 + conformal 校准。

### Tier 3：Regime‑switching（正交增强）

- **HMM / Markov‑switching GARCH**：识别 trending vs ranging regime，分别用不同 σ。crypto 非常需要。
- **Bayesian structural time series**（PyMC）：放先验，小样本友好。

可作为 ensemble 中的 regime 路由层。

## LLM 在方案中的位置

**核心原则：LLM 不直接输出 bin 权重或价格预测**（数值精度差、不可校准）。它退到"判断"和"语义"的位置。

### 1. Meta 控制器（最有价值）

- 监控 PnL、IL、fee 收益曲线，决定**是否切换 Tier 0 → Tier 1 / 暂停 agent / 触发额外 rebalance**。
- 收集 regime detector 输出 + 模型残差，判断"当前市场是否在模型适用域内"。
- 这是 LLM 真正擅长的：用判断代替算术。

### 2. 特征生成层

- 新闻 / Twitter / 链上事件摘要 → 转成数值特征（sentiment score、event severity）喂给 Tier 1 模型。
- 这条与 `项目.md` 里 "macro / news 输入" 的扩展直接对接。

### 3. Regime 标签生成

- 让 LLM 给历史 K 线片段打 "trending / ranging / news shock" 标签，作为 HMM 初始化或监督信号。
- 用 LLM 一次离线打标，比手工便宜得多。

### 4. 用户解释层

- 借用 Nof1 风格的 `justification` 字段，把数学层的决策翻译成自然语言（给用户 / 给运营 / 给审计）。
- 仅用于呈现，不进入决策回路。

### 5. 严格不做的事

- ❌ LLM 直接输出 bin 概率分布
- ❌ LLM 直接输出 (μ, σ)
- ❌ LLM 作为唯一的 rebalance 触发器

## 整体架构

```
                  ┌────────────────────────────────────────┐
                  │   News / Twitter / 链上事件             │
                  │            ↓                            │
                  │   LLM 特征抽取 → sentiment / events     │
                  └────────────────────┬───────────────────┘
                                       │
   Cetus K线 / swap flow / active bin ─┼─→ 特征工程
                                       │       ↓
                                       │   Tier 0  GARCH + log-normal
                                       │   Tier 1  Quantile GBM + Conformal
                                       │   Tier 2  DeepAR / MDN (可选)
                                       │       ↓
                                       │   价格分布 p(price, t+Δt)
                                       │       ↓
                                       │   BinUtils 数值积分 → bin 权重
                                       │       ↓
                                       │   E[fee] − E[IL] − cost 目标函数
                                       │       ↓
                                       │   候选 rebalance plan
                                       │       ↓
   ┌──────────────────────────────────┴─────┐
   │  LLM Meta 控制器                        │
   │   - 当前 regime 是否在模型适用域?         │
   │   - 是否值得付 gas 重平衡?                │
   │   - 异常退出 / 暂停?                     │
   │   → 通过 / 拒绝 / 修改                   │
   └──────────────────────┬─────────────────┘
                          │
                  CDPM Agent SDK（受权限约束）
                          ↓
                  add / remove liquidity
                          │
                          ↓
                  LLM justification 输出（给用户看）
```

## 与 Cetus DLMM 的关键约束

- **0.4% pool fee** = bin 边界附近有 dead zone，σ 估计与 bin 权重计算需把这点扣除，否则边界 bin 概率被高估。
- **Active bin 自身就是信号** — CDPM SDK 直接拿，比从 K 线反推 swap flow 更纯。
- **目标函数必须是 `E[fee] − E[IL] − rebalance_cost`**，不是预测准度。模型再准，rebalance 太频繁也亏。

## 落地路线

| 阶段 | 内容 | 周期 |
|---|---|---|
| v0 | GARCH + log‑normal + BinUtils 映射 + 简单回测框架 | 1 周 |
| v0.5 | LLM 接入 justification 输出层 | 2 天 |
| v1 | LightGBM 分位回归 + Conformal 校准 + 多 horizon | 2 周 |
| v1.5 | LLM Meta 控制器（regime 判别 + 暂停决策） | 1 周 |
| v2 | DeepAR / MDN + Regime switching ensemble | 1 月+ |
| v2+ | LLM 特征生成层（新闻 / Twitter） | 持续迭代 |

## 结论

- 不要把 LLM 当数值预测器用。
- **先用 GARCH 把 80% 价值拿到手**，工程精力花在**回测框架 + bin 映射 + CDPM 约束对接**上。
- 神经网络要上就上**概率输出**模型（DeepAR / MDN / PatchTST + quantile head），配合 conformal 校准与严格 walk‑forward 回测。
- LLM 退到 **meta 控制 / 特征生成 / 用户解释** 三个位置，发挥它真正强的地方。

---

## 模板当前实现状态

| 文件 | 实现 | 是否有学习 |
|---|---|---|
| `src/forecast/volatility.ts` | EWMA(λ=0.94) / Parkinson / Garman-Klass | ❌ 闭式公式，O(n) 单次扫描 |
| `src/forecast/binWeights.ts` | log-normal CDF 数值积分到 bin | ❌ 闭式 |
| `src/strategies/multiBinSpot.ts` | 用 volatility.ts 估 σ → log-normal → 权重 | ❌ |
| `src/strategies/emaTrend.ts` | 双 EMA 趋势分类 → 偏侧布仓 | ❌ EMA 衰减率由 period 决定 |
| `src/data/feeds/onchain.ts` | Cetus SwapEvent → price_observations 表 | ❌ |
| `src/data/feeds/binance.ts` | Binance REST → klines / ticker | ❌ |

**所有路径都没有 training step。** 这是有意的:模板不带 alpha,只带骨架。

---

## 升级到机器学习算法（Upgrading to a learned model）

如果你 fork 这个模板,想把 σ 估计或方向预测换成 ML(LightGBM quantile / GARCH MLE / LSTM / Transformer),按以下结构走 — **不需要改框架,走 Strategy 扩展点**。

### 1. 数据流(已经够用)

- 价格历史已经在 `price_observations` 表(由 `onchain.ts` / `binance.ts` 持续写入)
- 用 `SELECT pool_id, source, price, observed_ms FROM price_observations WHERE pool_id = ? AND observed_ms >= ?` 导出训练集
- 1 分钟 bar → `bucketToOhlcv()`(from `src/forecast/volatility.ts`)→ 特征工程

### 2. 离线训练(放 fork 里,不并回模板)

```
src/ml/
├── features.ts       # 从 SQLite 拉数据 + 滚窗特征(log returns、RSI、Parkinson σ、...)
├── train.ts          # CLI: bun run src/ml/train.ts --out=./models/sigma.bin
├── inference.ts      # 加载模型 + predict(features) → σ
└── types.ts          # FeatureVector / Prediction 接口
```

- 模型物件存 `./models/<name>.bin`,加到 `.gitignore`(运营本地维护,不入仓)
- 训练在你的开发机本地跑(LightGBM 几分钟,深度模型 GPU)
- 验收:walk-forward backtest 跑 `src/backtest/cli.ts`(模板已有),对比 ML σ vs EWMA σ 的 `fee − IL − cost`

### 3. 在线推断(运行时调用)

新策略 `src/strategies/mlBinSpot.ts` 实现 `Strategy` 接口:

```ts
import { loadSigmaModel } from "../ml/inference.ts";
import { computeBinWeights, pickBinRange } from "../forecast/binWeights.ts";

export function createMlBinSpotStrategy(): Strategy {
  const model = loadSigmaModel(process.env.SIGMA_MODEL_PATH || "./models/sigma.bin");
  return {
    name: "mlBinSpot",
    plan(input) {
      const features = buildFeatures(input.history, input.spot);
      const sigma = model.predict(features);   // ← ML 在这里替换 ewmaSigma
      // ...同 multiBinSpot.ts 的后续:log-normal → computeBinWeights → splitProportional
    }
  };
}
```

### 4. 注册 + 切换

```ts
// src/strategies/registry.ts
import { createMlBinSpotStrategy } from "./mlBinSpot.ts";
export type StrategyName = "singleBin" | "multiBinSpot" | "emaTrend" | "mlBinSpot";
const BUILDERS = { ..., mlBinSpot: () => createMlBinSpotStrategy() };
```

```bash
STRATEGY=mlBinSpot bun start
```

### 5. 必须做对的几件事

| 项 | 说明 |
|---|---|
| **冷启动兜底** | 模型加载失败 / 特征不足 → 回退 `ewmaSigma`,不要 throw |
| **推断耗时预算** | 每 tick < 100ms。LightGBM 单棵树 < 1ms,深度模型必须 batched / pre-warmed |
| **特征漂移监控** | 训练集 vs 在线 feature 分布偏移 → 定期重训。可写 `scripts/feature-drift.ts` |
| **conformal 校准** | 直接吐 σ 容易出现 mis-calibration。包一层 conformal interval 在 walk-forward 上验证覆盖率 |
| **回测 vs 实盘 gap** | 链上 fee/slippage、PTB 失败、subscription 中断会让实盘比回测差。先用小额 PM 跑 1 周再放量 |
| **多源 feed 时校正 CEX-DEX 偏差** | Binance 价 ≠ Cetus 池价(几 bp 持续 gap + 短期套利漂移)。混合时先 detrend |

### 6. 与 EMA 策略并存

EMA 策略和 ML 策略**不冲突**,可以分别按 PM 启用(目前 `STRATEGY` env 是全局的,但 strategy 是 per-PM 调度的,改 rebalancer 让它根据 `subscriptions.strategy_pref` 列选 — 这是 v2 扩展点)。
