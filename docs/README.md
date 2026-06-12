# SUI/USDC 自动化做市 Agent — 设计文档集

本目录包含一个基于机器学习的自动化做市 Agent 的完整设计文档。该 Agent 托管运行在 Sui 链 Cetus DLMM 协议上的 USDC/SUI 流动性头寸,通过预测短期价格分布自主决定流动性配置,实现做市收益最大化。项目以**量化流动性托管开源项目**为目标定位:仓库交付框架、风控与可复现的 ML 管线,模型产物(alpha)由各 fork 自行训练。

文档按"背景 → 计划 → 数据 → 预测 → 决策 → 验证 → 风控"的逻辑链组织,建议按此顺序阅读。

> **版本说明**:2026-06 全套文档完成 v2.0 修订。关键架构决策相对早期草案的变化——
> ① 推理从 Rust napi 改为 **Python sidecar**(`PredictionProvider` 接口隔离);
> ② 状态机从六态收敛为**三态**(NORMAL / TREND / EXTREME)+ 连续参数;
> ③ 验收 gate 从单窗口 PnL 改为**预测质量 + 单位经济学**;
> ④ 风控与影子模式**先于模型**落地。
> 决策记录分别见 prediction-service-design.md §1.2、decision-engine-design.md §2.1、
> implementation-plan-v1.md 开头的差异清单。

---

## 文档总览

| 序号 | 文档 | 主题 | 角色 |
|---|---|---|---|
| 1 | project-background.md | 项目背景与约束 | 一切设计的前提 |
| 2 | implementation-plan-v1.md | v1 实施方案 | 八周路线、验收 gate、范围取舍(**总纲**)|
| 3 | data-sources.md | 数据源设计 | 数据基础 |
| 4 | forecasting-approach.md | 预测方法论 | Tier 0–3 模型路线、LLM 定位 |
| 5 | prediction-service-design.md | 预测服务 | LightGBM + Python sidecar 工程方案 |
| 6 | decision-engine-design.md | 决策调仓 | 三态状态机 + 预测到链上操作 |
| 7 | backtest-framework-design.md | 回测框架 | 策略验证 |
| 8 | risk-monitoring-design.md | 风控与监控 | 安全保障 |

另有现状类文档:project-overview.md(代码现状地图)、module-and-testing.md(模块与测试布局)、treasury-role-design.md、seal-integration.md。

---

## 各文档内容说明

### 1. project-background.md — 项目背景与约束

整个系统的前提和边界,定义了"能做什么、不能做什么"。

核心内容包括项目目标、收益与损失模型(价差、手续费、Lending 三类收益,库存暴露、Gas、逆向选择等损失)、池子硬参数(SUI/USDC、50bps bin step、0.4% fee)、以及最关键的各类硬约束——CDPM 协议约束(不能在 active bin 挂单、不能主动 swap、不能改 PM 范围、接管不可逆)、市场约束、技术与运营约束。任何方案都不能违反这里列出的约束。

### 2. implementation-plan-v1.md — v1 实施方案(总纲)

八周路线图、仓库结构变更、接口契约、验收标准与范围取舍。其余设计文档的工程决策以此为准。要点:`Strategy.plan` 异步化、`PredictionProvider` 开源接缝、风控先行(W1–2)、训练窗口 6–12 个月、L1 回测只做相对排序、每状态单位经济学预算表、开源化整改清单(tests 入库、LICENSE、CI、训练可复现)。

### 3. data-sources.md — 数据源设计

核心原则是"**用最深的市场判定行情,用自己的市场执行交易**"。主数据源是 Binance SUIUSDC 现货,辅以 BTC/ETH 现货(系统性 β)和 SUI 永续合约(funding、OI、清算流)。Cetus 池子数据**只用于监控自身状态与 fee 模型标定**,不用于市场判定,以避免反身性。Cetus swap 事件历史扫块是 W1 一等公民。存储为 SQLite(运行时)+ parquet(训练),不引入新数据库。

### 4. forecasting-approach.md — 预测方法论

"σ 优先于 μ"的预测哲学与 Tier 0(GARCH/EWMA 统计基线)→ Tier 1(LightGBM 分位回归,即 v1 主线)→ Tier 2/3(深度/regime 模型)递进路线;LLM 严格退到 meta 控制、特征生成、事后解释三个位置,不直接输出数值预测。

### 5. prediction-service-design.md — 预测服务

ML 预测的工程方案,是决策的"眼睛"。

预测目标:**中心 bin + 宽度**(q10/q50/q90 分位数)与**未来 30min 波动率**。技术栈是 **Python(训练 + 推理 sidecar)+ TypeScript(编排)**:训练与推理共享同一份 `ml/features/` 代码(消灭 train/serve skew),sidecar 经本地 HTTP 服务,TS 侧通过 `PredictionProvider` 接口消费——这是 fork 替换模型的唯一接缝。降级语义显式留痕(fallback 字段贯穿 sidecar → TS → DB),无静默路径。§1.2 是放弃 Rust napi 的完整决策记录。

