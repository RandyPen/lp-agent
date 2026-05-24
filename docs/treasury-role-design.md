# Treasury 角色 — 设计文档

> 参考 `~/Code/SuiAgentsTopUp` 的模式(本机外部 repo,非依赖);只移植真正需要的部分。
> 关联:CLAUDE.md §"Multi-role keys" 已经预留了接口位。

> **Status (2026-05-24): v1 implemented in code.**
> 本文档描述的 v1 范围全部落地。schema、keypair、store、credits、registration、watcher、charges、service runtime、rebalancer 集成、5 个运营脚本(register / list-users / list-balances / update-rate / verify-treasury-address)+ 51 个测试均已合入并通过。
> 实际签名(`attemptCharge` / `refundCharge` / `registerUser` 等)与设计完全对齐。v2 及之后的范围(HTTP API、聚合器 swap、加密 seed、用户主动退款)按本文末尾 §"What's next (v2)" 推进。

---

## 1. 目的与边界

**Treasury 角色要做的事**:
- 用户充值到一个**专属充值地址**(per-user address);**v1 接受 SUI 和 USDC;架构 coin-agnostic,任何 Move coin type 都可以加,无需改 schema 或代码**(运营流程见 §6.1)
- 链下账本(SQLite)记录每个用户的余额(credits)
- 作为 agent 调仓的**双重把关**:
  - **门槛**:PM owner 必须在 treasury 注册且 `credits > 0`,否则该 PM 整个跳过
  - **扣减**:每次调仓成功后按 `cost = base + volume_usdc_atomic × fee_rate` 扣 credits(公式 + 默认值见 §6 env 与 §9.2);余额扣到 ≤ 0 后,下次 tick 在门槛处被拒
- 运营时支持把多个充值地址里的钱归集到一个集中地址,可选 swap 成稳定币

**Treasury 角色不做的事**:
- 不签调仓 PTB(agent 角色的事)
- 不读 / 不写 PM 状态、池子状态(treasury 完全不接触 CDPM)
- 不主动决定服务定价(运营在数据库 + env 里维护 — 见 §9.2)
- **v1 内部扣减不需要用户签名** — PM owner 把托管权委托给 agent 地址(链上 `AgentAdded` 事件)就是默示授权;`treasury_service_charges.signature` 这种列推到 v2 当 HTTP API 暴露给客户端时再加
- v1 不做 HTTP 服务、不做聚合器自动 swap、不做加密 seed 文件、不做退款(都推到 v2 / 产品化 — 退款见 §9.5)
- **不跨链**。Treasury 只在 Sui 主网工作 — 不连其他链 RPC、不集成跨链桥、不做 wrapped 资产的 1:1 兑换逻辑。任何 Sui 链上原生 / 已桥接进来的 Move coin type(SUI / 原生 USDC / 桥接的 wUSDT / DEEP / wBTC 等)在 treasury 视角里**一视同仁**,只通过 `credit_rates` 表区分价值。

**v1 范围 = MVP**:
- 用户注册 → 获得专属地址
- 轮询 watcher 检测充值 → 入账
- 签名校验的服务费扣减 API(给 agent 内部调用,不开公网)
- 运营脚本:列充值地址、列余额、人工 sweep(用 `scripts/`,gitignored)

---

## 2. 与现有架构的关系

```
.env:
  # agent 角色(已落地)
  MNEMONICS=<agent phrase>           # 调仓 0xf3f8feeba6... 用
  AGENT_DERIVATION_PATH=m/44'/784'/1'/0'/0'
  EXPECTED_AGENT_ADDRESS=0xf3f8feeba6...
  
  # treasury 角色(本设计新增)
  TREASURY_MNEMONICS=<完全不同的 phrase>
  TREASURY_MASTER_DERIVATION_PATH=m/44'/784'/0'/0'/0'   # 主地址(运营 sweep 用)
  TREASURY_USER_BASE_PATH=m/44'/784'/0'/0'             # 每用户 = TREASURY_USER_BASE_PATH/{index}'
  EXPECTED_TREASURY_MASTER_ADDRESS=0x...               # 主地址守卫,强烈建议
```

**关键不变量**:agent 模块不 import treasury 模块,treasury 模块不 import agent 模块。两个角色在 process 里共享 `loadConfig()`、共享 `getDb()`,但**密钥派生 / 缓存完全隔离**。每个角色读自己的 env,出错时错误消息明确包含 role 名(已实现的 `resolveKeypair` 已经这样做)。

**与 rebalancer 的唯一耦合点**:rebalancer 在调度 PM 时调用 `treasury.consumeCreditsForRebalance(ownerAddress, planSize)`,余额不足则跳过这个 PM 这一 tick。鉴权由签名消息保护,但消息可由 agent 自己签 — 设计稍后展开。

---

## 3. 数据模型(追加到 `src/db/schema.sql`)

> **已实现** — 6 张 `treasury_*` 表全部在 `src/db/schema.sql` 末尾,与本节定义一字对齐(`treasury_users` 的 `derivation_index ≥ 1` 和 `credits ≥ 0` 的 CHECK 约束也已加上)。
>
> 本项目不做版本化迁移。schema 是一个文件,全部 `CREATE … IF NOT EXISTS`,启动每次跑一遍。加表 = 在 `schema.sql` 末尾追加,不需要新 migration、不需要更新版本号。Dev DB 重启即生效。
>
> **v1 共 6 张表**:`treasury_users` / `treasury_credit_rates` / `treasury_address_balances` / `treasury_deposits` / `treasury_service_charges` / `treasury_ops`。
> v1 的 `treasury_service_charges` **不收 signature / message_b64 列**(内部扣减无需用户签名);v2 暴露 HTTP API 给客户端时直接在 schema.sql 加新列。

