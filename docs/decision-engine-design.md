# 决策调仓方案

> 版本:v2.0(重写:六态 → 三态;Rust 执行层 → 复用现有 TS 执行链)
> 基础文档:data-sources.md、prediction-service-design.md、implementation-plan-v1.md
> 定位:连接「预测输出 + 状态机」与「链上操作」的决策执行层
> 技术栈:TypeScript(全部)。差量计算每 tick 处理 ≤ 20 个 bin 的算术,无性能问题;
> PTB 构造与提交复用现有 `src/sui/cdpm/txUnified.ts` + `src/services/executor.ts`,不重写。

---

## 一、定位与边界

### 1.1 在系统中的位置

```
┌─────────────────────────────────────────────────────┐
│  预测服务(prediction-service,Python sidecar)        │
│  输出:center_offset、width_sigma、p_above/below、σ̂   │
└──────────────────────┬──────────────────────────────┘
                       │ PredictionProvider(TS 接口)
┌──────────────────────┴──────────────────────────────┐
│  决策调仓层(本文档,挂在 mlAgent Strategy 内)          │
│  1. 状态判定(三态,结合预测 + 实时指标)               │
│  2. 连续参数推导(halfWidth、trendBias、容忍偏移)      │
│  3. 目标流动性分布计算                                 │
│  4. 库存修正、成本基础保护                             │
│  5. 差量计算(目标 vs 当前)+ Gas 预算筛选              │
│  6. 输出 RebalancePlan → 现有 rebalancer 执行链        │
└──────────────────────┬──────────────────────────────┘
                       │ StrategyOutput(plan_and_reconcile)
┌──────────────────────┴──────────────────────────────┐
│  现有执行链(不动):rebalancer.tickOne → executor      │
│  → txUnified PTB(collect→remove→transfer→add 原子)   │
│  → lending router(post-hoc supply/redeem)            │
│  → Treasury 扣费(attemptCharge/refundCharge)          │
└─────────────────────────────────────────────────────┘
```

与 v1.0 的关键差异:决策层**不再自带执行层**。v1.0 设计了 Rust diff/PTB/executor 模块,但仓库现有的 TS 执行链(`txUnified.ts` 原子 PTB、`executor.ts` 提交确认、`rebalancer.ts` 编排 + Treasury 扣费)已经覆盖该职责且经过实盘验证。决策层的输出就是现有的 `RebalancePlan`,在 `Strategy.plan()` 内完成全部计算。

### 1.2 核心转换

```
(预测分布 + 状态 + 当前持仓 + 约束)→ RebalancePlan(removeShares / addBins / addAmounts)
```

### 1.3 必须遵守的硬约束(来自 CDPM)

- 只能在 PM 的 [lowerBin, upperBin] 范围内操作
- 不能在 active bin 上挂单(最小价差 2×bin_step = 1%)
- 不能主动 swap;不能修改 PM 范围;不能提取资金到外部
- 只能:add/remove liquidity、lending supply/redeem、收 fee

---

## 二、三态状态机

### 2.1 为什么从六态收敛到三态(决策记录)

v1.0 的 NARROW/NORMAL/WIDE 三档,本质是"半宽随波动率变化"——但预测服务已经输出连续的 `width_sigma`,把连续量离散成三档再各配一套参数,是丢信息且多出 ~20 个待标定自由度。TREND_W/TREND_S 同理:偏置强度可由 `p_above − p_below` 连续推导。收敛后:

- 离散状态只保留**行为模式真正不同**的三种:对称做市(NORMAL)、单侧偏置/收缩(TREND)、全撤(EXTREME)
- 档位参数变成连续函数,自由度从 ~40 降到 ~12,W5 影子数据上 grid search 可标定
- 若回测证明某个区间需要独立行为,再加状态——加状态是一行枚举,删状态要清理整张参数表

### 2.2 状态定义

| 状态 | 进入条件 | 评估间隔 | 行为概要 | lending 基线 | 最短驻留 |
|---|---|---|---|---|---|
| NORMAL | 默认 | 20 min | 围绕预测中心(受容忍偏移限制)布正态权重 | 35 % | 15 min |
| TREND | `drift_strength > 2.0` 持续 2 个 1min 窗,**或** `max(p_above, p_below) > 0.6` | 15 min | 不用预测中心;单侧偏置,强趋势收缩为反向小仓位 | 50–70 %(随强度) | 15 min |
| EXTREME | 熔断条件(见 risk-monitoring-design.md §四) | 1 min | 全撤 + 100% lending | 100 % | 10 min |

**事件驱动补充**:定时评估之外,active bin 移动 ≥ toleranceBins、预测穿越概率突变(p_break 跨 0.6)、L1/L2 风控信号都触发额外评估。

**防抖**:最短驻留 + 滞回(EXTREME 进 10% / 出 7%;TREND 进 drift 2.0 / 出 1.5)。影子期监控状态切换次数,健康带 5–50 次/天。

