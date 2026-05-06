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
