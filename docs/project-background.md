# 项目背景与约束条件

> 版本：v2.0（精简版）
> 最后更新：2026-05-25
> 说明：本文档仅保留项目背景与硬性约束，不含具体方案设计。

---

## 一、项目目标

开发一个基于机器学习的自动化做市 Agent，托管运行在 Cetus DLMM 协议上的 USDC/SUI 流动性头寸（Position Manager，简称 PM）。

**核心定位**：Agent 是与 CDPM 协议规则策略**并列**的另一种策略实现，完全由机器学习驱动，不复用 CDPM 的 5 种预设策略（spot / curve / bid-ask / only-bid / only-sell）。

Agent 通过预测短期内价格在不同 bin 的成交概率，自主决定流动性的分布和资金路由，实现做市收益的最大化。

---

## 二、收益与损失模型

### 2.1 收益来源

**1. 价差收益（主要）**
- 在低价 bin 买入资产，在高价 bin 卖出资产
- 每次完成买入-卖出循环赚取 bin 间价差
- 由于 50bps bin step + 不能在 active bin 挂单，最小价差为 1%

**2. 交易手续费（次要）**
- 每笔穿越你 bin 的 swap 支付 0.4% 手续费
- 按你的 bin 资金占比分配

**3. Lending APR（最小）**
- 闲置或远端资金 supply 到 Scallop / Kai 协议
- USDC 通常 3-8% APR，SUI 通常 1-3% APR

### 2.2 损失来源

- **库存暴露（IL）**：单边趋势中库存被强制转换为不利方向资产
- **Gas 成本**：每次链上调仓的成本
- **逆向选择**：知情交易者优先打有利价位
- **模型预测误差**：ML 预测不准导致的次优决策

---

## 三、服务模式

- 用户通过 CDPM 创建 PM 并调用 `set_agent` 委托给本 Agent
- Agent 接管后完全自主决策流动性配置
- 一个 Agent 实例可托管多个不同用户的 PM
- 各 PM 之间**相互独立**，不共享资金，但共享 ML 模型和市场数据
- **完全自动运行**：假设用户不会响应任何通知或建议

---

## 四、池子参数（硬约束）

### 4.1 池子配置

| 参数 | 值 | 说明 |
|---|---|---|
| 池子地址 | 0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076 | Sui 主网 |
| 交易对 | SUI / USDC | SUI 是 base，USDC 是 quote |
| Bin step | 50 bps (0.5%) | 每个 bin 价格间距 |
| 交易手续费 | 0.4% | 每笔 swap 收取 |
| 协议 | Cetus DLMM | Sui 上的离散流动性 AMM |

**base/quote 含义**：
- SUI 是 base（被定价的标的资产）
- USDC 是 quote（计价货币）
- 价格 ≈ $1.00 表示 1 SUI = 1 USDC
- 价格上涨 = SUI 相对 USDC 升值
- 价格下跌 = SUI 相对 USDC 贬值

**注意**：Cetus 池子内部的 coinA / coinB 顺序需通过 SDK 查询确认，可能与业务语义的 base/quote 不一致。`higherBinMeansHigherPrice` 标志决定 bin id 增大方向对应价格上涨还是下跌，Agent 实现时必须正确处理。

### 4.2 关键含义

**50bps bin step 的影响**：
- 每个 bin 价格间隔 0.5%，相对较大
- ±5 bin 覆盖 ±2.5% 价格范围
- ±8 bin 覆盖 ±4% 价格范围
- ±10 bin 覆盖 ±5% 价格范围
- active bin 移动相对缓慢，不需要高频响应

**0.4% fee 的影响**：
- 高费率档，匹配高波动品种
- 单次成交手续费 = 0.4% × 成交量
- 价差套利的盈亏平衡：跨越 2 个 bin 即可覆盖 fee（2 × 0.5% > 0.4%）

---

## 五、CDPM 协议约束

Agent 是 CDPM 框架中的 AGENT 角色。以下是 Agent **必须遵守**的硬性约束。

### 5.1 PM 范围约束（不可修改）

PM 创建时确立的 `[lowerBin, upperBin]` 范围是物理硬边界：

- 所有流动性操作只能在此范围内
- 价格穿出此范围时 PM 失效
- Agent 不能扩展或收缩范围
- Position 半宽 = (upperBin - lowerBin) / 2 × bin_step
- Agent 决策必须主动适应这个范围

### 5.2 Active Bin 约束（不可挂单）

CDPM 合约级别不允许在 active bin 上添加或移除流动性：

- Agent 的所有挂单只能在 active bin **之外**
- 最小买卖价差 = 2 × bin_step = 1%
- 已经在 active bin 的资金会随价格穿越自动消化

### 5.3 接管不可逆约束

- `set_agent` 后 PM 进入 AGENT 模式
- 即使 `remove_agent`，PM 也**不会回退**到 PROTOCOL 模式
- 含义：CDPM 协议永久放弃该 PM 的管理权
- Agent 不能"还回" PM，只能持续管理或等待用户 close

### 5.4 操作受限约束

**Agent 不能做的事**：
- 修改 PM 的 [lowerBin, upperBin] 范围
- 主动 swap（用 USDC 直接换 SUI 或反向）
- 关闭 PM
- 从 PM 提取资金到外部账户

**Agent 能做的事**：
- 添加流动性到指定 bin（在 PM 范围内）
- 移除指定 bin 的流动性
- 触发 lending 的 supply 和 redeem
- 收取手续费

### 5.5 库存被动管理约束

成交后的库存方向变化由 Cetus DLMM 自动处理，Agent 无法主动调整库存比例：

