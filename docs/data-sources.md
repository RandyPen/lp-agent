# 数据源设计

> 版本：v2.0(对齐三态状态机与 SQLite + parquet 存储;采集面与分层原则沿用 v1.0)
> 基础文档：project-background.md、implementation-plan-v1.md
> 适用范围：状态判定、ML 模型训练与推理、池子监控、风险预警
>
> **v2.0 要点**:① 训练数据窗口 6–12 个月(Binance 历史回填,W1 交付);② **Cetus swap 事件
> 历史扫块是 W1 一等公民**——它是回测 fee 模型标定与影子验证的唯一事实来源,不再是"有空再拉"
> 的妥协项;③ Cetus 侧数据 v1 不进 ML 特征(历史不足),仅用于池子监控与 fee 标定;
> ④ OKX/Coinbase 备援 v1 仅留接口不实现(见 implementation-plan-v1.md §7)。

---

## 一、设计原则

**原则 1：用最深的市场判定行情，用自己的市场执行交易**

Binance 是加密市场事实上的价格基准，流动性深、数据稳定、API 成熟。所有市场状态判定（波动率、趋势、闪崩）基于 Binance 数据。Cetus 是执行场所，只用于监控池子自身状态和检测异常。

**原则 2：避免反身性**

不用 Agent 自己交易的 Cetus 池子数据作为决策主源。否则 Agent 的挂单、撤单、成交会污染输入信号，形成"看着自己的影子做决策"的反馈循环。

**原则 3：分层冗余**

主数据源故障时有备用源切换路径。所有数据源都故障时，进入 EXTREME 状态保守防御，不依赖任何单点。

**原则 4：信号质量 > 数据量**

不追求"什么数据都接"。每个数据源都对应明确的决策点，无用数据不接入（减少工程复杂度和故障面）。

---

## 二、数据源全景

### 2.1 数据源分层

| 层级 | 数据源 | 用途 | 关键性 |
|---|---|---|---|
| 主数据源 | Binance SUIUSDC 现货 | 状态判定、ML 训练、价格基准 | 必需 |
| 跨市场参考 | Binance BTCUSDC、ETHUSDC | 大盘 β、系统性风险检测 | 必需 |
| 衍生品信号 | Binance SUI 永续合约 | 趋势确认、爆仓预警 | 重要 |
| 执行场所监控 | Cetus 池子（Sui RPC） | active bin、TVL、自己的挂单 | 必需 |
| 套利参考 | Cetus vs Binance 价差 | 流动性事件检测 | 重要 |
| 协议监控 | Scallop、Kai 链上数据 | Lending APR、协议健康度 | 必需 |
| 冗余备份 | OKX、Coinbase SUI 现货 | Binance 故障时切换 | 可选 |
| 链上信号 | 大额转账、稳定币流入 | 告警信号 | 可选 |

### 2.2 各数据源的访问方式

| 数据源 | 协议 | 频率 | 延迟要求 |
|---|---|---|---|
| Binance 现货 ticker | WebSocket | 实时推送 | < 100ms |
| Binance 1min K 线 | WebSocket | 1 分钟推送 | < 1s |
| Binance 历史 K 线 | HTTP REST | 按需拉取 | 不敏感 |
| Binance 衍生品 | HTTP REST | 1-5 min 轮询 | < 5s |
| Sui RPC（Cetus） | WebSocket / HTTP | 事件订阅 + 按需查询 | < 2s |
| Lending 协议 | HTTP RPC | 5-10 min 轮询 | 不敏感 |
| 其他交易所 | HTTP REST | 故障时切换 | 不敏感 |
| 链上分析平台 | HTTP REST | 5 min 轮询 | 不敏感 |

---

## 三、Binance 现货：主数据源

### 3.1 SUIUSDC 现货

**为什么是 SUIUSDC 而不是 SUIUSDT**：

我们的 Cetus 池子是 SUI/USDC，用 SUIUSDC 现货数据避免汇率偏差。USDT/USDC 偶尔有 0.1%-0.3% 偏离，长期可能累积成系统性误差。

如果 SUIUSDC 深度不够，可以用 SUIUSDT 减去 USDT/USDC 偏差（USDTUSDC 对的实时价格）。但优先用 USDC 对。

**采集内容**：