```sql
-- 充值用户表。一个 sui_address(用户主钱包)对应唯一 derivation_index 和
-- 唯一 deposit_address(由 TREASURY_USER_BASE_PATH/{index}' 派生)。
CREATE TABLE IF NOT EXISTS treasury_users (
  sui_address       TEXT PRIMARY KEY,   -- 用户自己钱包的地址(用于签名验证)
  derivation_index  INTEGER NOT NULL UNIQUE,
  deposit_address   TEXT NOT NULL UNIQUE,
  credits           INTEGER NOT NULL DEFAULT 0,
  created_at_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS treasury_users_deposit_address
  ON treasury_users(deposit_address);

-- 信用兑换率。运营在 admin 流程里(脚本)更新。每种 coin_type 一条。
-- credits_granted = floor(amount_smallest_units * rate_num / rate_den)
CREATE TABLE IF NOT EXISTS treasury_credit_rates (
  coin_type      TEXT PRIMARY KEY,
  rate_num       TEXT NOT NULL,         -- bigint as string
  rate_den       TEXT NOT NULL,         -- bigint as string
  updated_at_ms  INTEGER NOT NULL,
  updated_by     TEXT
);

-- watcher 看到的最新余额快照。idempotency 用:只有正向 delta 才入账。
CREATE TABLE IF NOT EXISTS treasury_address_balances (
  deposit_address    TEXT NOT NULL,
  coin_type          TEXT NOT NULL,
  last_seen_balance  TEXT NOT NULL,     -- bigint as string
  last_seen_ms       INTEGER NOT NULL,
  PRIMARY KEY (deposit_address, coin_type)
);

-- 充值流水。append-only 审计。
CREATE TABLE IF NOT EXISTS treasury_deposits (
  id                TEXT PRIMARY KEY,   -- ULID
  sui_address       TEXT NOT NULL,      -- FK treasury_users
  deposit_address   TEXT NOT NULL,
  coin_type         TEXT NOT NULL,
  amount_delta      TEXT NOT NULL,      -- bigint as string,实际链上增量
  prev_balance      TEXT NOT NULL,
  new_balance       TEXT NOT NULL,
  credits_granted   INTEGER NOT NULL,
  rate_num          TEXT,
  rate_den          TEXT,
  observed_at_ms    INTEGER NOT NULL,
  FOREIGN KEY (sui_address) REFERENCES treasury_users(sui_address)
);
CREATE INDEX IF NOT EXISTS treasury_deposits_user
  ON treasury_deposits(sui_address, observed_at_ms DESC);

-- 服务费扣减审计表。每次调仓在 INSERT 时同步 UPDATE treasury_users.credits。
-- nonce 作主键防重放(rebalancer 用 `${tickId}:${pmId}` 生成);UNIQUE 冲突意味着
-- 同一 tick 同一 PM 的扣减已记录,直接拒绝重复请求。
-- v1 不收 signature / message_b64 — 内部扣减由 rebalancer 自己代为发起,
-- PM owner 通过 AgentAdded 链上事件默示授权。v2 暴露 HTTP API 时 ALTER TABLE
-- 加 signature / message_b64 / verified_at_ms 列。
CREATE TABLE IF NOT EXISTS treasury_service_charges (
  nonce            TEXT PRIMARY KEY,
  sui_address      TEXT NOT NULL,
  pm_id            TEXT,                  -- 调仓上下文,可空(将来非 rebalance 扣减场景)
  credits_debited  INTEGER NOT NULL,
  memo             TEXT,                  -- 自由文本,如 "rebalance bins=12"
  status           TEXT NOT NULL CHECK(status IN ('ok','rejected','refunded')),
  error            TEXT,                  -- rejected 时填 'insufficient_credits' 等
  created_at_ms    INTEGER NOT NULL,
  FOREIGN KEY (sui_address) REFERENCES treasury_users(sui_address)
);
CREATE INDEX IF NOT EXISTS treasury_service_charges_user
  ON treasury_service_charges(sui_address, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS treasury_service_charges_pm
  ON treasury_service_charges(pm_id, created_at_ms DESC);

-- 运营操作流水(sweep / swap / 手工转账)。append-only。
CREATE TABLE IF NOT EXISTS treasury_ops (
  id               TEXT PRIMARY KEY,
  op_kind          TEXT NOT NULL CHECK(op_kind IN ('sweep', 'transfer', 'swap')),
  from_address     TEXT NOT NULL,
  to_address       TEXT,                  -- swap 时可空
  coin_type_in     TEXT NOT NULL,
  amount_in        TEXT NOT NULL,
  coin_type_out    TEXT,                  -- swap 时填
  amount_out       TEXT,                  -- swap 时填
  digest           TEXT,
  status           TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
  error            TEXT,
  initiated_by     TEXT NOT NULL,         -- 'operator-script' / 'auto-sweep'
  created_at_ms    INTEGER NOT NULL
);
```

**与 SuiAgentsTopUp 的 schema 差异**:
- 表名加 `treasury_` 前缀 — 避免和现有的 `rebalances`、`lending_positions` 等表混淆。本项目一个 SQLite,两个角色共享文件。
- 不引入 `agents` 表 — agent 信息已在现有的 `subscriptions` 表里。
- 不引入 user_metadata 表 — MVP 不需要。

---

## 4. 代码结构(已实现)

> **已实现** — 模块布局与下面一致。`operator.ts` 与 `treasury-sweep.ts` 推迟到 v2(见 §"What's next");service 层把"暴露给 rebalancer 的 API"直接拆成纯函数 `attemptCharge` / `refundCharge`(由 rebalancer 直接 import `src/treasury/charges.ts`),没有再包一层 `consumeCreditsForRebalance` — 数据模型即接口。

```
src/
├── sui/keypairs/
│   └── treasury.ts              # ✅ master singleton + per-user 派生(不缓存)
├── treasury/                     # ✅ 顶层目录
│   ├── types.ts                  # User / CreditRate / Deposit / ServiceCharge / Op / ChargeResult
│   ├── store.ts                  # SQL 访问 + 事务封装(attemptChargeTx / refundChargeTx / recordDepositTx)
│   ├── credits.ts                # creditsForAmount + estimateRebalanceCost
│   ├── registration.ts           # registerUser(sui_address)
│   ├── watcher.ts                # 轮询 getAllBalances,delta > 0 → 入账,失败隔离
│   └── charges.ts                # attemptCharge / refundCharge(高层 facade + 日志)
└── services/
    └── treasuryService.ts        # ✅ startTreasuryService(cfg) → { stop() } —— 拉起 watcher

scripts/
├── treasury-register-user.ts     # ✅
├── treasury-list-users.ts        # ✅
├── treasury-list-balances.ts     # ✅
├── treasury-update-rate.ts       # ✅
└── verify-treasury-address.ts    # ✅

(注:`treasury-sweep.ts` 与 `src/treasury/operator.ts` 推迟到 v2;v1 无 sweep / swap 需求,
运营场景用 sui CLI / 钱包手动操作即可。`treasury_ops` 表已就位,等 v2 用。)
```

