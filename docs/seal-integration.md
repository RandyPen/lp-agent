# Seal 加密研报数据共享 — 集成设计

> Status (2026-05-25): **设计就位,代码 stub 留给 v2**。
> 关联:CLAUDE.md §"Agent Identity",`docs/treasury-role-design.md`。

## 1. 模型选择(为什么 Agent 地址做 Seal reader)

Seal 是 Mysten Labs 在 Sui 上的去中心化机密管理服务,核心机制是 IBE (Identity-Based Encryption) + t-of-n threshold key servers + 链上 Move 合约的 `seal_approve*` 函数做授权门。

把它装到本项目时,**收件人身份**有三种候选,只有第三种是对的:

| 模型 | Seal 收件人 | 持有解密私钥的 | 评价 |
|---|---|---|---|
| A. 充值地址当 Seal recipient | `user_N_deposit_address` | **treasury** | ❌ operator 能解所有用户研报,信任面太宽 |
| B. 用户主钱包当 Seal recipient | `user.sui_address`(注册时填的) | **user**(完全 self-custody) | ❌ user 每次读都要自己签名,agent 没法自动化 |
| **C. Agent 地址当 Seal reader,Move 合约做支付门** | `AGENT_ADDRESS`(`0xf3f8feeba6...`) | **agent**(本项目持有) | ✅ 用户付费后由合约把 agent 加入 allowlist;agent 用自己的私钥签 SessionKey 自动拉取,不需要 user 每次签 |

模型 C 是 Mysten 官方"Policy-governed AI"用例(主页明确列了:*"Encrypt sensitive data and control what AI agents can access, when, and under which conditions"*),整套基础设施完全就绪。

## 2. 端到端流程

```
            ┌─────────────────────────────────────────────────────────┐
            │  研报作者 (off-chain)                                    │
            │  ↓ 用 Seal SDK + agent_address 当 identity 加密          │
            │  Ciphertext → 上传到 Walrus / S3 / IPFS                  │
            └────────────────────────────────────────┬────────────────┘
                                                     │
   ┌─────────────────────────────────────────────────┼─────────────┐
   │  Sui 链(operator 部署的 Move 合约)              │             │
   │                                                 │             │
   │  ① user 调 `pay_for_report(...)` 转账 SUI/USDC  │             │
   │  ② Move 合约 mint 一个 ReportAccessCap          │             │
   │     transfer 到 AGENT_ADDRESS                   │             │
   │                                                 │             │
   │  seal_approve_<scheme>(tx, identity, ...):       │             │
   │     - 检查 caller (tx.sender) 是 AGENT 地址     │             │
   │     - 检查 caller 持有未过期的 ReportAccessCap   │             │
   │     - 通过则不 abort                             │             │
   └─────────────────────────────────────────────────┼─────────────┘
                                                     │
            ┌────────────────────────────────────────▼────────────────┐
            │  Agent runtime (本项目)                                  │
            │                                                          │
            │  3. 用 AGENT keypair 签 SessionKey(packageId,           │
            │     ttlMin)                                              │
            │  4. 构造一个 dry-run PTB 调 seal_approve_<scheme>        │
            │  5. Key Servers 执行 devInspectTransactionBlock 检测     │
            │     PTB 不 abort → 返回 IBE 密钥分片                     │
            │  6. Agent 本地组装 t-of-n 分片 → 解密 ciphertext         │
            │  7. 投喂给策略层(可作为新的 PriceFeed / Strategy 输入) │
            └──────────────────────────────────────────────────────────┘
```

**关键不变量**:
- AGENT 拿到密钥分片**只能本地组装解密**;Key Servers 不可见明文。
- 一旦 ReportAccessCap 链上 transfer 或销毁,agent 下次 dry-run 会被 `seal_approve` 拒,**自动失去访问**。
- AGENT_ADDRESS = `m/44'/784'/1'/0'/0'` 派生,固定地址,既是 PM 白名单地址,也是 Seal 授权地址。两个用途共用 keypair 是有意的:运营只管理一个 agent 身份。

## 3. Move 合约形态(两种典型 pattern)

### Pattern A — Subscription(订阅,推荐 v2 默认)

