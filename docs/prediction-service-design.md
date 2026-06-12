# LightGBM 预测服务技术方案

> 版本:v2.0(重写,取代 v1.0 的 Rust NAPI 方案)
> 基础文档:data-sources.md、forecasting-approach.md、implementation-plan-v1.md
> 预测目标:中心 bin + 宽度(P0)、未来波动率 σ̂(P1)
> 技术栈:Python(训练 + 推理 sidecar)+ TypeScript(编排)
> 集成方式:本地 HTTP sidecar(127.0.0.1),TS 经 `PredictionProvider` 接口调用
> 运行形态:常驻 Python 进程,supervisor 拉起

---

## 一、架构总览

### 1.1 两层职责划分

```
┌──────────────────────────────────────────────────────────┐
│                  TypeScript 编排层(src/prediction/)        │
│  - MarketSnapshot 组装(marketAggregator)                  │
│  - PredictionProvider 接口 → SidecarPredictionProvider     │
│  - 超时/失败 → fallback 标记 → mlAgent 切 Tier 0           │
│  - 健康监控、预测结果落 predictions 表                      │
└───────────────────────────┬──────────────────────────────┘
                            │ HTTP(127.0.0.1,超时 2s)
┌───────────────────────────┴──────────────────────────────┐
│                  Python sidecar(ml/serving/)              │
│  - 特征组装:与训练共享 ml/features/ 同一份代码              │
│  - LightGBM 推理(q10/q50/q90 + vol)                       │
│  - 派生量计算(width、p_above/p_below)                     │
│  - PSI 漂移监控、特征缺失统计                               │
│  - 模型版本管理 + /reload 热加载                            │
└───────────────────────────┬──────────────────────────────┘
                            │ 模型文件(离线产出)
┌───────────────────────────┴──────────────────────────────┐
│                  Python 训练层(ml/training/,离线)         │
│  - 特征工程(ml/features/,与 serving 共享)                 │
│  - LightGBM 训练(分位数回归 + 波动率回归)                  │
│  - walk-forward 评估、模型导出 + 元数据                     │
└──────────────────────────────────────────────────────────┘
```

### 1.2 为什么是 sidecar 而不是 Rust NAPI(决策记录)

v1.0 方案选择 Python 训练 + Rust 推理 + napi 绑定,理由是 `Strategy.plan` 同步签名要求 < 1ms 推理。该前提已不成立(`plan` 已改异步,见 implementation-plan-v1.md §3.1),重新评估:

| 维度 | Rust NAPI | Python sidecar |
|---|---|---|
| 推理核心 | LightGBM 官方 C++(经 lightgbm3 绑定) | **同一份** LightGBM 官方 C++(经 Python 包绑定) |
| 单次延迟 | < 1ms | 5–50ms(含 HTTP 往返) |
| 延迟预算 | 决策间隔 15–30 min,**两者都是预算的万分位** | 同左 |
| 特征工程 | Python 训练 / Rust 推理**各实现一遍** → train/serve skew 风险,需 feature_order/normalizers/sha256 契约对冲 | 训练与推理**共享同一份代码**,skew 类 bug 结构性消失 |
| 工具链 | Bun + uv + cargo(三条) | Bun + uv(两条) |
| 已知风险 | lightgbm-rs 维护一般;macOS arm64 编译踩坑史 | 无 |
| 工期 | 1 周 + buffer | 2–3 天 |

**结论:推理核心两边跑的是同一份 C++ 代码,"Rust 更快"只快在调用包装层(亚毫秒级),对分钟级决策毫无价值;而双语言特征契约是 ML 工程的头号事故源。** v1 用 sidecar;若 v2 决策频率进入秒级或推理路径出现真算力消耗(如蒙特卡洛),经 `PredictionProvider` 接口换 Rust 实现,框架不动。

### 1.3 数据流向

**离线训练流**(低频,人工触发):
```
parquet(ml/data/) → ml/features/ 特征工程 → LightGBM 训练 → ml/artifacts/<version>/ → 评估报告
```

**在线推理流**(每次决策,15–30 min 一次/池):
```
marketAggregator(TS) → MarketSnapshot → POST /predict → sidecar 特征组装(ml/features/)
  → LightGBM 推理 → PredictionResponse → mlAgent 消费 → predictions 表落库
```