**关键模块说明**(全部已实现):

### `src/sui/keypairs/treasury.ts` ✅
镜像 `agent.ts`,但导出两类 keypair:
- `getTreasuryMasterKeypair()` — sweep / swap 时用,签名 master 地址上的钱;cache 是模块私有
- `getUserDepositKeypair(derivationIndex)` — 派生用户专属地址。**不缓存** — sweep / 转账场景里每次重新派生。理由:per-user keypair 数量随用户增长可能很大,常驻 cache 内存压力大;派生本身极快(纳秒级 BIP-32)。

派生方案:
```ts
// master:        TREASURY_MASTER_DERIVATION_PATH  默认  m/44'/784'/0'/0'/0'
// user index N:  TREASURY_USER_BASE_PATH/N'        默认  m/44'/784'/0'/0'/N' (N >= 1)
```

注意 master 用 `0`、用户从 `1` 开始 — 与 agent 角色的 `m/44'/784'/1'/0'/0'` 完全不冲突,因为助记词本身就不同。

### `src/treasury/store.ts` ✅
所有 SQL CRUD 都在这里。**纯函数级别**,不持有连接(用 `getDb()`)。所有写入用 SQLite 事务包裹。

### `src/treasury/registration.ts` ✅
`registerUser(suiAddress: string) → TreasuryUser` — 在事务里分配下一个 `derivation_index`(`SELECT MAX(derivation_index)+1`),调 `deriveUserDepositAddress(index)` 派生地址,写 `treasury_users` 表。地址格式校验由 facade 完成,后续 `registerUserTx` 是幂等的(重复 suiAddress 返回原行)。

### `src/treasury/watcher.ts` ✅
```
轮询循环:
  for each treasury_users.deposit_address:
    listBalances(deposit_address) ← gRPC
    for each (coin_type, current_balance):
      cached = treasury_address_balances.last_seen_balance
      delta = current_balance - cached
      if delta > 0:
        credits = floor(delta * rate.num / rate.den)
        在事务里:
          INSERT INTO treasury_deposits ...
          UPDATE treasury_users SET credits = credits + ...
          UPSERT treasury_address_balances ...
      else if delta < 0:
        # 运营 sweep / 用户被骗发其他人(理论上不该发生)
        # 仅更新 cache,不动 credits
```

参考 SuiAgentsTopUp `/src/services/watcher.ts:30–174`。**实现里 per-user 一次 `client.getAllBalances({owner})`,然后在内存里逐 `coin_type` 比 delta**,避免对每个 (user × coin) 都发 RPC;失败按 user 隔离,一个 RPC 错误不阻塞其他 user。

### `src/treasury/charges.ts` ✅

**v1 扣减只由 rebalancer 内部触发**,不验证用户签名。PM owner 通过 `AgentAdded` 链上事件把信任权委托给 agent 地址 — 这就是默示授权。

实际签名(已实现):

```ts
attemptCharge({ suiAddress, pmId, cost, nonce, memo? }) → ChargeResult
refundCharge(nonce, reason) → boolean
```

`charges.ts` 是薄薄一层 facade,实际事务在 `store.ts` 的 `attemptChargeTx` / `refundChargeTx` 里。facade 负责日志(`ok` / `rejected` / 替换值 replay 告警)和 `ChargeResult` 封装。

```
attemptCharge({ suiAddress, pmId, cost, memo, nonce }):
  BEGIN TRANSACTION
    1. INSERT INTO treasury_service_charges (nonce, sui_address, pm_id, credits_debited=0, memo, status='ok', created_at_ms)
       — UNIQUE(nonce) 保证幂等;若已存在 → 重放,直接 SELECT 现有行返回
    2. SELECT credits FROM treasury_users WHERE sui_address = ? FOR UPDATE
       — 用户未注册 → status='rejected', error='not_registered'
       — credits < cost → status='rejected', error='insufficient_credits', credits_debited=0
       — credits >= cost → UPDATE treasury_users SET credits = credits - cost
                          ; UPDATE treasury_service_charges SET credits_debited = cost, status='ok'
  COMMIT
  return { ok, remainingCredits, chargeNonce, error? }

refundCharge(nonce, reason):
  BEGIN TRANSACTION
    1. SELECT credits_debited FROM treasury_service_charges WHERE nonce = ? AND status = 'ok'
       — 不存在或已 refunded → 无操作
    2. UPDATE treasury_users SET credits = credits + credits_debited WHERE sui_address = ...
    3. UPDATE treasury_service_charges SET status='refunded', error=$reason
  COMMIT
```

**幂等性保证**:rebalancer 用 `${tickId}:${pmId}` 当 nonce。即使同一 tick 因 crash 重试,第二次 attemptCharge 看到现有 'ok' 行,直接返回现有结果,不会重复扣减。

**v2 暴露 HTTP API 时**,新增 `chargeForServiceWithSignature({ suiAddress, credits, messageB64, signature, nonce })` 函数 — 验证用户的 personal-message 签名后调用同一个 `attemptCharge`。schema 也在那时 ALTER TABLE 加 signature 列。

### `src/services/treasuryService.ts` ✅
runtime 入口:启动 watcher。**rebalancer 不通过 service 暴露的接口与 treasury 交互**,直接 import `src/treasury/charges.ts` 的 `attemptCharge` / `refundCharge` —— 数据模型即接口,没有再包一层 RPC seam。

```ts
export interface TreasuryService {
  stop(): void;
}

startTreasuryService(cfg: TreasuryAppConfig): TreasuryService
```