| 数据类型 | 频率 | 用途 |
|---|---|---|
| 实时 ticker（last price、bid、ask） | 实时 WS | drift 计算、价格基准 |
| 1min K 线（OHLCV） | 实时 WS | σ_s 计算、ML 特征 |
| 5min K 线（OHLCV） | 实时 WS + 历史回填 | σ_l 计算、训练数据 |
| 15min/1h K 线 | 历史回填 | 长周期特征、回测 |
| 历史成交 trades | 历史回填 | 微观结构特征 |

**端点**：

- WebSocket：`wss://stream.binance.com:9443/ws/suiusdc@kline_1m`
- REST：`https://api.binance.com/api/v3/klines`

**指标计算**：

```
σ_s = std(log_returns of 最近 30 根 1min K 线)
σ_l = std(log_returns of 最近 288 根 5min K 线)  # 24 小时
drift = (last_price - price_30min_ago) / price_30min_ago
vol_ratio = σ_s / σ_l
drift_strength = |drift| / σ_s
```

### 3.2 BTCUSDC、ETHUSDC 现货

**用途**：跨市场参考、系统性风险检测。

加密市场 β 相关性强，SUI 与 BTC/ETH 相关性通常 0.6-0.8。当 BTC/ETH 出现异动时，SUI 跟随的概率高。

**关键信号**：

- **BTC 5min 跌 > 3%**：即使 SUI 还没动，预判跟跌，提前进入 TREND 或 EXTREME
- **BTC/ETH 同步 σ_s 飙升**：系统性波动放大，确认 TREND 不是 SUI 个体事件
- **SUI 相对 BTC 的超额收益（α）**：drift_sui - drift_btc，>2% 提示 SUI 独立行情（生态消息）
- **相关性突然崩溃**：滚动相关性 < 0.3 持续 30 min，提示 SUI 进入独立行情周期

**采集内容**：

- 1min K 线（与 SUI 同步采集）
- 5min K 线（用于相关性计算）

只采集这两个币种，不要扩展到其他山寨币——边际信息有限，工程成本却线性增加。

### 3.3 Binance 衍生品：SUI 永续合约

**为什么衍生品有价值**：

大资金通常先在永续上建仓（杠杆效率高），所以衍生品异常常领先现货 5-30 分钟。

**关键指标**：

| 指标 | 数据点 | 信号含义 |
|---|---|---|
| Funding rate | 每 8h 结算，每分钟更新预估值 | >0.05%/8h：多头拥挤；<-0.05%：空头拥挤 |
| Open interest | 实时 | OI 快速增 + 价格不动 = 大资金建仓 |
| 大额清算（liquidations） | 实时事件流 | 连环爆仓 = EXTREME 信号 |
| Top trader 多空比 | 每 5min | 极端值提示反转 |

**端点**：

- Funding rate：`/fapi/v1/premiumIndex`
- Open interest：`/fapi/v1/openInterest`
- Liquidations：WebSocket `wss://fstream.binance.com/ws/!forceOrder@arr`

**用法举例**：

```
if funding_rate > 0.1%/8h 且 drift_strength > 2.0：
    → 强趋势确认（多头过度杠杆，方向明确）
    → 进入 TREND（trendBias 拉满），反向小仓位规模缩小（爆仓后反向）

if 5min 内 SUI 永续清算总额 > $5M：
    → EXTREME 信号
    → 即使现货价格还没动，提前撤单
```

---

## 四、Cetus 池子：执行场所监控

### 4.1 必须监控的内容

Cetus 数据**不用于市场状态判定**，只用于：

1. **池子自身状态**：active bin、TVL、当前 bin 分布
2. **自己的挂单**：当前各 bin 的流动性、待成交、已成交
3. **池子异常检测**：TVL 突变、价格异常
4. **套利信号**：与 Binance 价差

### 4.2 采集内容

| 数据类型 | 频率 | 用途 |
|---|---|---|
| Active bin id | 实时事件订阅 | 决策入口 |
| 池子 TVL | 每次决策时 | 流动性事件检测 |
| 池子 bin 分布 | 每次决策时 | 了解整体流动性结构 |
| 自己 PM 的状态 | 实时事件订阅 | 跟踪挂单/成交 |
| 成交事件 | 实时事件订阅 | PnL 归因、ML 训练样本 |

### 4.3 接入方式