---

## 二、模型设计

### 2.1 模型清单

| 模型 ID | 任务 | 算法 | 输出 |
|---|---|---|---|
| `q10` | 中心 bin 下分位 | LightGBM Quantile (α=0.1) | bin offset |
| `q50` | 中心 bin 中位数 | LightGBM Quantile (α=0.5) | bin offset |
| `q90` | 中心 bin 上分位 | LightGBM Quantile (α=0.9) | bin offset |
| `vol` | 未来 30min 波动率 | LightGBM Regression (L1) | σ̂(正数) |

**派生量计算**(sidecar 内完成):

```
center_offset = q50
width_sigma   = (q90 - q10) / 2.56
uncertainty   = q90 - q10
p_above = 1 - Φ((upper_bound_offset - q50) / width_sigma)
p_below = Φ((lower_bound_offset - q50) / width_sigma)
```

### 2.2 特征规格(v1:20–30 维,纯 Binance 源)

特征代码唯一存在于 `ml/features/`,训练与 serving 同 import,**不存在跨语言契约**。

```
[价格动量]   ret_5m, ret_15m, ret_30m, ret_60m, accel_5m
[波动率]     ewma_sigma, parkinson_30m, gk_30m, vol_ratio(短/长), atr_14
[跨市场]     btc_ret_5m, btc_ret_30m, eth_ret_30m, corr_btc_30m, rel_strength_btc
[衍生品]     funding_rate, funding_ma_8h, oi_change_30m, liq_volume_5m
[时间]       hour_of_day(sin/cos), day_of_week
```

**v1 不进特征集**(数据历史不足,v1.1 再评估):Cetus active_bin drift、swap flow、池子 TVL 变化。
**不预留 LLM/macro 特征位**:外部信号将来走 `PredictionProvider` 装饰器或 sidecar 内部后处理(见 §五),不靠占位特征。

维度刻意压在 20–30:训练窗口 6–12 个月 1min 数据,高维 + 重叠标签 = walk-forward 报告好看但线上失效的经典配方。加特征的纪律:每个新特征必须在 walk-forward 上单独证明 pinball 增益。

### 2.3 模型导出格式

```
ml/artifacts/<version>/          # version 形如 v1.0.0,目录不入 git
  ├── q10.txt / q50.txt / q90.txt / vol.txt    # LightGBM 原生文本格式
  ├── models_meta.json     # version、trained_at、data_window、feature 列表、git sha、sha256
  └── psi_baseline.json    # 训练集各特征分布桶,运行时算 PSI
```

LightGBM 原生 `.txt`:可读、可 diff、加载即用。不需要 normalizers(GBDT 不需要归一化)、不需要 feature_order 契约(同一份 Python 代码组装)。

---

## 三、训练层(`ml/training/`)

### 3.1 标签定义

```python
label_center = bin_of(vwap_next_30min) - current_active_bin
label_vol    = std(log_returns_next_30min)
```

时间对齐:特征只用 T 及之前;标签用 (T, T+30min];purged k-fold + embargo 防重叠标签泄漏。

### 3.2 训练流程

```
1. 从 parquet 加载 6–12 个月 1min 数据
2. ml/features/ 生成特征矩阵(固定 seed)
3. purged k-fold 时序切分 + walk-forward
4. 训练 4 个模型(quantile α=0.1/0.5/0.9 + regression_l1)
5. Optuna 超参搜索(预算受限:每模型 ≤ 50 trial,防止在验证集上过拟合)
6. 评估(§3.3)→ 导出 + 元数据
```

超参起点沿用 v1.0 方案(num_leaves=31、min_data_in_leaf=100、max_depth=6、L1/L2=0.1)。

### 3.3 评估指标与 gate(可证伪,主验收)

| 指标 | gate | baseline |
|---|---|---|
| pinball loss(q10/q50/q90 加权) | < 0.9× baseline | center=0 + EWMA σ 换算的分位数 |
| q10–q90 经验覆盖率 | 76–84%(目标 80%) | — |
| q50 方向准确率 | > 52% 且 binomial p < 0.05 | 50% |
| vol MAE / QLIKE | < EWMA σ | EWMA(λ=0.94) |