**鉴权(v1 实现)**:无任何签名校验 — PM owner 通过链上 `AgentAdded` 事件向 agent 地址默示授权,rebalancer 内部以 `${tickId}:${pmId}` 为 nonce 写 `treasury_service_charges`,store 原子扣减。

**v2 才引入的"两层签名"设想(预授权 + 单次签名)** 已迁出 service 接口设计,放到 `chargeForServiceWithSignature` 这条 v2 路径下,与 HTTP API + `ALTER TABLE treasury_service_charges ADD signature, message_b64` 一起做。详见 §"What's next"。CLAUDE.md 里"v1 简化为注册即授权"的注记继续有效。

---

## 5. 与 rebalancer 的集成

> **已实现** — `src/services/rebalancer.ts` 的 `tickOne(pmId)` 已经按下面的形态接入 Treasury(`TREASURY_ENABLED=true` 时启用,默认 false)。`findUserBySuiAddress` 检查注册状态;`attemptCharge` 在 PTB 提交前预扣;`refundCharge` 在 PTB 失败的 catch 分支里调用。
>
> 唯一的实现细节差异:当 PM owner **未注册** 但 `TREASURY_REQUIRE_REGISTRATION=false` 时,rebalancer 跳过 treasury(不扣 credits),走旧行为提交 PTB —— 让 dev 模式可以不开 treasury 也能跑。

`src/services/rebalancer.ts` 当前的 `tickOne(pmId)` 在策略产出 `plan_and_reconcile / plan_only` 后立即提交 PTB。集成 treasury 在策略产出后、PTB 提交**前**做门槛 + 扣减,提交**后**根据结果决定是否退款:

```ts
// tickOne 中,output.kind 是 plan_and_reconcile 或 plan_only 后:
let chargeNonce: string | null = null;
if (cfg.treasury.enabled) {
  // spot 已经在前文 await priceFeed.getSpot() 拿到 — 直接复用,不再多打一次 RPC
  const cost = estimateRebalanceCost({
    plan,
    profile: cfg.poolProfile,
    spotPriceUsdcPerA: Number(spot.price),
    cfg: cfg.treasury,
  });
  const charge = await treasury.attemptCharge({
    suiAddress: pm.owner,
    pmId,
    cost,
    nonce: `${tickId}:${pmId}`,
    memo: `rebalance volume_a=${plan.addAmountA} volume_b=${plan.addAmountB}`,
  });
  if (!charge.ok) {
    // 门槛 + 扣减失败(未注册 / 余额不足)→ 这个 PM 这个 tick 跳过
    log.warn("rebalancer: skipped — treasury charge rejected", {
      tickId, pmId, error: charge.error,
    });
    return;  // 注意不写 rebalances 行 — 我们没真做事,不该污染调仓日志
  }
  chargeNonce = charge.chargeNonce;
}

// ...执行 PTB(unified 或 legacy 路径)...

try {
  // ...提交 + 检查结果...
} catch (err) {
  // 调仓失败 → 退还本次扣减
  if (chargeNonce) {
    await treasury.refundCharge(chargeNonce, finalError ?? 'rebalance_failed').catch(...);
  }
  throw err;
}
```

**`estimateRebalanceCost(...)`**(`src/treasury/credits.ts`):
```ts
// 单位约定:
//   - base:     credits(整数)
//   - fee_rate: credits / USDC_atomic_unit(小数)
//   - 返回:    credits(整数,floor)
//
// volume 是这次调仓部署的总值,折算到 USDC raw atomic(6 位精度,1 USDC = 1e6)。
// A 边用 spot 价格折算,B 边假定是 USDC stable side(sui-usdc 池满足)。
function estimateRebalanceCost(args: {
  plan: RebalancePlan;
  profile: PoolProfile;      // 提供 decimalsA/B,标记 B 是否 USDC-stable
  spotPriceUsdcPerA: number; // 来自 priceFeed.getSpot()
  cfg: { baseCost: number; feeRate: number };
}): number {
  // A 边折算到 USDC raw atomic:
  //   aUsdcAtomic = aAtomic × spot × 10^(decimalsB − decimalsA)
  const aUsdcAtomic =
    Number(args.plan.addAmountA) *
    args.spotPriceUsdcPerA *
    Math.pow(10, args.profile.decimalsB - args.profile.decimalsA);
  const bUsdcAtomic = Number(args.plan.addAmountB);  // 已是 USDC raw
  const volumeUsdcAtomic = aUsdcAtomic + bUsdcAtomic;

  const variable = volumeUsdcAtomic * args.cfg.feeRate;
  return Math.floor(args.cfg.baseCost + variable);
}
```

**v1 默认值 + 直观换算**(env 占位,运营上线前在 .env 里调):
- `TREASURY_REBALANCE_BASE_COST=10` → 每次调仓底价 10 credits = 0.10 USDC
- `TREASURY_REBALANCE_FEE_RATE=0.0000001` → 0.1% 管理费(详细推导:1 USDC = 1e6 atomic × 1e-7 = 0.1 credits = 0.001 USDC = 0.1% of 1 USDC)
- 直观:1000 USDC 规模调仓 → base 10 + variable 100 = 110 credits ≈ 1.10 USDC

**关于 B 边 USDC stable side 假设**:目前 `sui-usdc` 池满足(B = USDC)。将来加 `sui-usdt` / `usdc-usdt` 等池子要扩展 — 在 `PoolProfile` 加 `usdcStableSide: 'A' | 'B' | null` 字段,`estimateRebalanceCost` 按字段选边。本文档暂只服务 sui-usdc,简化处理。

**精度注意**:`Number(plan.addAmountA)` 转 bigint→number 时,SUI atomic 超过 9e15(即 ~9M SUI)会丢精度。v1 单 PM 资金量远低于此(实际 PM 最多几千 SUI),Number 足够。若将来需要更大,改成 bigint 全程 + 最后才转回 Number。