**Sui RPC**：
- 公开节点：`https://fullnode.mainnet.sui.io`
- 付费节点（推荐生产用）：Shinami、Triton One、QuickNode
- 自建节点（终极方案）：完全控制，但运维成本高

**Cetus SDK**：使用官方 SDK 查询池子状态和构造交易。注意 SDK 版本与合约升级同步。

**事件订阅**：通过 Sui WebSocket 订阅 Cetus 池子的 Swap、AddLiquidity、RemoveLiquidity 事件。

### 4.4 异常检测规则

| 异常类型 | 阈值 | 响应 |
|---|---|---|
| TVL 5min 跌 > 50% | 实时监控 | EXTREME |
| Active bin 5min 跨越 > 10 bin | 实时监控 | 校验是否为闪崩 |
| Cetus vs Binance 价差 > 0.5% 持续 30s | 实时监控 | 套利不畅告警 |
| Cetus vs Binance 价差 > 5% | 实时监控 | EXTREME |
| 池子内单笔 swap > 池子 TVL 的 10% | 实时监控 | 大单告警，下次决策时校准 |

### 4.5 反身性规避

策略影响 Cetus 状态的几个点：

- Agent 自己的挂单计入 TVL，但**不应**计入"市场流动性深度"判断
- Agent 自己的添加/撤回触发事件，但**不应**触发自己的告警

实现时区分"自己的"和"别人的"：通过自己的 PM ID 过滤事件，TVL 计算时减去自己的贡献。

---

## 五、Lending 协议监控

### 5.1 监控内容

| 数据 | 频率 | 用途 |
|---|---|---|
| Scallop USDC supply APR | 5 min | Lending 收益估算 |
| Scallop SUI supply APR | 5 min | Lending 收益估算 |
| Kai USDC supply APR | 5 min | Lending 收益估算 |
| Kai SUI supply APR | 5 min | Lending 收益估算 |
| 协议 TVL | 10 min | 协议健康度 |
| 利用率（utilization rate） | 5 min | APR 趋势预判 |

### 5.2 协议选择逻辑

```
每次需要 supply 时：
    candidates = [Scallop, Kai]
    选择 APR 最高且 TVL 正常的协议

每次需要 redeem 时：
    从持仓所在协议直接 redeem
```

### 5.3 异常检测

| 异常 | 响应 |
|---|---|
| 单个协议 TVL 5min 跌 > 30% | 立即 redeem 全部，禁用该协议 24h |
| APR 突变（5min 内变化 > 50%） | 暂停新 supply，观察 30min |
| Redeem 失败 | 重试 1 次，失败则告警，影响后续决策 |

---

## 六、跨市场套利信号

### 6.1 Cetus vs Binance 价差

这是一个**独立且有价值**的信号源：

```
spread = (cetus_price - binance_price) / binance_price
```

**正常状态**：`|spread| < 0.2%`（套利者保持的合理偏差）

**信号含义**：

| spread 范围 | 含义 | 响应 |
|---|---|---|
| < 0.2% | 正常套利 | 无 |
| 0.2% - 0.5% | 套利不畅 | 警惕，下次决策时校准价格基准 |
| 0.5% - 1% | 流动性事件 | 提高 lending 比例 |
| 1% - 5% | 严重异常 | 接近 EXTREME |
| > 5% | EXTREME | 全撤 |

**持续时间**：偏差短时（<30s）可能是延迟，持续 30s+ 才有诊断意义。

### 6.2 价差扩大的原因诊断

| 原因 | 特征 | 应对 |
|---|---|---|
| Sui 网络拥堵 | 全市场套利变慢，多个 DEX 同步偏离 | 等待网络恢复 |
| Binance 数据异常 | 跨多个交易所对比 Binance 偏离 | 切换备用源 |
| Cetus 池子被大单冲击 | 池子 TVL 同时变化 | 等待回归 |
| Cetus 被攻击 | 价格瞬间偏离 + TVL 异常 | 立即 EXTREME |

---

## 七、冗余备份数据源

### 7.1 备用现货交易所

当 Binance 故障时切换。优先级：

1. **OKX**：API 成熟、流动性次于 Binance
2. **Coinbase**：流动性深，但 SUI 对深度可能不如 OKX
3. **Kraken**：作为第三备份