### 6. decision-engine-design.md — 决策调仓

连接"预测输出 + 状态机"与"链上操作"的执行层,是系统的"手"。

**三态状态机**:NORMAL(围绕预测中心布正态权重,半宽 = 连续函数 f(σ̂))、TREND(不用预测中心,drift 偏置,强趋势收缩为反向小仓位)、EXTREME(全撤 + 100% lending)。容忍偏移与不确定性联动(模型没把握时中心贴回 active)。执行环节(差量计算、Gas 筛选、PTB ≤ 6 op)全部 TS,PTB 构造与提交**复用现有** `txUnified.ts` / `executor.ts` / `rebalancer.ts` 链路,不新建执行层。

### 7. backtest-framework-design.md — 回测框架

核心难点是 **DLMM bin 级成交的真实模拟**。三级保真度:L1 简化(全成交假设)、L2 按量比例、L3 用 Cetus 真实成交数据。**两条铁律**:L1/L2 的绝对 PnL 不作任何验收 gate(fill 模型有系统性偏差),只做同模拟器相对排序;fee 模型必须用 Cetus 真实事件标定。模型本身的主验收是预测质量指标(pinball / 覆盖率 / 方向准确率)。撮合模拟用 Python numpy 向量化,分钟级跑完全年数据。

### 8. risk-monitoring-design.md — 风控与监控

核心前提是 **Agent 完全自动、用户不介入**。四层防御(预防 / 熔断 / 监控 / 诊断),熔断分三级(L1 软熔断降暴露、L2 进 EXTREME 全撤、L3 紧急停机)。模型问题不致停摆:fallback 即整体让位 Tier 0 规则策略,且每次降级落库留痕。全部 TS 实现,挂在现有运行时内;风控骨架在 W1 先于模型落地——对托管产品,熔断与审计日志是产品本体。

---

## 系统整体架构

```
            ┌─────────────────────────────────────┐
            │   project-background(约束前提)        │
            │   implementation-plan-v1(工程总纲)    │
            └─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────┐
│ data-sources │──▶│   prediction     │──▶│   decision   │
│  (数据基础)   │   │ (Python sidecar) │   │ (三态+调仓)   │
└──────────────┘   └──────────────────┘   └──────┬───────┘
        │            PredictionProvider          │
        │            (TS 接口,开源接缝)     ┌─────▼──────────────┐
        │                                 │  现有执行链(复用)     │
        │                                 │ rebalancer→executor │
        ▼                                 │ →txUnified→lending  │
┌──────────────┐                          └─────┬──────────────┘
│   backtest   │                          ┌─────▼────────┐
│  (离线验证)   │                          │ risk-monitor │
└──────────────┘                          │ (W1 先行)     │
                                          └──────────────┘
```

- **implementation-plan-v1** 是工程总纲,定义节奏与验收
- **data-sources** 为预测和风控提供数据;**prediction** 产出预测;**decision** 产出链上操作
- **执行链零新建**:决策输出 `RebalancePlan` 进现有 rebalancer / executor / txUnified
- **backtest** 上线前验证(复用同一份特征与策略代码);**risk-monitoring** 运行时保障,可触发 EXTREME

---

## 技术栈总览

| 层 | 语言/工具 | 用途 |
|---|---|---|
| 训练 + 推理 sidecar + 回测撮合 | Python(uv) | LightGBM 训练与推理、特征工程(共享)、numpy 向量化回测、分析可视化 |
| 框架 + 决策 + 执行 + 风控 | TypeScript(Bun) | 策略、状态机、差量计算、PTB、熔断、监控、Treasury |
| 集成 | 本地 HTTP(127.0.0.1) | TS ↔ sidecar;`PredictionProvider` 接口隔离 |
| 存储 | SQLite + parquet | 运行时结构化数据 / 训练数据,各存一份 |

两条工具链(Bun + uv),无 Rust、无额外数据库。

---

## 阅读建议

- **第一次通读**:1 → 2,先约束后总纲,再按 3→8 看实现
- **关注 ML**:重点看 3、4、5,理解数据如何变成预测
- **关注落地**:重点看 6、8,理解预测如何变成安全的链上操作
- **关注验证**:重点看 7 + implementation-plan §8,理解验收 gate 的设计(为什么不是 PnL)

每份文档末尾都有"关键设计决策回顾"和"参数总表",可快速回顾要点和调优入口。

注:各文档中的具体参数值(阈值、比例、窗口大小等)均为设计起点,W5 影子数据 grid search 标定,回测和实盘逐步修正。