**事件监听侧的辅助记录**(`src/services/subscriptions.ts` 已有 AgentAdded 处理):
当 AgentAdded 写 subscriptions 表时,**同步查一次 `treasury_users.credits`**,在日志里标注用户登记 + 余额状态。这不是门槛(实际门槛在 tickOne 上),而是给运营一份"哪些新接的 PM 还没付费"的实时清单,方便引导用户。

```ts
// subscriptions.ts 的 AgentAdded handler 末尾追加:
if (cfg.treasury.enabled) {
  const user = treasuryStore.findUserByAddress(pm.owner);
  log.info("subscriptions: agent added — treasury status", {
    pmId, owner: pm.owner,
    treasuryRegistered: user !== null,
    credits: user?.credits ?? 0,
  });
}
```

**关键不变量**:
- treasury **不存在 / 关闭** 时(`cfg.treasury.enabled = false`)→ rebalancer 走原行为,不调 treasury
- treasury 启用但用户未注册 → 永远跳过该 PM(不消费 RPC、不写 rebalances 行)
- 用户余额扣到 0 后,下次 tick 在 attemptCharge 时被拒,继续跳过
- PTB 提交失败 → 退款,credits 回到扣减前;`treasury_service_charges` 行标 `refunded`
- nonce 用 `${tickId}:${pmId}` — tickId 在 rebalancer 内已实现,天然防重放

---

## 6. env 变量(新增,treasury 角色)

> **已实现** — 下面所有变量都在 `src/config.ts` 里解析并验证(`TREASURY_WATCHER_INTERVAL_MS > 0`、`TREASURY_REBALANCE_BASE_COST ≥ 0`、`TREASURY_REBALANCE_FEE_RATE ≥ 0` 等)。`.env.example` 已更新。

```
# 必选(至少一个)
TREASURY_MNEMONICS=<phrase,与 agent 完全不同>
# 或:
TREASURY_PRIVATE_KEY=suiprivkey1...      # master keypair 的显式覆盖

# 可选(有默认值)
TREASURY_MASTER_DERIVATION_PATH=m/44'/784'/0'/0'/0'
TREASURY_USER_BASE_PATH=m/44'/784'/0'/0'   # per-user 地址在 BASE_PATH/{index}'
EXPECTED_TREASURY_MASTER_ADDRESS=0x...     # master 地址守卫,生产强烈建议
TREASURY_ENABLED=true                       # 总开关
TREASURY_WATCHER_INTERVAL_MS=15000
TREASURY_REBALANCE_BASE_COST=10            # credits,固定底价,每次调仓必收
TREASURY_REBALANCE_FEE_RATE=0.0000001      # credits / USDC_atomic_unit;0.0000001 ≈ 0.1% 管理费
                                            # cost = base + volume_usdc_atomic × fee_rate
TREASURY_REQUIRE_REGISTRATION=false        # v1 默认软模式
```

---

## 6.1 多币种支持 — 设计、运营、安全约束

**范围声明**:**单链(Sui 主网) + 多币种**。"多币种"指 Sui 链上的任意 Move coin type(包括桥接资产如 wUSDT、wETH),不指其他链。任何"跨链"的需求(用户从以太坊充值、提款到 BSC 等)都在本设计之外,需要单独引入桥接层。

### 架构(已 coin-agnostic,本节只是把隐含约束讲透)

| 维度 | 处理方式 |
|---|---|
| **Schema** | `treasury_credit_rates.coin_type` 是主键;`treasury_address_balances` PK 含 `coin_type`;`treasury_deposits.coin_type` 列。**已经支持任意 Sui Move coin type**。 |
| **Watcher** | 每个 deposit_address 调 `client.listBalances(addr)`,gRPC 直接返回当前 Sui 地址持有的全部 coin type — 不需要在代码里枚举支持的币种。 |
| **派生地址** | 每用户**一个**充值地址,所有 Sui 上的币种都收到同一个 Sui 地址。SUI、USDC、未来的 wUSDT / DEEP / wBTC 全部到一处。 |
| **Type 规范化** | 所有 `coin_type` 字段在写库前必须经 `src/sui/lending/typeNorm.ts → canonicalType()`(已有)。原因:`0x2::sui::SUI` 与 `0x0000…0002::sui::SUI` 是同一种币的两种写法,credit_rates 用一种、watcher 收到另一种,会查不到 rate。 |

### v1 上线时预先入库的 rates(SUI / USDC)

```sql
-- 由运营脚本 `scripts/treasury-update-rate.ts` 在 v1 上线前执行一次。
-- 例:1 credit = 0.01 USDC,SUI 按汇率 1 SUI = N USDC 折算(汇率由运营定)。

INSERT INTO treasury_credit_rates (coin_type, rate_num, rate_den, updated_at_ms, updated_by) VALUES
  -- USDC(原生,6 位精度):1 credit = 0.01 USDC = 10_000 atomic units → 100 credits per 1 USDC
  ('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
   '1', '10000',                       -- credits = floor(amount_atomic * 1 / 10000)
   <ms>, 'bootstrap'),
  -- SUI(9 位精度,假设 1 SUI = 2.5 USDC,则 1 SUI = 250 credits = 2.5e8 credits per 1e9 atomic):
  ('0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
   '25', '100000000',                   -- credits = floor(amount_atomic * 25 / 1e8)
   <ms>, 'bootstrap');
```

**rate_num / rate_den 是 bigint 字符串**,所以可以表达任意精度(>1 倍率也行,如 1 SUI = 10000 credits 用 `1, 100000`)。具体数字让运营在 §9.1 拍板。

### 新增第 N 个币种(运营流程,5 分钟操作)

```bash
# 1. 准备:确定币种的 Move type tag、精度、credit 兑换比
COIN_TYPE='0x…::coin::TOKEN_X'
DECIMALS=6
CREDITS_PER_UNIT=50           # 1 个币 = 50 credits

# 2. 计算 rate_num / rate_den
#    credits = floor(amount_atomic × num / den)
#    要让 1 个币(= 10^DECIMALS 个 atomic 单位)= CREDITS_PER_UNIT 个 credits:
#    num/den = CREDITS_PER_UNIT / 10^DECIMALS  →  num = CREDITS_PER_UNIT, den = 10^DECIMALS

# 3. 写入(脚本会做 canonicalType 规范化):
bun run scripts/treasury-update-rate.ts \
  --coin "$COIN_TYPE" --num 50 --den 1000000

# 4. (无需重启 watcher)下一轮 watcher tick 自动开始为这种币计 credits;
#    在之前已经入账但当时 rate 未设的历史 deposits 不会自动回溯,需要 §6.1 的回填脚本。
```