- bid bin 成交 → USDC 自动变为 SUI
- ask bin 成交 → SUI 自动变为 USDC
- Agent 不能 swap 来恢复 50/50 比例
- Agent 通过**形状设计**间接影响库存变化方向

### 5.6 不复用 CDPM 规则策略

CDPM 的 5 种预设策略（spot / curve / bid-ask / only-bid / only-sell）是给协议规则做市使用的：

- AI Agent **不需要**翻译决策为这些策略
- AI Agent **不需要**考虑 fillBoundary 滞回机制
- AI Agent **不需要**遵循 CDPM 的重平衡触发逻辑
- AI Agent 直接通过底层 add/remove liquidity 接口操作

Agent 完全独立设计流动性形状和操作时机，唯一受限于 5.1-5.5 的硬性约束。

---

## 六、SUI/USDC 市场约束

### 6.1 市场特征

**波动率**：
- SUI 历史日波动率范围 3-15%
- 当前阶段（2026 年中）日波动率约 5-8%
- 30min 标准差 ≈ daily / √48 ≈ 0.7% - 1.2%
- 1h 标准差 ≈ daily / √24 ≈ 1.0% - 1.6%
- 闪崩历史：2025 年 10 月曾出现极端日内闪崩

**价格水平**：
- 当前价 ~$0.91-1.10 区间震荡
- 关键支撑：$0.87 / $1.00
- 关键阻力：$1.05 / $1.22
- 流动性敏感：小流通量 / FDV 比例使其对全球流动性敏感

**协议历史**：
- Cetus 在 2025 年 5 月遭遇 $223M 攻击事件
- 攻击者利用 flash swap + 智能合约漏洞
- 已修复但需保持警惕

### 6.2 数据可获得性

**可用数据源**：
- Binance SUIUSDC 现货：5min 及以上 OHLCV，历史完整
- Binance BTCUSDC：跨市场参考
- Binance ETHUSDC：跨市场参考
- Cetus 池子实时数据：通过 Sui RPC 获取（active bin、TVL、volume）

**不易获得**：
- Cetus 池子的历史 bin 级成交数据（需要自己采集）
- SUI 的链上指标（如大额转账、协议升级时间表等）
- SUI 衍生品市场数据

### 6.3 市场体制

SUI 在 USDC 计价下可能呈现：
- **窄震荡**：σ 低 + 无方向
- **宽震荡**：σ 中 + 无方向（最有利做市）
- **趋势市**：σ 中 + 明显方向（做市亏损风险高）
- **闪崩 / 暴涨**：σ 极高 + 短期方向
- **盘整突破前**：σ 低 + 缩量

---

## 七、技术架构约束

### 7.1 区块链层

**Sui 网络特性**：
- 出块时间约 1-3 秒
- Gas 成本相对低（单次操作约 0.01-0.05 SUI）
- 网络拥堵可能影响交易确认时间
- RPC 节点稳定性会影响 Agent 响应速度

### 7.2 Agent 必须实现的能力

- 链上事件监听（PM 相关事件、池子状态变化）
- PTB（Programmable Transaction Block）构造和签名
- 与 Cetus DLMM 合约的直接交互
- Lending 协议（Scallop / Kai）的 supply / redeem 操作
- 状态持久化（PM 注册表、决策日志、ML 模型推理结果）

---

## 八、运营约束

### 8.1 决策原则

**完全自动运行**：
- 假设用户不会查看通知或建议
- Agent 必须独立应对所有市场情况
- 不依赖外部介入

**追求绝对收益最大化**：
- 不追求平滑曲线
- 可承受较大回撤
- 接受趋势市的库存暴露

**多 PM 独立管理**：
- 每个 PM 独立决策
- 共享 ML 模型和数据
- 不共享资金或状态

### 8.2 风险约束

**资金安全**：
- Agent keypair 私钥安全
- 派生地址守卫（启动时验证）
- 不可逆操作必须谨慎

**协议风险**：
- 监控池子异常（TVL 突变、价差异常）
- 紧急熔断机制

**模型风险**：
- 模型失效检测
- Fallback 到保守规则
- 持续监控预测准确率

### 8.3 接管选择性

Agent 可以选择性接管：
- 评估 PM 范围是否合理
- 拒绝不适合的 PM

---

## 九、明确不在范围内的事项

**不做的事**：
- PM 的创建（由用户/前端完成）
- PM 的关闭（由用户主动 close）
- 修改 PM 范围（CDPM 禁止）
- 主动 swap 库存（CDPM 限制）
- 跨链桥接 / 资金转移
- 衍生品对冲
- 高频做市（毫秒级响应）
- 跨 PM 协同策略
- 用户通知 / 退出建议
- 复用 CDPM 的 5 种规则策略

**不依赖的事**：
- 用户实时响应
- 外部预言机（除 Binance 数据外）
- 中心化资金管理
- 链下结算

---

## 十、术语表

| 术语 | 含义 |
|---|---|
| PM | Position Manager，CDPM 协议中代表用户流动性头寸的对象 |
| Active bin | 当前撮合价格所在的 bin |
| Bin step | 相邻 bin 之间的价格间距（本项目为 50 bps） |
| Offset | 相对 active bin 的位置（+k 或 -k） |
| 价差收益 | 在低价 bin 买入、高价 bin 卖出赚取的价格差 |
| Spread | 价差，等价于 \|offset\| × bin_step |
| Lending park | 远端资金 supply 到 Scallop / Kai 吃 APR 的过程 |
| Set agent | 用户将 PM 委托给第三方 Agent 的操作 |
| Single-sided liquidity | 单侧流动性，bin 内只有一种资产 |
| IL | Impermanent Loss，无常损失 |
| PTB | Programmable Transaction Block，Sui 的交易构造单元 |