### 2.3 连续参数推导(代替六态参数表)

```
halfWidth       = clamp(round(k_w × width_sigma), 2, 8)        # k_w 初值 2.0,W5 标定
toleranceBins   = max(1, round(width_sigma))
maxCenterOffset = uncertainty > u_high ? 1 : clamp(round(width_sigma), 1, 3)
trendBias       = clamp((p_above - p_below) / 0.5, -1, +1)     # 仅 TREND 态使用
lendingPct      = base[state] (+10pp L1 软熔断时)
```

---

## 三、预测到目标分布的转换(核心)

### 3.1 NORMAL:围绕预测中心的正态权重

```
1. 中心(容忍偏移限制)
   center_bin = active_bin + clip(center_offset, ±maxCenterOffset)
   # 模型不确定性高(uncertainty > u_high)时 maxCenterOffset 收为 1,中心贴回 active

2. 范围
   range = [center_bin − halfWidth, center_bin + halfWidth] ∩ PM 范围

3. 正态权重(复用 src/forecast/binWeights.ts,只换 σ 来源)
   for k in range, k ≠ active_bin:
       w[k] = exp(−(k − center_bin)² / (2 × width_sigma²))

4. 买卖侧:k < active = BID,k > active = ASK(权重天然随中心偏移倾斜——
   预测下行时 bid 侧自动加厚,这正是"事前布仓"代替"事后追价")

5. 归一化到做市资金
   market_capital = total × (1 − lendingPct)
```

### 3.2 TREND:drift 偏置,不用预测中心

趋势中预测中心是移动靶,跟着它布仓 = 追涨杀跌。改用偏置:

```
center_bin = active_bin
weak trend(|trendBias| ≤ 0.7):
    halfWidth 不变;顺势侧权重 × (1 + 0.3×|trendBias|),逆势侧 × (1 − 0.3×|trendBias|)
strong trend(|trendBias| > 0.7):
    收缩为反向仓位:仅在趋势反方向 1–3 bin 挂单(押回调),规模 = total × 25%
    其余资金 → lending(lendingPct 升至 70%)
```

预测在 TREND 态的剩余作用:σ̂ 高 → 反向仓位减半;`p_above + p_below > 0.7` → 升级 EXTREME。

### 3.3 EXTREME

```
target_distribution = 空(全撤)
全部资金 → lending(绕过 gas 预算筛选,避险优先)
退出后渐进恢复:先半仓,一个评估周期正常再全量
```

### 3.4 预测不可用时

`PredictionResponse.fallback ≠ false` 时,**mlAgent 整体让位给 Tier 0 策略**(`emaTrend`),本层不工作——不做"半信预测"的连续混合(v1.0 的 α 表取消,语义简化为可用/不可用两态)。fallback 原因落 `predictions` 表,恢复条件:连续 3 次成功推理且 PSI < 0.25。

---

## 四、库存修正(沿用 v1.0,经回测标定)

### 4.1 库存失衡修正

```
sui_overage = SUI_value / total_value − 0.5

|overage| < 0.15          正常
0.15 ≤ |overage| < 0.30   失衡侧权重 ×0.7,另一侧 ×1.5
0.30 ≤ |overage| < 0.50   停止失衡方向新挂单
|overage| ≥ 0.50          仅单侧挂单修正(强制,绕过 gas 筛选)
```

### 4.2 老化库存止损

```
每个 SUI 批次(lot)追踪 acquired_at 与 cost:
  age > 4h  且未亏 > 3% → ask 底价放宽到 cost × 1.005
  age > 12h 且未亏 > 5% → 强制止损:ask 挂 active + 1
```

### 4.3 成本基础保护(ask 底价)

```
ask_min_price = avg_cost_basis × (1 + 2×fee + min_profit) = cost × 1.011
低于底价的 ask bin 跳过(老化止损批次例外)
```

---

## 五、差量计算与 Gas 预算

### 5.1 差量计算(TS,`src/decision/diffPlanner.ts`)

不全撤重挂,只调差异。每 tick 涉及 ≤ 20 个 bin 的整数算术,TS 足够,无需 Rust:

```ts
interface BinDiff {
  binId: number;
  current: bigint;
  target: bigint;
  action: { kind: "add" | "remove"; amount: bigint } | { kind: "skip" };
}
// |target − current| < minThreshold → skip
```

### 5.2 Gas 预算筛选

```
gas_cost ≈ 0.02 SUI × 现价
每个 Add:expected_revenue = fill_prob(bin) × bin_capital × expected_spread
         expected_revenue < gas_multiplier × gas_cost → 降级 skip
gas_multiplier 默认 2(Sui 低 gas 可降 1.3)

fill_prob(bin) = normal_pdf((bin − center_bin) / width_sigma)   # 从预测推导,不另建模型

强制例外(绕过筛选):进 EXTREME、失衡 ≥ 0.5、老化强制止损
```