### 用户在 rate 未设时充入的处理

**默认行为(必须的安全 invariant)**:watcher 看到 deposit_address 收到了一个 `treasury_credit_rates` 表里没有的 `coin_type`,**仍然**写一行 `treasury_deposits`,但 `credits_granted = 0`、`rate_num = rate_den = NULL`。链上的钱**已经收到** — credits 没发只是因为不知道按什么价收。

这样可以:
- 资金不丢(链上看得见,人工可处理)
- 审计可追溯(`SELECT * FROM treasury_deposits WHERE credits_granted = 0` 一查就出)
- 给运营一个"先收着、回头定价、再补 credits"的窗口

**回填脚本**(v1 需要,1 小时实现):
```bash
bun run scripts/treasury-backfill-credits.ts --coin "$COIN_TYPE"
```
对该 coin_type 下所有 `credits_granted = 0` 的 deposits 重新计算 credits,做两件事:
1. UPDATE 该 deposit 行的 `credits_granted` + `rate_num/den`
2. UPDATE 对应 user 的 `credits +=` 回填量

**严格幂等**:脚本必须在事务里跑,并且只处理 `credits_granted = 0` 的行(已处理过的不会重复加)。

### Type 规范化(再次强调)

所有写库前调用 `canonicalType(t)`。所有从数据库读出来对外暴露(如 API 响应)的 coin_type 也用规范形式,避免客户端拿到短形式后再充值时变成另一个 key。

代码层面:
- `src/treasury/store.ts` 的每个 INSERT / UPDATE 都用 `canonicalType` 处理 `coin_type` 入参
- `src/treasury/watcher.ts` 接到 `listBalances` 返回的 coin_type 也立刻规范化
- `scripts/treasury-update-rate.ts` 输入的 `--coin` 参数也走 `canonicalType`

只要这一条贯彻,SUI 不会有 `0x2` 与 `0x00…02` 两条 rate 共存的诡异状态。

---

## 7. 分期(本设计 = 哪些进 v1,哪些推迟)

| 功能 | 分期 | 状态 |
|---|---|---|
| `treasury.ts` keypair singleton + 派生 | **v1** | ✅ |
| 在 `schema.sql` 末尾追加 6 张表 | **v1** | ✅ |
| `registration` + `store` + `credits` 模块 | **v1** | ✅ |
| Watcher 轮询 + 入账 | **v1** | ✅ |
| Nonce 防重放 + 原子扣减(无用户签名,内部触发) | **v1** | ✅ |
| 运营 scripts(`treasury-{register-user,list-users,list-balances,update-rate}`+ `verify-treasury-address`) | **v1** | ✅ |
| Rebalancer 集成(门槛 + 预扣 + 失败退款) | **v1** | ✅(feature-flagged off by default) |
| 用户预授权 + 撤销 + 上限 | v2 | v1 用"注册即授权"简化 |
| Cetus 聚合器自动 swap | v2 | 引入 `@cetusprotocol/aggregator-sdk` 或直接 HTTP |
| HTTP API(`/v1/users/register`,`/v1/services/consume`) | v2 | 产品化暴露给客户端 |
| `chargeForServiceWithSignature` + `ALTER TABLE` 加签名列 | v2 | 与 HTTP API 同一波 |
| 用户主动退款的运营脚本 | v2 | |
| 加密 seed 文件(替代 .env 明文助记词) | v3 | 与 agent 角色一并考虑 |
| 自动 sweep 策略 | v3 | 现在人工脚本就够了 |

---

## 8. 测试策略

> **v1 已实现** — 共 51 tests / 5 files,全部通过(`tests/treasury/{keypair,credits,store,registration,watcher}.test.ts`)。
> 没有独立的 `verify.ts` 模块(v1 不验签名);相应的"nonce 重放 / 余额不足 / 成功扣减"路径在 `tests/treasury/store.test.ts` 里随 `attemptChargeTx` / `refundChargeTx` 覆盖。
> rebalancer 集成路径(treasury enabled / 未注册 / 余额不足 / PTB 失败 → refund)目前未单测,列在 `module-and-testing.md` §模块 6 的"主要空缺"里。

| 模块 | 实测形态 | 关注点 |
|---|---|---|
| `keypairs/treasury.ts` | unit (10) ✅ | master 派生固定;per-user 派生可重现;master vs user 不冲突;index<1 拒绝;与 agent 不重合 |
| `treasury/credits.ts` | unit (11) ✅ | floor 数学;rate=null → 0;volume 计算;A/B 边换算 |
| `treasury/store.ts` | unit + in-mem SQLite (18) ✅ | registerUserTx 幂等;recordDepositTx 原子;attemptChargeTx 三态;refundChargeTx 幂等;UPSERT |
| `treasury/registration.ts` | unit + in-mem SQLite (5) ✅ | 索引单调;同 sui_address 重复返回已有行;address 校验 |
| `treasury/watcher.ts` | integration with mock client (7) ✅ | delta>0 入账,delta<0 仅更新 cache,delta=0 noop;无 rate → credits=0 仍写 deposit 行;失败隔离 |
| Rebalancer 集成 | 待补 | treasury disabled → 旧行为不变;未注册 → skip;余额不足 → skip + warn;PTB 失败 → refund |
| 运营 scripts | 手工 | `treasury-register-user.ts <addr>` 产出地址;`treasury-list-balances.ts` 输出与链对得上 |

---

## 9. 运营决定(全部已定)