```move
public struct Subscription has key, store {
    id: UID,
    owner: address,        // = agent address
    package_id: ID,        // Seal package this subscription applies to
    expires_at_ms: u64,
}

// 用户付费 mint subscription 给 agent_address
public entry fun subscribe(
    payment: Coin<USDC>,
    duration_ms: u64,
    agent_address: address,
    ctx: &mut TxContext,
): Subscription { ... }

// Seal 校验入口
public fun seal_approve_subscription(
    _id: vector<u8>,                         // Seal identity (任意身份串)
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
    members: vector<address>,
}

public entry fun add_to_allowlist(
    list: &mut Allowlist,
    member: address,         // = agent address,由 user 付费时传入
    payment: Coin<USDC>,
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

两种 pattern 都让 **tx.sender = agent_address** 是核心检查 — Seal Key Server 在 dry-run 时 sender 来自 SessionKey 的签名地址,所以只有持有 agent 私钥的 agent 进程能通过校验。

## 4. 代码集成 seam(v2 落地时的形状)

当前模板**不 ship** Seal 代码,但留好了接入点。v2 落地建议的文件布局:

```
src/seal/
├── types.ts              # SealConfig, ReportEnvelope, SessionInfo 接口
├── client.ts             # 封装 @mysten/seal SDK 调用,SessionKey 生命周期管理
├── reader.ts             # fetchReport(reportId) → 解密后的明文 ArrayBuffer
└── policy.ts             # buildApproveTx(reportId) — 构造调 seal_approve_* 的 PTB

src/services/sealService.ts  # 后台任务:刷新 SessionKey、缓存解密结果

src/strategies/sealAugmented<X>.ts  # 把 Seal 解密的特征喂给现有策略,
                                    # 仅在 SEAL_ENABLED=true 时通过 registry 暴露
```

### SDK 依赖(v2 加)

```json
{
  "dependencies": {
    "@mysten/seal": "^...",   // 主网 SDK,届时锁定版本
    "@mysten/walrus": "^..."  // 如果研报存 Walrus 而不是自己 host
  }
}
```

### 接入点(env)

`.env.example` 已经预留(注释状态):
```
SEAL_ENABLED=false
SEAL_PACKAGE_ID=                  # Move package id
SEAL_KEY_SERVER_URLS=             # comma-separated
SEAL_THRESHOLD=2                  # t-of-n
SEAL_SESSION_TTL_MIN=30
```

`src/config.ts` 在 `SealAppConfig` 里聚合,启动时校验(SEAL_ENABLED=true 时 SEAL_PACKAGE_ID / SEAL_KEY_SERVER_URLS 不能空)。和 LENDING / TREASURY 是同一套 pattern。

### SessionKey 生命周期

```ts
// src/seal/client.ts (v2 草图)
import { SessionKey } from "@mysten/seal";
import { getAgentKeypair } from "../sui/keypairs/agent.ts";

let cached: SessionKey | null = null;
let cachedExpiresAt = 0;

export async function getSessionKey(): Promise<SessionKey> {
  if (cached && Date.now() < cachedExpiresAt) return cached;
  const kp = getAgentKeypair();
  cached = await SessionKey.create({
    address: kp.toSuiAddress(),
    packageId: cfg.seal.packageId,
    ttlMin: cfg.seal.sessionTtlMin,
    signer: kp,           // ← agent 私钥用自己签 personal message 激活
    suiClient: getSuiClient(),
  });
  cachedExpiresAt = Date.now() + cfg.seal.sessionTtlMin * 60_000 - 30_000; // refresh 30s 前
  return cached;
}
```

Agent 私钥**只**用于:
1. 签 CDPM PTB(rebalance / lending 操作)
2. 签 Seal SessionKey personal message(本节)

两条用途从 keypair 角度完全等价,不需要分隔。

## 5. 用户视角的支付 + 授权

```
1. 用户在前端选研报 X、付 5 USDC
2. 前端构造 PTB 调 <SEAL_PACKAGE>::subscribe<USDC>(
       coin, duration_ms = 30 天,
       agent_address = AGENT_ADDRESS_FROM_OPERATOR  // 这一项从 operator 的 .env 公开
   )
