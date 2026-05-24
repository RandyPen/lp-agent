# Seal 加密研报数据共享 — 集成设计

> Status (2026-05-25): **设计就位,代码 stub 留给 v2**。
> 关联:`docs/treasury-role-design.md`,`src/sui/keypairs/treasury.ts`。

## 1. 模型:per-user 阅读身份(treasury deposit 地址)

Seal 是 Mysten Labs 在 Sui 上的去中心化机密管理服务:IBE (Identity-Based Encryption) + t-of-n threshold key servers + 链上 Move `seal_approve*` 函数。

授权的"收件人身份"该选哪个地址?候选三个,逐一看:

| 候选 | 收件人 = ? | 评价 |
|---|---|---|
| agent 主地址(全局共享) | `AGENT_ADDRESS` | ❌ 全用户共享一份订阅,与"每个用户为自己付费提升交易表现"的产品模型矛盾 |
| 用户主钱包(完全 self-custody) | `user.sui_address` | ❌ 每次解密要 user 在线签名,agent 无法自动化 |
| **per-user treasury deposit 地址** | `user_N_deposit_address` (`m/44'/784'/0'/0'/N'`) | ✅ user_A 的访问对 user_B 不可见,treasury runtime 替 user 自动签 SessionKey |

**选项三是落地方案**:同一个 `user_N_deposit_address` 兼三种用途 — 收充值 + 收退款 + Seal 阅读身份。运营持有 treasury mnemonic,所以能为任何注册用户 derive 出 keypair 替他自动化操作;但 Move 合约层面的访问控制对每个用户**独立隔离**。

Mysten 官方"Policy-governed AI"用例(主页明确列了 *"Encrypt sensitive data and control what AI agents can access, when, and under which conditions"*)的精神在这里就是:**user 写一条策略(Move 合约里的 `seal_approve_*`),指定哪个地址被授权 → agent runtime 拿那个地址的私钥执行**。本项目下"那个地址"就是 user_N 的 deposit 地址。

## 2. 端到端流程

```
            ┌──────────────────────────────────────────────────────────┐
            │  研报作者 / 数据源(off-chain)                            │
            │                                                          │
            │  用 Seal SDK 加密(identity 字段 = reportId)             │
            │  Ciphertext 上传到 Walrus / S3 / IPFS / 任何存储         │
            └────────────────────────────────────────┬─────────────────┘
                                                     │
   ┌─────────────────────────────────────────────────┼─────────────────┐
   │  Sui 链(运营部署的 Move 合约 SEAL_PACKAGE)     │                 │
   │                                                 │                 │
   │  ① user 主钱包付费调:                          │                 │
   │      SEAL_PACKAGE::subscribe<USDC>(             │                 │
   │          payment,                               │                 │
   │          recipient = user_N_deposit_address,    │ ← 关键!         │
   │          duration_ms,                           │                 │
   │      );                                         │                 │
   │  ② 合约 mint Subscription { owner=recipient }    │                 │
   │     transfer 给 user_N_deposit_address          │                 │
   │                                                 │                 │
   │  seal_approve_subscription(id, sub, clock, ctx):│                 │
   │     - assert tx.sender == sub.owner             │                 │
   │     - assert !expired                           │                 │
   └─────────────────────────────────────────────────┼─────────────────┘
                                                     │
            ┌────────────────────────────────────────▼─────────────────┐
            │  Treasury runtime (本项目)                                │
            │                                                           │
            │  3. user = findUserBySuiAddress(user.sui_address)         │
            │  4. kp   = getUserDepositKeypair(user.derivationIndex)    │
            │  5. session = SessionKey.create({                         │
            │       address: user.depositAddress,                       │
            │       packageId: cfg.seal.packageId,                      │
            │       ttlMin:   cfg.seal.sessionTtlMin,                   │
            │       signer:   kp,    ← user_N 的私钥(treasury 持有)   │
            │       suiClient: getSuiClient(),                          │
            │     });                                                    │
            │  6. dry-run PTB 调 seal_approve_subscription              │
            │  7. Key Servers 看 sender = user_N_deposit_address ∈ owner │
            │     → 返回 t-of-n IBE 分片                                │
            │  8. runtime 本地组装解密 → 喂给该 user 的 PM 策略         │
            └───────────────────────────────────────────────────────────┘
```