### 9.1 credit 单位
**1 credit = 0.01 USDC**。运营可在 `treasury_credit_rates` 表通过 `scripts/treasury-update-rate.ts` 改,**不需要改代码、不重启服务**。具体兑换率算法:
- USDC(6 位精度):`amount_atomic / 10_000 = credits` → `rate_num=1, rate_den=10000`(1 USDC = 1e6 atomic = 100 credits)
- SUI(9 位精度):兑换率随价格定,例 1 SUI = 2.5 USDC = 250 credits → `rate_num=25, rate_den=100_000_000`(1 SUI = 1e9 atomic;`atomic * 25 / 1e8 = atomic / 4_000_000`)
- 其他币:运营在 `scripts/treasury-update-rate.ts` 时按 `credits = atomic × num / den` 公式算

### 9.2 默认 rebalance 成本
**机制 v1 上线,数字是 env 占位**。

**公式**:`cost_credits = base + volume_usdc_atomic × fee_rate`,floor 到整数 credits。
- `volume_usdc_atomic` = 本次调仓部署的总值,折算到 USDC raw atomic(6 位精度;1 USDC = 1e6)
  - A 边(sui-usdc 里是 SUI)用 spot 价折算:`A_atomic × spot_USDC_per_A × 10^(decimalsB − decimalsA)`
  - B 边(sui-usdc 里就是 USDC)直接累加
- v1 默认值:`base=10` credits,`fee_rate=0.0000001`(= 0.1% 管理费)
- 占位推导:1 USDC 规模 = 1e6 atomic × 1e-7 = 0.1 credits = 0.001 USDC = 0.1% — 0.1% 即 fee_rate 的直觉
- 直观对照:
  | 调仓规模 | base | variable | 合计 | 折合 USDC |
  |---|---|---|---|---|
  | 100 USDC | 10 | 10 | 20 credits | 0.20 USDC |
  | 1 000 USDC | 10 | 100 | 110 credits | 1.10 USDC |
  | 10 000 USDC | 10 | 1000 | 1010 credits | 10.10 USDC |
- **运营上线前在 env 里调到实际想要的数字** — 0.1% 是占位,可能定 0.05% / 0.2%,看市场
- 公式本身在 `src/treasury/credits.ts → estimateRebalanceCost()`,将来换更复杂的(按 PM 风险 / 按时段 / 阶梯费率)改这一处

### 9.3 未注册 PM 处理
**事件监听 + tickOne 双重把关**,见 §5 完整说明。简要:
- `AgentAdded` 事件到来时,subscriptions.ts 同步查 treasury 状态,**日志记录"未注册"** 给运营一份清单(不阻挡)
- 实际门槛在 rebalancer.tickOne 的 `attemptCharge`:用户未注册 → return,这个 tick 该 PM 完全忽略(不消耗 RPC、不写 rebalances 行)
- 用户后来注册并充值 → 下次 tick 自动开始服务,不需要重启 agent

### 9.4 dust 处理
不需要为 treasury 单独处理。
- 充值侧:任何金额,`floor(atomic × num / den) ≥ 1` 就发 credits,< 1 就发 0(行存在但 credits_granted=0,给运营回填)
- 借贷侧的 dust(已实现的 `LENDING_SAFE_MARGIN_WRAPPER_RAW`)是另一码事 — agent 调仓借贷时**不要全部取出**,留 100 raw 安全余量,防 `EAmountShortfall (1009)`。这已经在 `src/sui/lending/math.ts` 实现,与 treasury 无关
- web 前端的 dust 提示由产品端处理,不在本项目代码里

### 9.5 退款
**v1 不开发**。treasury_service_charges 表已经有 `status='refunded'` 状态,**仅供调仓失败时内部退款用**(见 §5)— 不暴露给用户主动退款。
未来 v2 产品化时考虑:
- 运营脚本 `treasury-refund.ts <sui_address>`:转链上余币回 user 主地址 + 清零 credits + 写 treasury_ops 行
- 不做用户自助 — 涉及 KYC、防欺诈、master keypair 操作权限分级,先简单点

### 9.6 多币种(已定)
**单链 Sui + 多币种**。v1 上线 SUI 和原生 USDC;架构在 Sui 链内 coin-agnostic — 增加任意 Sui Move coin type(含桥接资产)是运营在 `treasury_credit_rates` 表插一行 + 调 `scripts/treasury-update-rate.ts`,不改代码、不改 schema、不重启服务。**不支持跨链** — 不连其他链 RPC、不集成桥。详见 §1 与 §6.1。

---

## 10. What's next (v2)

v1 已实现(见本文开头 Status banner)。下一步:

1. **HTTP API + 签名校验的扣减**
   - 用 `Bun.serve` 暴露 `/v1/users/register` 与 `/v1/services/consume`(或 `/v1/charges`),交给前端 / 第三方 client 直接调用。
   - `ALTER TABLE treasury_service_charges ADD COLUMN signature TEXT, ADD COLUMN message_b64 TEXT, ADD COLUMN verified_at_ms INTEGER` —— schema.sql 直接追加(无版本化迁移)。
   - 新增 `chargeForServiceWithSignature({ suiAddress, credits, messageB64, signature, nonce })`:用 `@mysten/sui/cryptography → verifyPersonalMessageSignature` 验用户的 personal message,然后调既有的 `attemptCharge`。
   - 鉴权按"用户预授权 + 单次扣减"双层模型(本文 §4 service 那段 v2 设想):用户注册时签一条"授权 agent 0xf3f8... 在 X 时间内扣减不超过 Y credits",入库 `treasury_user_authorizations` 表;每次扣减由 agent 签或客户端签,treasury 同时验授权未撤销 + 单次签名。

2. **Cetus 聚合器自动 sweep**
   - 引入 `@cetusprotocol/aggregator-sdk`(或直接 HTTP)。
   - 新增 `src/treasury/operator.ts` 与 `scripts/treasury-sweep.ts`:把每个 deposit_address 上的 SUI / 其他币 swap 成 USDC,统一汇到 master 地址。
   - 写 `treasury_ops` 行(`op_kind='swap'`),包含 amount_in / amount_out / digest 完整审计。

3. **加密 seed 文件**
   - 替代 `.env` 明文助记词。考虑用 age / passphrase-KDF 解密到内存,启动后清掉 env。
   - 与 agent 角色一并改造(两个角色都从同一种 secret resolver 取值,在 `src/sui/keypairs/resolve.ts` 上层加一层)。