3. PTB 在用户钱包(Sui Wallet / Slush)签名 + 提交
4. Subscription 对象自动 transfer 到 AGENT_ADDRESS
5. 前端轮询 agent 的 HTTP API(v2),agent 检测到 Subscription 后即开始投递解密后的研报内容
   (通过 Treasury 已有的 credit ledger 关联到该用户;或直接以"该用户绑定的 PM"为 scope 投递)
```

Treasury 现有的 deposit address 在这个流程里**不参与 Seal**:
- 充值地址只管"用户给运营充值 SUI/USDC,换 credit 用于 rebalance 手续费"
- Seal 订阅可以直接付费给 Move 合约,也可以由 agent 后台从用户 credit 里扣减后调用合约 mint Subscription
- 两套流水互相独立,但都通过 `treasury_users.sui_address` 串起来定位用户

## 6. 信任模型对比(明确说清楚)

| 角度 | C 模型(本设计) | 备选 |
|---|---|---|
| 谁能解密研报 | 持有 agent 私钥的 operator | A 模型同样,但更多用户的 deposit keypair 一起暴露 |
| 用户撤销访问 | 不能 — 一旦付费,subscription 期内 agent 都能读;过期自动失效 | 模型 B 用户握私钥,随时撤销但每次读需 user 签名 |
| 用户离线时 agent 还能工作 | 可以(SessionKey TTL 内自动续) | 模型 B 不行 |
| 多用户读同一研报 | 直接看 Move 合约怎么写(Allowlist 加多个地址) | 同 |
| Operator 看不到明文 | **看得到**(IBE 主密钥分片在 KS,但解密发生在 agent 本地) | 同模型 A |

**结论:模型 C 适合"用户付费让 agent 自动化操作"的场景**。如果产品方向是"用户自己读研报,agent 不读",那应该选模型 B,但这与本项目的"agent 做策略决策"目的不符。

## 7. 安全 checklist(v2 落地时检查)

- [ ] `SEAL_PACKAGE_ID` 必须经过 `EXPECTED_*` 风格的格式校验(64-hex),不允许空
- [ ] Key Server URL 列表必须 HTTPS 且数量 ≥ `SEAL_THRESHOLD`
- [ ] SessionKey 持久化吗?**不应该**。每次进程重启重新签;不要写盘
- [ ] 解密后的明文不要落 SQLite;只在内存 buffer 里,用完即弃
- [ ] Move 合约的 `seal_approve_*` 写错会让 Key Servers 误放密钥 → 任何合约修改要走代码评审 + 测试网验证
- [ ] Agent keypair 必须用 `EXPECTED_AGENT_ADDRESS` + TOFU 文件双重保护;Seal 授权完全建立在 agent 地址不被替换的前提上

## 8. 与现有架构的关系

| 现有模块 | 与 Seal 的关系 |
|---|---|
| `src/sui/keypairs/agent.ts` | **直接复用** — 同一个 keypair 签 PTB + 签 SessionKey |
| `src/sui/keypairs/treasury.ts` | 不参与 Seal,继续做用户充值地址派生 |
| `src/treasury/charges.ts` | 可扩展:研报订阅时从 `credits` 余额扣一笔记到 `treasury_service_charges`(memo="seal-subscription") |
| `src/strategies/*` | v2 新增 `sealAugmented*` 策略,把解密后的研报特征作为 `StrategyInput.history` 的补充 |
| `src/services/*` | v2 新增 `sealService.ts` — SessionKey 续期 + 后台解密 |
| `.env`、`docs/`、`CLAUDE.md` | 都按上文说明留 placeholder + 文档,不引入运行时依赖 |

## 9. 不在 v1 做的事

- ❌ 不引入 `@mysten/seal` 依赖(避免无谓的 bundle 体积)
- ❌ 不写 Seal Move 合约(那是单独的 repo,本项目只消费)
- ❌ 不在 schema 里加 `seal_subscriptions` 表(等需求确定再加,加表是单文件追加,无迁移负担)
- ❌ 不在 README 把 Seal 列入"模板提供的能力"(避免误导,这是 fork 后才开通的扩展)

## 10. 参考

- Seal 主页 / "Policy-governed AI" use case
- Seal SDK: `@mysten/seal`(npm)
- Subscription pattern 示例:Mysten 官方 examples repo
- IBE + threshold scheme:见 Seal 白皮书 §"Cryptographic Design"
- Move `seal_approve_*` 函数签名约定:见 Seal 集成指南