切换触发条件：
- Binance API 连续 3 次请求失败
- Binance WebSocket 断开 > 30s
- Binance 数据 vs 其他源偏差 > 1% 持续 1min

**重要**：切换后**降级**——只保证基本运行，不追求最优。状态判定阈值放宽 20%（避免备用源精度差导致误切换）。

### 7.2 备用 RPC 节点

| 主用 | 备用 1 | 备用 2 |
|---|---|---|
| Shinami（付费） | Triton One | sui.io 公开节点 |

WebSocket 断开自动切换，失败 3 次切换到下一个。

---

## 八、链上信号（可选）

### 8.1 价值有限的原因

链上数据延迟高、稀疏性大，对分钟级做市决策价值有限。但作为**辅助告警**有用。

### 8.2 关注的指标

| 指标 | 数据源 | 用途 |
|---|---|---|
| 大额 SUI 转入交易所 | Arkham、Nansen | 卖压预警 |
| 大额稳定币流入交易所 | Arkham | 买压预警 |
| SUI 巨鲸地址异动 | Nansen | 提前预警 |
| Sui 网络拥堵指标 | Sui 官方 metrics | 影响 Agent 执行 |

**用法**：仅作为告警和事后归因，不进入实时决策。每 5-10 min 轮询一次。

---

## 九、数据采集架构

### 9.1 分层设计

```
┌─────────────────────────────────────────────────┐
│              决策层（每次评估）                  │
│  使用：状态指标、ML 特征、池子状态、Lending 数据 │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────┐
│              聚合层（实时计算）                  │
│  σ_s、σ_l、drift、相关性、价差、衍生品信号        │
└────────────────────┬────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
┌───────┴────┐  ┌────┴─────┐  ┌──┴──────────┐
│ 实时层(WS) │  │ 轮询层(HTTP)│  │ 历史层(DB)  │
│            │  │           │  │             │
│ Binance    │  │ 衍生品    │  │ 历史 K 线   │
│ 现货 ticker │  │ Lending   │  │ 历史成交    │
│ K 线       │  │ 链上指标  │  │ ML 训练集   │
│ Sui 事件   │  │           │  │             │
└────────────┘  └───────────┘  └─────────────┘
```

### 9.2 实时层（WebSocket）

**目的**：亚秒级延迟，用于状态判定的核心数据。

**接入**：

- Binance Spot WS：SUIUSDC、BTCUSDC、ETHUSDC 的 1min K 线和 ticker
- Binance Futures WS：清算事件流
- Sui WS：Cetus 池子事件、自己 PM 的事件

**数据落地**：

- 内存中维护滑动窗口（最近 30 分钟 1min K 线、最近 24 小时 5min K 线）
- 同时写入 SQLite（现有 `price_observations` 表,批量化写入）；训练用大体量数据落 parquet（`ml/data/`）

**容错**：

- 心跳检测（30s 无消息视为断开）
- 自动重连（指数退避：1s、2s、4s、8s、最长 30s）
- 重连后 HTTP 拉取错过的数据补齐

### 9.3 轮询层（HTTP）

**目的**：低频但稳定的数据，秒级到分钟级延迟即可。

**接入与频率**：

| 数据 | 频率 |
|---|---|
| Binance funding rate | 1 min |
| Binance OI | 5 min |
| Cetus 池子完整状态 | 每次决策时 |
| Lending APR | 5 min |
| 链上指标 | 10 min |

**限流处理**：

- Binance API 限流：1200 weight/min，足够使用
- Sui RPC：付费节点通常 100+ req/s，公开节点 10 req/s（生产慎用）
- 实现请求队列 + 限流控制

### 9.4 历史层（数据库）

**目的**：ML 训练、回测、PnL 归因。

**存储**（与仓库现状一致,不引入新数据库）：

- 运行时结构化数据：SQLite（`./data/app.db`——PM 状态、决策日志、predictions、risk_events、price_observations）
- 训练数据 / 特征行 / 完整 K 线与 trades 流：Parquet（`ml/data/`），按日/月分区
- 同一份数据不存两处：SQLite 面向运行时查询，parquet 面向训练与离线分析

**保留策略**：

- 1min K 线：永久保留
- 5min K 线：永久保留
- Tick 数据：保留 90 天（过老的下采样到 1min）
- 决策日志：永久保留
- 链上事件：永久保留