4. **用户主动退款脚本**
   - `scripts/treasury-refund.ts <sui_address>`:从对应 deposit_address 转链上余币回 user 主地址 + 清零 credits + 写 `treasury_ops` 行。
   - 需要先解决"防欺诈 + 资金分级权限"问题(v2 时再评估)。

> 这四条在本文 §1 / §7 / §4(service 段) / §9.5 / 附录 A 都已经分别提过 —— 这里只是 explicitly 收口成 v2 路线图。

---

## 附录 A — SuiAgentsTopUp 直接借鉴的代码段

下列文件做参考,但不要 import:

| LiquidityManager 模块 | 借鉴 SuiAgentsTopUp |
|---|---|
| `src/sui/keypairs/treasury.ts` | `/src/keys/hd.ts:16-22`(`deriveKeypair(seed, index)`) |
| `src/treasury/store.ts` | `/src/db/migrations/0001_init.sql:1-77` 五张表的形状(SuiAgentsTopUp 的旧 migrations 风格,仅看 schema 结构,不要照搬其 migration 框架) |
| `src/treasury/registration.ts` | `/src/services/registration.ts:45-71`(单 tx 索引分配) |
| `src/treasury/watcher.ts` | `/src/services/watcher.ts:30-174`(`tick()` 主循环) |
| `src/treasury/verify.ts` | `/src/services/verify.ts:71-137`(nonce 防重 + 签名校验) |
| `scripts/treasury-sweep.ts`(v2) | `/src/services/treasury.ts:67-123`(转账)+ `:133-214`(Cetus 聚合器换币) |

---

## 附录 B — 与已锁定的密钥架构契合

参考 CLAUDE.md §"Multi-role keys"。本设计完全遵守那里写的约束:
- 用 `src/sui/keypairs/resolve.ts` 已有的纯解析器,treasury master keypair 走和 agent 一样的代码路径
- `cfg.keys.treasury: KeyRoleEnvConfig` — schema 已经在 `KeyConfig` 接口里预留
- treasury singleton 私有 cache,不与 agent 共享
- 错误消息含 `role: "treasury"`
- 加 treasury 是**一个文件 + config 一处加字段**,非重构

---

## 附录 C — 安全审计 checklist(实施前自检)

- [ ] treasury 模块绝不 import agent 模块,反之亦然(代码评审硬卡)
- [ ] watcher 写库全部走事务(`db.transaction(() => ...)()`)
- [ ] `chargeForService` 必须先 INSERT nonce 再做签名验证 — 拒绝攻击者用"撞 nonce 让前期失败"绕过审计
- [ ] master keypair 仅在 sweep / swap 时取出,日常不缓存到长生命周期对象上
- [ ] 用户 deposit_address 派生函数加单元测试,验证 (mnemonic, base_path, index) 三元组是确定性的
- [ ] 充值 watcher 检测到的 delta 必须用 bigint 比较 — 不能用 Number,SUI 余额随便就 > 2^53
- [ ] credit_rates 没设的 coin_type → watcher 入账时记 deposits 行但 credits_granted=0,**不静默丢弃**
- [ ] scripts/ 下任何运营脚本都不打印助记词、私钥、master seed
- [ ] 加 treasury 表时直接追加到 `src/db/schema.sql` 末尾,所有 CREATE 都用 `IF NOT EXISTS`(本项目不做版本化迁移,见 `db/client.ts` 注释)

---

## Treasury 与 Seal 加密研报的关系

**Treasury 不参与 Seal 收件人身份**。早期设计稿讨论过"用 deposit_address 当 Seal recipient"(模型 A)或"用 user 主钱包"(模型 B),都不是最优解。落地方案是模型 C:

| 系统 | 角色 | 派生路径 / 持有人 |
|---|---|---|
| **Treasury per-user deposit** | 用户充值收款 + 退款收回 | `m/44'/784'/0'/0'/N'`,treasury 持私钥 |
| **Seal 授权读者**(v2) | 研报 / 加密数据的接收 + 解密 | **AGENT_ADDRESS**(`m/44'/784'/1'/0'/0'`),agent 持私钥 |

两套地址完全独立,只通过 `treasury_users.sui_address` 这一行把"哪个用户付了哪笔订阅 / 哪笔 rebalance 费"对账起来。

### 与 credit 扣减的协同

如果运营想"让用户花 credit 订阅研报"(而不是再次链上付费):

```
1. user 在前端点"订阅研报 X"
2. 前端调 agent HTTP API (v2),带上 user.sui_address + reportId
3. agent 端:
   a. attemptCharge(user, cost=订阅价的 credit 数, memo="seal-sub:reportId")
   b. 余额够 → operator 自己签个 PTB 调 SEAL_PACKAGE::subscribe(),把 Subscription mint 到 AGENT_ADDRESS
   c. 余额不够 → 拒绝
4. 后续 agent 用自己的 SessionKey 自动拉取该研报内容,投递给 user
```

这条路径**完全复用**现有 `attemptCharge` / `refundCharge` API,Seal 那边只需要新的 `src/seal/policy.ts` 来构造 Move 调用 PTB。详细落地见 `docs/seal-integration.md`。

### 派生命名空间约定(forward compat)

为防止未来"deposit + Seal 角色拆分"时改 base path 带来历史地址迁移地狱,**约定**:

```
m/44'/784'/0'/0'/N'   ← deposit + 退款收款,treasury 派生(当前唯一在用)
m/44'/784'/0'/1'/N'   ← 预留:如果未来选模型 B 让用户控 Seal 私钥,本分支当独立 user identity
m/44'/784'/0'/2'/N'   ← 预留:专门的 swap / rebalance 操作子地址
m/44'/784'/0'/3'/N'+  ← 预留扩展
```

**当前代码只用 `0'` 分支**;其他分支不要先实现。任何新功能用新分支,不污染已分配的 N'。

容量上 `0'` 分支可装 2,147,483,647 用户,日常远不会触底。`schema.sql` 的 CHECK 约束已经把上限钉死(`derivation_index < 2^31`)防数据库被人为污染。