**核心不变量**:
- **每个用户的 Subscription / Allowlist entry 用 user_N_deposit_address 当 owner / member**,不是 agent 地址,不是 user.sui_address。
- SessionKey 由对应 user 的 deposit keypair 签 — treasury 模块的 `getUserDepositKeypair(idx)` 提供。**Agent keypair 完全不参与** Seal。
- user_A 的 Subscription 对象在 user_B 的 deposit 地址下不存在 → user_B 调 `seal_approve_*` 会 `assert ENotOwner` abort → Key Servers 拒发分片。**隔离来自合约**,不是来自客户端逻辑。

## 3. Move 合约形态(两种典型 pattern)

### Pattern A — Subscription(订阅,推荐 v2 默认)

```move
public struct Subscription has key, store {
    id: UID,
    owner: address,         // = user_N_deposit_address
    package_id: ID,
    expires_at_ms: u64,
}

public entry fun subscribe<C>(
    payment: Coin<C>,
    recipient: address,     // 前端传入 user_N_deposit_address
    duration_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // ... 转账到运营 treasury,创建 Subscription
    let sub = Subscription {
        id: object::new(ctx),
        owner: recipient,
        package_id: ... ,
        expires_at_ms: clock::timestamp_ms(clock) + duration_ms,
    };
    transfer::transfer(sub, recipient);
}

public fun seal_approve_subscription(
    _id: vector<u8>,
    sub: &Subscription,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(tx_context::sender(ctx) == sub.owner, ENotOwner);
    assert!(sub.expires_at_ms > clock::timestamp_ms(clock), EExpired);
}
```

### Pattern B — Allowlist(白名单,更直白)

```move
public struct Allowlist has key {
    id: UID,
    members: vector<address>,    // 所有授权读者
}

public entry fun add_to_allowlist<C>(
    list: &mut Allowlist,
    payment: Coin<C>,
    member: address,             // = user_N_deposit_address
    ctx: &mut TxContext,
) { ... }

public fun seal_approve_allowlist(
    _id: vector<u8>,
    list: &Allowlist,
    ctx: &TxContext,
) {
    assert!(vec::contains(&list.members, &tx_context::sender(ctx)), ENotAllowed);
}
```

两种 pattern 都让 **tx.sender = user_N_deposit_address** 是核心检查 — Seal Key Server 在 dry-run 时 sender 来自 SessionKey 的签名地址,只有持有 user_N 私钥(即 treasury runtime)的进程才能通过校验。

## 4. 代码集成 seam(v2 落地时的形状)

当前模板**不 ship** Seal 代码,但留好了接入点。v2 落地建议:

```
src/seal/
├── types.ts              # SealConfig, SubscriptionRef, SessionInfo 接口
├── client.ts             # 封装 @mysten/seal SDK 调用
├── reader.ts             # fetchReportFor(userSuiAddress, reportId) → 解密 buffer
└── policy.ts             # buildApproveTx(userDepositAddress, reportId) → PTB

src/services/sealService.ts  # 后台:为各 user 维护 SessionKey 缓存(LRU + TTL)

src/strategies/sealAugmented<X>.ts  # 把解密的特征喂给策略
```

### SessionKey 生命周期(per-user 缓存)