---

## 十、容错与降级

### 10.1 数据源故障分级

| 等级 | 触发 | 响应 |
|---|---|---|
| L1 - 单源延迟 | 单数据源延迟 > 5s | 告警，继续运行 |
| L2 - 主源故障 | Binance API 故障 | 切换备用源，状态判定阈值放宽 20% |
| L3 - 多源故障 | 主源 + 备用源都故障 | 暂停新挂单，已挂单保持，等待恢复 |
| L4 - 全面故障 | 所有交易所数据都获取不到 | 进入 EXTREME，全撤 |
| L5 - 链故障 | Sui RPC 故障 | 暂停所有操作（无法链上执行） |

### 10.2 数据质量监控

每分钟自检：

```
1. 各 WebSocket 心跳正常吗？
2. 各 HTTP 端点最近一次成功调用时间 < 阈值吗？
3. 数据是否在合理范围（价格变化 < 50%、成交量非负）？
4. 时间戳是否单调递增、无大跳变？
5. 跨数据源一致性（同一时刻 Binance vs OKX 偏离 < 2%）？
```

任一失败 → 记录告警，连续 3 次失败 → 升级到对应故障等级。

### 10.3 冷启动

Agent 启动时：

1. 从历史层加载最近 24h K 线（用于 σ_l 计算）
2. 从历史层加载最近 30min 1min K 线（用于 σ_s 计算）
3. 连接所有 WebSocket，等待 5min 数据预热
4. 校验池子当前状态（Cetus）
5. 状态预热完成后，开始决策

**冷启动期不做激进决策**：前 30min 强制 lending_ratio +20%，避免基于不完整数据决策。

---

## 十一、数据源 → 决策映射

每个决策点用了哪些数据源，便于审计：

| 决策点 | 主要数据源 | 辅助数据源 |
|---|---|---|
| σ_s 计算 | Binance SUIUSDC 1min K 线 | — |
| σ_l 计算 | Binance SUIUSDC 5min K 线 | — |
| drift 计算 | Binance SUIUSDC last price | — |
| 状态判定 | 上述三个指标 | BTC/ETH drift、衍生品 |
| 闪崩检测 | Binance SUIUSDC 5min K 线 | BTC、ETH 同步检测 |
| TREND 确认(trendBias) | drift_strength | Funding rate、OI |
| EXTREME 触发 | 上述多源 | Liquidations、Cetus TVL |
| ML 特征 | Binance SUIUSDC + BTC + ETH 多周期 K 线 | 衍生品指标 |
| Bin 决策 | ML 输出 + 池子状态 | — |
| Lending 路由 | Scallop、Kai APR | 协议 TVL |
| 池子异常检测 | Cetus 链上数据 | 跨市场价差 |
| 套利信号 | Cetus vs Binance 价差 | 多交易所价差 |

---

## 十二、关键设计要点回顾

1. **Binance SUIUSDC 是状态判定主源**，不是 Cetus
2. **Cetus 只用于池子自身监控**，避免反身性
3. **BTC/ETH 必接**，加密市场 β 太强，独立判定会错过系统性风险
4. **衍生品数据是趋势确认的关键证据**，funding 和 liquidations 都很有信号价值
5. **跨市场价差本身就是信号**，不仅是参考价
6. **冗余备份必备**，但备用源用低精度运行模式
7. **冷启动期保守运行**，数据不全时降低风险

---

## 参数总表

| 数据采集参数 | 默认值 | 调优方向 |
|---|---|---|
| WebSocket 心跳超时 | 30s | 网络不稳 → 60s |
| HTTP 重试次数 | 3 | 关键源可提至 5 |
| 重连指数退避上限 | 30s | 频繁断线 → 60s |
| 滑动窗口大小（1min） | 30 根 | σ_s 计算窗口 |
| 滑动窗口大小（5min） | 288 根 | 24h，σ_l 计算 |
| 数据源切换阈值（请求失败次数） | 3 | 容错严格 → 2 |
| 备用源精度容忍 | 20% 阈值放宽 | 备用源质量好 → 10% |
| 冷启动时长 | 30 min | 数据补全快 → 15 min |
| 价差套利异常阈值 | 0.5% | 不同时段不同标准 |
| Lending APR 轮询间隔 | 5 min | APR 稳定 → 10 min |