**降级路线**(写进计划,不算失败):若方向(μ)学不到但宽度(σ)校准达标,v1 只消费 `widthSigma` / `pAbove` / `pBelow`,中心保持 active——σ 的价值本就大于 μ(见 forecasting-approach.md)。

---

## 四、推理 sidecar(`ml/serving/`)

### 4.1 形态

- FastAPI + uvicorn,**仅监听 127.0.0.1**,端口 env `PREDICTION_SIDECAR_PORT`(默认 8765)
- supervisor(launchd / systemd / pm2)拉起,崩溃自动重启
- 启动时按 `PREDICTION_ARTIFACT_DIR`(或 `current` 软链)加载模型,< 1s

### 4.2 HTTP 契约

```
GET  /health
  → { "status": "ok", "model_version": "v1.0.0", "loaded_at": "...",
      "psi_summary": { "max": 0.08, "breached": [] } }

POST /predict
  入参:MarketSnapshot(JSON,与 src/prediction/types.ts 同形)
       + pm_range_context { active_bin, lower_offset, upper_offset }
  出参:PredictionResponse(JSON):
       { center_offset, center_q10, center_q90, width_sigma,
         p_above, p_below, model_version, feature_completeness,
         psi, fallback, infer_ms }

POST /reload
  入参:{ "artifact_dir": "ml/artifacts/v1.1.0" }
  出参:{ "model_version": "v1.1.0" }
  失败:HTTP 409 + 原版本继续服务(加载失败不得让旧模型下线)
```

`fallback` 字段语义(sidecar 自报的降级原因,TS 侧另加 `sidecar_down` / `timeout`):

| 值 | 含义 | 触发 |
|---|---|---|
| `false` | 正常 | — |
| `"psi"` | 特征分布漂移 | 任一特征 PSI > 0.25 连续 3 个 1h 窗口 |
| `"missing"` | 特征缺失过多 | completeness < 70% |
| `"stale"` | 输入数据陈旧 | snapshot ts 距今 > 评估间隔 |

sidecar 在 fallback 时**仍返回完整预测值**(供影子对比),由 TS 侧 `mlAgent` 决定是否弃用——降级决策权在消费方,不在服务方。

### 4.3 TS 侧:PredictionProvider

```ts
// src/prediction/provider.ts —— 开源接缝,fork 换模型只动这里
export interface PredictionProvider {
  readonly name: string;
  predict(snapshot: MarketSnapshot, ctx: PmRangeContext): Promise<PredictionResponse>;
  health(): Promise<ProviderHealth>;
}
```

| 实现 | 用途 |
|---|---|
| `NullPredictionProvider` | center=0、width=EWMA σ、log-normal 闭式 p_above/below。W2 打通链路、单测、语义参照 |
| `SidecarPredictionProvider` | fetch → 127.0.0.1 sidecar,超时 2s;连接失败/超时返回 `fallback: "sidecar_down" | "timeout"`,**不抛出、不静默**,由 mlAgent 显式记录并切 Tier 0 |

### 4.4 失败语义(与全仓"不写静默 fallback"约定的关系)

降级到 Tier 0 是**文档化的、分层风控设计的一部分**,不是 try/catch 兜底:每次 fallback 都落 `predictions.fallback` 字段 + 日志 + 监控计数;fallback 占比 > 20% 是影子/实盘的硬告警线。任何"预测失败但没有留下记录"的路径都是 bug。

---

## 五、外部信号(LLM / macro)的位置

v1.0 方案在特征 schema 里预留了 7 个外部信号位。v2.0 取消预留,理由:占位特征以默认值参与训练,模型对它们的响应未经校准,实际接入时仍要重训——预留没有兑现"免重训"的承诺。

将来接入外部信号的两条路(都不动框架):

1. **后处理装饰器**(推荐起步):`class SignalAdjustedProvider implements PredictionProvider`,包装任意 Provider,在输出上做规则调整(宏观风险高 → width 收紧、p_break 上调)。可解释、可独立开关、不碰模型。
2. **进模型**:信号定义稳定且积累了足够历史回填后,作为普通特征进 `ml/features/` 重训。届时它就是一个普通特征,无需特殊机制。

LLM 不直接输出价格/分布(数值精度差、不可校准),定位见 forecasting-approach.md:meta 控制、特征生成、事后归因解释。

---

## 六、模型生命周期管理

### 6.1 版本管理