```ts
// src/seal/client.ts (v2 草图)
import { SessionKey } from "@mysten/seal";
import { getUserDepositKeypair } from "../sui/keypairs/treasury.ts";
import { findUserBySuiAddress } from "../treasury/store.ts";

interface CachedSession {
  key: SessionKey;
  expiresAt: number;
}

// LRU by user sui_address(注册的钱包地址)
const cache = new Map<string, CachedSession>();

export async function getSessionKeyFor(userSuiAddress: string): Promise<SessionKey> {
  const cached = cache.get(userSuiAddress);
  if (cached && Date.now() < cached.expiresAt) return cached.key;

  const user = findUserBySuiAddress(userSuiAddress);
  if (!user) throw new Error(`user not registered in treasury: ${userSuiAddress}`);

  const kp = getUserDepositKeypair(user.derivationIndex);
  const key = await SessionKey.create({
    address: user.depositAddress,
    packageId: cfg.seal.packageId,
    ttlMin: cfg.seal.sessionTtlMin,
    signer: kp,                          // ← user_N 的私钥
    suiClient: getSuiClient(),
  });
  cache.set(userSuiAddress, {
    key,
    expiresAt: Date.now() + cfg.seal.sessionTtlMin * 60_000 - 30_000,
  });
  return key;
}
```

**注意**:
- `signer` 是 **per-user** 的 keypair,不是 agent keypair
- 缓存 key 用 `user.sui_address`(从产品视角更稳定),value 内部存 `depositAddress` + `key`
- 多用户场景下,cache size 上限要设(避免无限增长),LRU 淘汰最久未用

### 用户调用入口(给 PM 策略层调)

```ts
// src/seal/reader.ts (v2 草图)
export async function fetchReportFor(
  userSuiAddress: string,
  reportId: string,
): Promise<ArrayBuffer> {
  const session = await getSessionKeyFor(userSuiAddress);
  // 1. 拉密文(URL 由 reportId 路由)
  const ciphertext = await fetchCiphertext(reportId);
  // 2. 构造 dry-run PTB 调 seal_approve_subscription
  const tx = buildApproveTx(session.address, reportId);
  // 3. 提交给 Key Servers 拉 IBE 分片(@mysten/seal 内部处理 t-of-n 组合)
  return await session.decrypt(ciphertext, tx);
}
```

策略层在需要研报数据时调 `fetchReportFor(pm.owner, reportId)` — `pm.owner` 就是注册到 treasury 的 user.sui_address。

### 接入点(env)

`.env.example` 已经预留(注释状态):
```bash
SEAL_ENABLED=false
SEAL_PACKAGE_ID=                  # Move package id
SEAL_KEY_SERVER_URLS=             # comma-separated
SEAL_THRESHOLD=2                  # t-of-n
SEAL_SESSION_TTL_MIN=30
```

`src/config.ts` 在 v2 加 `SealAppConfig`,启动时校验(`SEAL_ENABLED=true` 时 `SEAL_PACKAGE_ID` / `SEAL_KEY_SERVER_URLS` 不能空)。和 LENDING / TREASURY 走同一套 aggregator pattern。

## 5. 用户视角的支付 + 授权

```
┌──────────────────────────────────────────────────────────────────────┐
│ user 浏览器 / 前端                                                    │
│                                                                       │
│ 1. user 主钱包(Sui Wallet 等)连接                                   │
│ 2. 前端 GET /api/user/{user.sui_address}                              │
│    返回 { depositAddress, credits, ... }                              │
│ 3. user 选研报 X、付 5 USDC                                           │
│ 4. 前端构造 PTB:                                                      │
│       SEAL_PACKAGE::subscribe<USDC>(                                  │
│         payment = 5_USDC_coin,                                        │
│         recipient = depositAddress,   ← 用户的 deposit,不是钱包      │
│         duration_ms = 30 * 24 * 3600 * 1000,                          │
│         clock,                                                         │
│       )                                                                │
│ 5. user 钱包签 + 提交                                                 │
│ 6. Subscription 对象 mint 并 transfer 到 depositAddress               │
│ 7. 前端轮询(或 WebSocket)/api/user/{addr}/reports                    │
│    runtime 解密后通过该 API 返回明文                                  │
└──────────────────────────────────────────────────────────────────────┘
```

**关键设计点**:user 自己付钱、自己签 PTB,但 PTB 的 `recipient` 参数填的是 user 在 treasury 注册时拿到的 deposit 地址。这一步前端必须先调 `/api/user/{addr}` 拿到映射,不能让 user 手填。

## 6. 信任模型(明确说清楚)