**单位经济学约束**(W5 新增 gate,详见 implementation-plan-v1.md §8):每状态的期望日成本(gas + Treasury 扣费 × 评估频率)必须 < 期望日 fee 收入 × 50%。Gas 筛选是单笔层面的保护,经济学预算表是状态层面的保护,两层都要过。

### 5.3 PTB 操作上限

```
单 PTB ≤ 6 op(现有 txUnified 链:collect → remove → transfer → add)
超出 → 按 expected_revenue 排序,低价值操作留给下个 tick
W6 必须有 PTB size 单元测试(计算错误 = gas 失败回滚)
```

---

## 六、执行(复用现有链路,本层不新建)

| 环节 | 现有实现 | 本计划改动 |
|---|---|---|
| PTB 构造(原子) | `src/sui/cdpm/txUnified.ts` | 无 |
| 提交/确认/失败处理 | `src/services/executor.ts` | 无 |
| 编排 + 冷却 + 锁 + Treasury 扣费/退款 | `src/services/rebalancer.ts` | 入口前置 `riskMonitor.checkPreTick`;evalInterval 由状态机提供;`strategy.plan` 加 `await` |
| lending supply/redeem | `src/sui/lending/router.ts` | `decide()` 加 `stateBias?: { targetLendingPct }` |

失败语义沿用现状:PTB 原子,失败全回滚 + Treasury 退款;失败后**重新感知链上状态**再决策,不基于过期状态重试。

### 6.1 链上对账

```
每 N 次决策全量对账(链上真实分布 vs 本地缓存);不一致以链上为准 + 告警
EXTREME 退出后强制对账
```

---

## 七、Lending 路由

```
market_capital  = total × (1 − lendingPct[state, trendBias])
lending_capital = total × lendingPct

需要更多做市资金 → redeem 差额(现有 coverShortfallViaLending 路径,不动)
多余资金 → supply 到 APY 最高的健康协议(现有 router 决策树 + 60% 单协议上限,不动)
```

状态机只通过 `stateBias.targetLendingPct` 影响 supply 比例。

---

## 八、决策上下文与持久化

| 数据 | 落点 |
|---|---|
| 状态机状态 + 进入时间 + 触发原因 | `market_state_history`(按 pool 键) |
| 每次预测 + fallback 原因 | `predictions`(按 pool 键) |
| 风控事件 | `risk_events` |
| 库存批次(lot:amount / cost / acquired_at) | 新表或 `position_state` 扩展(W6 定) |
| 调仓计划与结果 | 现有 `rebalances` 表(不动) |

**键形状**:预测与市场状态是池级事实,按 `pool_id`;PM 维度在风控/执行层 join。多 PM 同池不重复行。

---

## 九、关键参数总表(v1 初值,W5 grid search 标定)

| 参数 | 默认值 | 备注 |
|---|---|---|
| k_w(halfWidth 系数) | 2.0 | halfWidth = clamp(round(k_w×σ), 2, 8) |
| u_high(不确定性收紧阈值) | walk-forward P75 | 超过 → maxCenterOffset = 1 |
| TREND 进入 drift_strength | 2.0(出 1.5 滞回) | |
| TREND p_break 进入 | 0.6 | |
| trendBias 收缩阈值 | 0.7 | 超过 → 反向 25% 仓位模式 |
| 库存失衡阈值 | 0.15 / 0.30 / 0.50 | |
| 老化阈值 | 4h / 12h | |
| Ask 最小利润 | 0.3% | |
| Gas 倍数 | 2×(可降 1.3) | |
| PTB 单批上限 | 6 op | 硬约束,单测保护 |
| 对账频率 N | 视稳定性,初值 20 | |
| 最短驻留 | NORMAL/TREND 15min,EXTREME 10min | |

---

## 十、关键设计决策回顾

1. **三态 + 连续参数**:离散状态只保留行为模式不同的三种;档位参数交给 σ̂ 的连续函数,自由度 ~40 → ~12
2. **围绕预测中心布仓(NORMAL)/ 不用预测中心(TREND)**:震荡市信预测做事前布仓;趋势市中心是移动靶,用 drift 偏置
3. **预测可用性二值化**:可用就用、不可用整体让位 Tier 0;不做连续 α 混合(不可标定、不可解释)
4. **执行层零新建**:RebalancePlan 进现有 rebalancer/executor/txUnified 链,决策层是纯函数计算
5. **两层经济学保护**:单笔 gas 筛选 + 状态级日成本预算表
6. **fill_probability 从预测推导**:不另建 bin 概率模型
7. **全 TS**:每 tick ≤ 20 bin 的算术没有性能问题;Rust 在决策/执行路径上没有立足点(推理侧的结论见 prediction-service-design.md §1.2)