```
ml/artifacts/
  ├── v1.0.0/                  # 完整模型 + meta + psi_baseline
  ├── v1.1.0/
  └── current → v1.1.0         # 软链指向生产版本
```

每版本自包含、可回滚。`models_meta.json` 记录训练数据窗口与训练代码 git sha——开源仓库交付可复现性,不交付模型产物(artifacts 不入 git)。

### 6.2 上新流程

```
1. 训练 → 导出新版本目录
2. 离线 gate(§3.3)不低于现版本
3. 影子对比:sidecar 同时加载新旧版本,/predict 双跑记录(决策只用旧)3–7 天
4. 新版本在线指标(覆盖率、pinball 回填)不差 → POST /reload 切换
5. 旧版本目录保留,回滚 = 再 reload 一次
```

### 6.3 漂移监控

- 特征 PSI vs `psi_baseline.json`:> 0.25 连续 3 个 1h 窗 → fallback="psi" + P1 告警 + 触发重训评估
- 在线区间覆盖率(预测 vs 30min 后实际)滚动回填:偏离离线值 > 5pp → P1 告警
- 滚动 pinball 持续上升 → 重训

---

## 七、性能与监控

| 指标 | 目标 | 说明 |
|---|---|---|
| /predict p99 | < 200ms | 决策间隔分钟级,200ms 余量 75 倍以上 |
| /predict 超时(TS 侧) | 2s | 超时即 fallback,不重试(下个 tick 自然重试) |
| 模型加载 | < 1s | 启动 / reload |
| sidecar 可用性 | 由 supervisor 保证 | TS 侧每分钟 /health 探活进监控 |

埋点:推理耗时分位、特征缺失率(按特征)、fallback 计数(按原因)、PSI 摘要、模型版本。全部进 `predictions` 表与日志,影子报告直接消费。

---

## 八、目录结构

```
ml/
├── pyproject.toml               # uv 管理
├── data/                        # 采集 + parquet
├── features/                    # ★ 训练与 serving 共享的特征代码
├── training/                    # train_quantile.py / walk_forward.py / export.py
├── serving/
│   ├── app.py                   # FastAPI:/predict /health /reload
│   ├── psi.py                   # PSI 监控
│   └── registry.py              # 版本加载/软链管理
├── backtest/                    # l1_runner.py / fee_model.py
├── artifacts/                   # 模型产物(gitignore)
└── tests/

src/prediction/
├── types.ts                     # MarketSnapshot / PredictionResponse
├── provider.ts                  # PredictionProvider 接口
├── nullProvider.ts
└── sidecarProvider.ts
```

---

## 九、关键设计决策回顾

1. **训练与推理同语言、共享特征代码** —— 消灭 train/serve skew,这是放弃 Rust 的核心收益
2. **sidecar 进程隔离** —— Python 崩溃不连累 Agent;supervisor 拉起;TS 超时即降级
3. **PredictionProvider 是开源接缝** —— fork 换模型/换服务/上 Rust 都只换实现,框架不动
4. **降级显式且留痕** —— fallback 字段贯穿 sidecar → TS → DB,占比超 20% 告警;无静默路径
5. **不预留占位特征** —— 外部信号走装饰器或正式进特征重训,不做未兑现的"免重训"承诺
6. **加载失败不下线旧模型** —— /reload 409 回滚语义,推理服务永远有可用版本
7. **模型产物不入库** —— 仓库交付管线与可复现性(数据窗口 + git sha + seed),alpha 归 fork 自己

---

## 参数与契约总表

| 项 | 值/约定 |
|---|---|
| 预测周期 | 未来 30 min |
| 模型数量 | 4(q10/q50/q90 + vol) |
| 特征维度 | 20–30(v1,纯 Binance 源) |
| 宽度换算 | (q90 − q10) / 2.56 |
| sidecar 端口 | 127.0.0.1:`PREDICTION_SIDECAR_PORT`(默认 8765) |
| TS 超时 | 2s,超时不重试 |
| /predict p99 | < 200ms |
| PSI 阈值 | 0.25,连续 3 个 1h 窗 |
| 特征缺失阈值 | completeness < 70% → fallback |
| fallback 告警线 | 占比 > 20%(影子与实盘同) |
| 模型格式 | LightGBM 原生文本 |
