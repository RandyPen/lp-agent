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
-- 唯一 deposit_address。derivation_index ∈ [1, 2^31)(0 留给 treasury master;
-- SLIP-0010 hardened 上限 2^31-1 = 2147483647)。
CREATE TABLE IF NOT EXISTS treasury_users (
  sui_address       TEXT PRIMARY KEY,
  derivation_index  INTEGER NOT NULL UNIQUE
                    CHECK(derivation_index >= 1 AND derivation_index < 2147483648),
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

------------------------------------------------------------------------------
-- ML 预测 + 状态机 + 风控事件(v1 — §6)
--
-- 键形状说明:predictions / market_state_history 按 pool_id 键(预测与状态是
-- 池级别事实,多 PM 同池不重复落行)。risk_events 加 pm_id(熔断可能针对单个 PM)。
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS predictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         TEXT NOT NULL,
  ts_ms           INTEGER NOT NULL,
  model_version   TEXT NOT NULL,
  active_bin      INTEGER NOT NULL,
  center_q10      REAL NOT NULL,
  -- center_offset: the q50 center offset in bin units relative to activeBin (F8).
  -- Named center_offset (not center_q50) because the model predicts an offset
  -- from the active bin, not an absolute bin position.  centerOffset = 0 means
  -- "predicted center coincides with the current active bin".
  center_offset   REAL NOT NULL,
  center_q90      REAL NOT NULL,
  width_sigma     REAL NOT NULL,
  p_above         REAL NOT NULL,
  p_below         REAL NOT NULL,
  feature_completeness REAL NOT NULL,
  psi             REAL NOT NULL,
  fallback        TEXT,
  -- executed_path: which strategy actually produced the output for this tick.
  --   'model'           — the ML model's output was used directly (not in probation,
  --                       fallback === false, PSI < threshold).
  --   'tier0_fallback'  — pred.fallback !== false; Tier 0 was used and we were NOT
  --                       already in probation before this tick.
  --   'tier0_probation' — pred.fallback === false but the pool is still in probation
  --                       (probation entry is not yet cleared — Tier 0 executed).
  -- NULL is reserved for shadow-mode rows and any pre-upgrade rows written before
  -- this column existed. The column is NOT NULL for all new rows written by mlAgent.
  executed_path   TEXT NOT NULL CHECK(executed_path IN ('model','tier0_fallback','tier0_probation')),
  infer_ms        INTEGER NOT NULL,
  snapshot_digest TEXT              -- 6 个关键字段的压缩摘要;完整特征行落 parquet,不进 SQLite
);
CREATE INDEX IF NOT EXISTS predictions_pool_ts ON predictions(pool_id, ts_ms DESC);

CREATE TABLE IF NOT EXISTS market_state_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         TEXT NOT NULL,
  entered_at_ms   INTEGER NOT NULL,
  exited_at_ms    INTEGER,
  state           TEXT NOT NULL CHECK(state IN ('NORMAL','TREND','EXTREME')),
  trigger         TEXT NOT NULL,
  prev_state      TEXT
);
CREATE INDEX IF NOT EXISTS state_pool_entered
  ON market_state_history(pool_id, entered_at_ms DESC);

CREATE TABLE IF NOT EXISTS risk_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         TEXT,
  pm_id           TEXT,              -- 可空:池级事件无 pm
  ts_ms           INTEGER NOT NULL,
  level           TEXT NOT NULL CHECK(level IN ('L1','L2','L3')),
  kind            TEXT NOT NULL,
  metric          TEXT NOT NULL,
  threshold       REAL NOT NULL,
  observed        REAL NOT NULL,
  action          TEXT NOT NULL,
  resolved_at_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS risk_events_ts ON risk_events(ts_ms DESC);

------------------------------------------------------------------------------
-- Shadow mode decisions (v1 ML validation — see src/services/shadowRunner.ts)
--
-- Records what mlAgent WOULD have done without executing it. Enables 14-day
-- side-by-side comparison of the ML strategy vs the live rule-based strategy.
--
-- `strategy_output_json`: the full StrategyOutput serialised (kind + plan if
--   applicable + fillBoundary). RebalancePlan.removeShares is stored as a
--   plain object (string keys).
-- `rule_output_json`: the fallback strategy's output for the same tick, used
--   as the comparison baseline in shadow reports.
-- `state`: the StateContext at the time of the shadow decision.
-- `prediction_id`: FK to predictions (nullable — populated when the inference
--   was persisted in the same tick).
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shadow_decisions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id               TEXT NOT NULL,
  pm_id                 TEXT NOT NULL,
  ts_ms                 INTEGER NOT NULL,
  market_state          TEXT NOT NULL CHECK(market_state IN ('NORMAL','TREND','EXTREME')),
  strategy_output_kind  TEXT NOT NULL CHECK(strategy_output_kind IN ('plan_and_reconcile','plan_only','reconcile_only','quiet')),
  strategy_output_json  TEXT NOT NULL,
  rule_output_kind      TEXT,
  rule_output_json      TEXT,
  lending_pct           REAL,
  half_width            INTEGER,
  trend_bias            REAL,
  model_version         TEXT,
  prediction_id         INTEGER REFERENCES predictions(id),
  created_at_ms         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_decisions_pool_ts
  ON shadow_decisions(pool_id, ts_ms DESC);
CREATE INDEX IF NOT EXISTS shadow_decisions_pm_ts
  ON shadow_decisions(pm_id, ts_ms DESC);