| 角度 | 答案 |
|---|---|
| 谁能解密 user_N 的研报 | 持有 treasury mnemonic 的进程(本项目 runtime) |
| user_A 能不能解 user_B 的研报 | **不能**(Move 合约 `seal_approve_*` 检查 sender = sub.owner = user_N_deposit_address,user_A 不持有 user_N 私钥) |
| user 能不能撤销访问 | 当前订阅期内不能;过期自动失效。Pattern B(Allowlist)可加 `remove_from_allowlist` 入口让 user 主动撤销 |
| user 离线时 runtime 还能拉 | 可以(SessionKey TTL 内自动续) |
| operator 是否能技术上读全部明文 | **能**(treasury mnemonic 派生任何 user 的私钥) — 这是 *operator-hosted* 模型的固有信任,不可能用密码学消除 |
| 怎么审计 operator 的访问 | 每次解密在 `treasury_ops` 留行:`op_kind='seal_read'`、`from_address=user_N_deposit_address`、memo 带 reportId + 时间戳 |

**结论**:per-user 模型在**用户之间**提供合约级隔离,但**用户对 operator** 的信任仍然必要(operator 持私钥)。要消除后者需要 user 自己控制 deposit 私钥,但那破坏了 agent 自动化的前提 — 鱼与熊掌不可兼得。

## 7. 安全 checklist(v2 落地时检查)

- [ ] `SEAL_PACKAGE_ID` 必须 64-hex 格式校验,不允许空
- [ ] Key Server URL 列表必须 HTTPS 且数量 ≥ `SEAL_THRESHOLD`
- [ ] SessionKey 不持久化 — 进程重启重新签;LRU cache 全在内存
- [ ] 解密后的明文不要落 SQLite;只在内存 buffer 里,投递给策略后立即释放
- [ ] Move 合约的 `seal_approve_*` 写错会让 Key Servers 误放密钥 → 任何合约修改要走代码评审 + 测试网验证
- [ ] `treasury_ops` 行的 PII 控制:memo 字段可以有 reportId,但不要塞用户身份相关字段
- [ ] 前端必须让 user 看见 PTB 里的 `recipient` 字段并确认 — 防止钓鱼网站填错地址骗走订阅

## 8. 与现有架构的关系

| 现有模块 | 与 Seal 的关系 |
|---|---|
| `src/sui/keypairs/agent.ts` | 不参与 Seal |
| `src/sui/keypairs/treasury.ts` | **核心** — `getUserDepositKeypair(idx)` 是 Seal SessionKey signer |
| `src/treasury/store.ts` | `findUserBySuiAddress(addr)` 把 user 主钱包映射到 derivation_index → 解 SessionKey 入口 |
| `src/treasury/charges.ts` | 可扩展:内部托管订阅时从 credits 扣一笔记入 `treasury_service_charges`(memo="seal-sub:reportId") |
| `src/strategies/*` | v2 新增 `sealAugmented*` 策略,把研报特征塞进 `StrategyInput.history` |
| `src/services/*` | v2 新增 `sealService.ts` — per-user SessionKey LRU + 后台解密 |
| `.env`、`docs/`、`CLAUDE.md` | 当前只放 placeholder + 文档,不引入运行时依赖 |

## 9. v1 不做的事

- ❌ 不引入 `@mysten/seal` 依赖
- ❌ 不写 Move 合约(独立 repo,本项目只消费)
- ❌ 不在 schema 加 `seal_subscriptions` 缓存表(Subscription 对象状态可以每次 dry-run 时直接读链,不需要本地副本)
- ❌ 不在 README 把 Seal 列入"模板提供的能力"(避免误导,这是 fork 后才开通的扩展)

## 10. 参考

- Seal 主页 / "Policy-governed AI" use case
- Seal SDK: `@mysten/seal`(npm)
- Subscription / Allowlist pattern 示例:Mysten 官方 examples repo
- IBE + threshold scheme:见 Seal 白皮书 §"Cryptographic Design"
- Move `seal_approve_*` 函数签名约定:见 Seal 集成指南
