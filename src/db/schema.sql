-- LiquidityManager 全部 SQLite schema。
--
-- 设计选择:不做版本化迁移,每次 `openDb()` 启动直接执行整份文件。所有
-- CREATE 都带 `IF NOT EXISTS`,重跑是 no-op。
--
-- 加新表 / 加索引:直接在本文件末尾追加 — 不需要新增 migration 文件,
-- 不需要更新版本表。Dev DB 重启即生效。
--
-- 不支持 schema 变更里需要数据搬迁的场景(ALTER TABLE 改类型、删列等)。
-- 项目阶段尚未上线、没有产品数据,出现这种需求时直接 `rm ./data/app.db`
-- 重建即可。等真上 prod 再引入正式迁移工具。

------------------------------------------------------------------------------
-- 订阅 / 事件追踪(原 0001_init)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  pm_id            TEXT PRIMARY KEY,
  owner            TEXT NOT NULL,
  pool_id          TEXT NOT NULL,
  coin_type_a      TEXT NOT NULL,
  coin_type_b      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('active','revoked','closed')),
  added_at_ms      INTEGER NOT NULL,
  removed_at_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS subscriptions_pool   ON subscriptions(pool_id);

CREATE TABLE IF NOT EXISTS event_cursor (
  stream     TEXT PRIMARY KEY,
  tx_digest  TEXT,
  event_seq  TEXT,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rebalances (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pm_id            TEXT NOT NULL,
  planned_at_ms    INTEGER NOT NULL,
  submitted_at_ms  INTEGER,
  digest           TEXT,
  plan_json        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('planned','submitted','succeeded','failed')),
  error            TEXT
);
CREATE INDEX IF NOT EXISTS rebalances_pm     ON rebalances(pm_id, planned_at_ms DESC);
CREATE INDEX IF NOT EXISTS rebalances_status ON rebalances(status);

CREATE TABLE IF NOT EXISTS price_observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id     TEXT NOT NULL,
  source      TEXT NOT NULL,
  price       TEXT NOT NULL,
  observed_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS price_observations_lookup ON price_observations(pool_id, observed_ms DESC);

------------------------------------------------------------------------------
-- 借贷(原 0002_lending)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lending_positions (
  pm_id                TEXT NOT NULL,
  protocol             TEXT NOT NULL CHECK(protocol IN ('scallop','kai')),
  coin_type            TEXT NOT NULL,
  yt_type              TEXT NOT NULL DEFAULT '',
  underlying_principal TEXT NOT NULL,
  market_coin_amount   TEXT NOT NULL,
  last_event_digest    TEXT,
  updated_at_ms        INTEGER NOT NULL,
  PRIMARY KEY (pm_id, protocol, coin_type)
);
CREATE INDEX IF NOT EXISTS lending_positions_pm ON lending_positions(pm_id);

CREATE TABLE IF NOT EXISTS lending_actions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pm_id            TEXT NOT NULL,
  protocol         TEXT NOT NULL CHECK(protocol IN ('scallop','kai')),
  action           TEXT NOT NULL CHECK(action IN ('supply','redeem')),
  coin_type        TEXT NOT NULL,
  amount           TEXT NOT NULL,
  digest           TEXT,
  status           TEXT NOT NULL CHECK(status IN ('planned','succeeded','failed')),
  error            TEXT,
  reason           TEXT,
  planned_at_ms    INTEGER NOT NULL,
  submitted_at_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS lending_actions_pm ON lending_actions(pm_id, planned_at_ms DESC);

------------------------------------------------------------------------------
-- 策略持仓状态(原 0003_position_state)
--
-- 当前只有 fill_boundary_bin_id,bid-ask / only-bid / only-sell 类策略
-- (v2 上线)使用;v0 策略不写此表。
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS position_state (
  pm_id                TEXT PRIMARY KEY,
  fill_boundary_bin_id INTEGER,
  strategy_name        TEXT,
  parameters_json      TEXT,
  updated_at_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS position_state_strategy ON position_state(strategy_name);

------------------------------------------------------------------------------
-- Treasury(用户充值 + 调仓扣减)— 见 docs/treasury-role-design.md
------------------------------------------------------------------------------

-- 充值用户:一个 sui_address(用户主钱包)→ 唯一 derivation_index →
-- 唯一 deposit_address。derivation_index ≥ 1(0 留给 treasury master)。
CREATE TABLE IF NOT EXISTS treasury_users (
  sui_address       TEXT PRIMARY KEY,
  derivation_index  INTEGER NOT NULL UNIQUE CHECK(derivation_index >= 1),
  deposit_address   TEXT NOT NULL UNIQUE,
  credits           INTEGER NOT NULL DEFAULT 0 CHECK(credits >= 0),
  created_at_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS treasury_users_deposit_address
  ON treasury_users(deposit_address);

-- 每币种入账率。运营在 admin script 里更新。
-- credits = floor(amount_atomic × rate_num / rate_den)
CREATE TABLE IF NOT EXISTS treasury_credit_rates (
  coin_type      TEXT PRIMARY KEY,
  rate_num       TEXT NOT NULL,         -- bigint as string
  rate_den       TEXT NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  updated_by     TEXT
);

-- Watcher 看到的最新链上余额快照。仅 delta > 0 才入账。
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
  sui_address       TEXT NOT NULL,
  deposit_address   TEXT NOT NULL,
  coin_type         TEXT NOT NULL,
  amount_delta      TEXT NOT NULL,
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

-- 服务费扣减审计。每次调仓在 INSERT 时同步 UPDATE treasury_users.credits。
-- nonce 作主键防重放(rebalancer 用 `${tickId}:${pmId}` 生成)。
-- v1 不收 signature / message_b64(内部扣减由 rebalancer 触发,PM owner 通过
-- AgentAdded 链上事件默示授权);v2 暴露 HTTP API 时再 ALTER TABLE 加列。
CREATE TABLE IF NOT EXISTS treasury_service_charges (
  nonce            TEXT PRIMARY KEY,
  sui_address      TEXT NOT NULL,
  pm_id            TEXT,
  credits_debited  INTEGER NOT NULL,
  memo             TEXT,
  status           TEXT NOT NULL CHECK(status IN ('ok','rejected','refunded')),
  error            TEXT,
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
  to_address       TEXT,
  coin_type_in     TEXT NOT NULL,
  amount_in        TEXT NOT NULL,
  coin_type_out    TEXT,
  amount_out       TEXT,
  digest           TEXT,
  status           TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
  error            TEXT,
  initiated_by     TEXT NOT NULL,
  created_at_ms    INTEGER NOT NULL
);
