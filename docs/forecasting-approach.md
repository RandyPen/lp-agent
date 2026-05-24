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
