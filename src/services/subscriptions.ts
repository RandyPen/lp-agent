/**
 * PM subscription auto-discovery.
 *
 * Every poll cycle we tail three CDPM event streams from the last saved
 * cursor (cursor=null on first run = scan from genesis, so PMs authorised
 * before the agent ever started running get picked up too):
 *
 *   - `AgentAdded`           → INSERT subscription as 'active'
 *   - `AgentRemoved`         → DELETE subscription (stop monitoring)
 *   - `PositionManagerClosed`→ DELETE subscription (PM is gone on-chain)
 *
 * All three are filtered to events where `agent == getAgentAddress()`
 * (derived once from the operator's mnemonic via the keypair module).
 *
 * Lending events (Scallop/Kai supplied/redeemed) are tailed in the same
 * pass to keep `lending_positions` in sync.
 */

import { getDb } from "../db/client.ts";
import { getAgentAddress } from "../sui/keypair.ts";
import { getPositionManager } from "../sui/cdpm/read.ts";
import { pollEvents } from "../sui/cdpm/events.ts";
import { EVENT_TYPES } from "../sui/cdpm/package.ts";
import { loadConfig } from "../config.ts";
import { log } from "../lib/logger.ts";
import { findUserBySuiAddress } from "../treasury/store.ts";
import type { Subscription } from "../domain/types.ts";
import type { EventCursor } from "../sui/cdpm/types.ts";

export interface SubscriptionsService {
  pollOnce(): Promise<{ added: number; removed: number; closed: number }>;
  listActive(): Subscription[];
  get(pmId: string): Subscription | null;
}

// Row shape as returned from SQLite.
interface SubRow {
  pm_id: string;
  owner: string;
  pool_id: string;
  coin_type_a: string;
  coin_type_b: string;
  status: "active" | "revoked" | "closed";
  added_at_ms: number;
  removed_at_ms: number | null;
}

interface CursorRow {
  tx_digest: string | null;
  event_seq: string | null;
}

function rowToSubscription(row: SubRow): Subscription {
  return {
    pmId: row.pm_id,
    owner: row.owner,
    poolId: row.pool_id,
    coinTypeA: row.coin_type_a,
    coinTypeB: row.coin_type_b,
    status: row.status,
    addedAtMs: row.added_at_ms,
    removedAtMs: row.removed_at_ms,
  };
}

function loadCursor(stream: string): EventCursor | null {
  const db = getDb();
  const row = db
    .query<CursorRow, [string]>(
      "SELECT tx_digest, event_seq FROM event_cursor WHERE stream = ?",
    )
    .get(stream);
  if (!row || !row.tx_digest || !row.event_seq) return null;
  return { txDigest: row.tx_digest, eventSeq: row.event_seq };
}

function saveCursor(stream: string, cursor: EventCursor, nowMs: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO event_cursor (stream, tx_digest, event_seq, updated_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(stream) DO UPDATE SET
       tx_digest  = excluded.tx_digest,
       event_seq  = excluded.event_seq,
       updated_ms = excluded.updated_ms`,
  ).run(stream, cursor.txDigest, cursor.eventSeq, nowMs);
}

// Track which non-matching pool PMs we've already warned about.
const warnedPmIds = new Set<string>();

interface LendingPosRow {
  underlying_principal: string;
  market_coin_amount: string;
  yt_type: string;
}

function applyLendingSupply(
  protocol: "scallop" | "kai",
  pmId: string,
  coinType: string,
  ytType: string,
  depositAmount: bigint,
  marketCoinMinted: bigint,
  txDigest: string,
): void {
  const db = getDb();
  const existing = db
    .query<LendingPosRow, [string, string, string]>(
      `SELECT underlying_principal, market_coin_amount, yt_type FROM lending_positions
       WHERE pm_id = ? AND protocol = ? AND coin_type = ?`,
    )
    .get(pmId, protocol, coinType);
  const newPrincipal = (existing ? BigInt(existing.underlying_principal) : 0n) + depositAmount;
  const newMarketCoin = (existing ? BigInt(existing.market_coin_amount) : 0n) + marketCoinMinted;
  db.prepare(
    `INSERT INTO lending_positions
       (pm_id, protocol, coin_type, yt_type, underlying_principal, market_coin_amount, last_event_digest, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pm_id, protocol, coin_type) DO UPDATE SET
       yt_type              = excluded.yt_type,
       underlying_principal = excluded.underlying_principal,
       market_coin_amount   = excluded.market_coin_amount,
       last_event_digest    = excluded.last_event_digest,
       updated_at_ms        = excluded.updated_at_ms`,
  ).run(pmId, protocol, coinType, ytType, newPrincipal.toString(), newMarketCoin.toString(), txDigest, Date.now());
}

function applyLendingRedeem(
  protocol: "scallop" | "kai",
  pmId: string,
  coinType: string,
  marketCoinBurned: bigint,
  principalPortion: bigint,
  txDigest: string,
): void {
  const db = getDb();
  const existing = db
    .query<LendingPosRow, [string, string, string]>(
      `SELECT underlying_principal, market_coin_amount, yt_type FROM lending_positions
       WHERE pm_id = ? AND protocol = ? AND coin_type = ?`,
    )
    .get(pmId, protocol, coinType);
  if (!existing) {
    // No row to update — log and continue; on-chain truth is authoritative.
    log.warn("subscriptions: redeem event with no local lending_positions row", {
      pmId, protocol, coinType,
    });
    return;
  }
  const remainPrincipal = clampNonNegative(BigInt(existing.underlying_principal) - principalPortion);
  const remainMarketCoin = clampNonNegative(BigInt(existing.market_coin_amount) - marketCoinBurned);
  if (remainMarketCoin === 0n && remainPrincipal === 0n) {
    db.prepare(
      `DELETE FROM lending_positions WHERE pm_id = ? AND protocol = ? AND coin_type = ?`,
    ).run(pmId, protocol, coinType);
    return;
  }
  db.prepare(
    `UPDATE lending_positions
     SET underlying_principal = ?, market_coin_amount = ?, last_event_digest = ?, updated_at_ms = ?
     WHERE pm_id = ? AND protocol = ? AND coin_type = ?`,
  ).run(remainPrincipal.toString(), remainMarketCoin.toString(), txDigest, Date.now(), pmId, protocol, coinType);
}

function clampNonNegative(v: bigint): bigint {
  return v < 0n ? 0n : v;
}

async function pollLendingStream(stream: string): Promise<void> {
  const db = getDb();
  const cursor = loadCursor(stream);
  const { events, nextCursor } = await pollEvents(stream, cursor);

  for (const ev of events) {
    const p = ev.payload;
    switch (p.name) {
      case "ScallopSupplied":
        applyLendingSupply("scallop", p.data.pmId, p.data.coinType, "", p.data.depositAmount, p.data.marketCoinMinted, ev.txDigest);
        break;
      case "ScallopRedeemed":
        applyLendingRedeem("scallop", p.data.pmId, p.data.coinType, p.data.marketCoinRedeemed, p.data.principalPortion, ev.txDigest);
        break;
      case "KaiSupplied":
        applyLendingSupply("kai", p.data.pmId, p.data.coinType, p.data.ytType, p.data.depositAmount, p.data.ytMinted, ev.txDigest);
        break;
      case "KaiRedeemed":
        applyLendingRedeem("kai", p.data.pmId, p.data.coinType, p.data.ytBurned, p.data.principalPortion, ev.txDigest);
        break;
      default:
        continue;
    }
    saveCursor(stream, { txDigest: ev.txDigest, eventSeq: ev.eventSeq }, Date.now());
  }

  if (nextCursor) {
    saveCursor(stream, nextCursor, Date.now());
  }
}

export function createSubscriptionsService(): SubscriptionsService {
  return {
    async pollOnce(): Promise<{ added: number; removed: number; closed: number }> {
      const cfg = loadConfig();
      const agentAddress = getAgentAddress();
      const db = getDb();

      let added = 0;
      let removed = 0;
      let closed = 0;

      // ---- AgentAdded ----
      {
        const stream = EVENT_TYPES.AgentAdded;
        const cursor = loadCursor(stream);
        const { events, nextCursor } = await pollEvents(stream, cursor);

        for (const ev of events) {
          if (ev.payload.name !== "AgentAdded") continue;
          const { pmId, agent } = ev.payload.data;
          if (agent !== agentAddress) continue;

          let pm;
          try {
            pm = await getPositionManager(pmId);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn("subscriptions: failed to fetch PM on AgentAdded", { pmId, error: msg });
            continue;
          }

          db.transaction(() => {
            db.prepare(
              `INSERT INTO subscriptions
                 (pm_id, owner, pool_id, coin_type_a, coin_type_b, status, added_at_ms, removed_at_ms)
               VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)
               ON CONFLICT(pm_id) DO UPDATE SET
                 owner       = excluded.owner,
                 pool_id     = excluded.pool_id,
                 coin_type_a = excluded.coin_type_a,
                 coin_type_b = excluded.coin_type_b,
                 status      = 'active',
                 added_at_ms = excluded.added_at_ms,
                 removed_at_ms = NULL`,
            ).run(
              pmId,
              pm.owner,
              pm.poolId,
              pm.coinTypeA,
              pm.coinTypeB,
              ev.timestampMs || Date.now(),
            );

            saveCursor(stream, { txDigest: ev.txDigest, eventSeq: ev.eventSeq }, Date.now());
          })();

          added++;
          log.info("subscriptions: agent added", { pmId, agent });

          // §5 doc: when treasury is enabled, log the treasury registration
          // status of the new PM's owner so operators can see which PMs are
          // unpaid at a glance. No gate here — actual enforcement is in tickOne.
          if (cfg.treasury.enabled) {
            const treasuryUser = findUserBySuiAddress(pm.owner);
            log.info("subscriptions: agent added — treasury status", {
              pmId,
              owner: pm.owner,
              treasuryRegistered: treasuryUser !== null,
              credits: treasuryUser?.credits ?? 0,
            });
          }
        }

        // Advance cursor even when there are no matching events.
        if (nextCursor) {
          saveCursor(stream, nextCursor, Date.now());
        }
      }

      // ---- AgentRemoved ----
      {
        const stream = EVENT_TYPES.AgentRemoved;
        const cursor = loadCursor(stream);
        const { events, nextCursor } = await pollEvents(stream, cursor);

        for (const ev of events) {
          if (ev.payload.name !== "AgentRemoved") continue;
          const { pmId, agent } = ev.payload.data;
          if (agent !== agentAddress) continue;

          db.transaction(() => {
            // Hard-delete: user revoked our agency, stop monitoring this PM
            // entirely. Audit trail lives on-chain (AgentRemoved event) and in
            // `rebalances` / `lending_actions` (keyed by pm_id, not FK'd).
            db.prepare(`DELETE FROM subscriptions WHERE pm_id = ?`).run(pmId);
            saveCursor(stream, { txDigest: ev.txDigest, eventSeq: ev.eventSeq }, Date.now());
          })();

          removed++;
          log.info("subscriptions: agent removed, dropped from monitor", { pmId, agent });
        }

        if (nextCursor) {
          saveCursor(stream, nextCursor, Date.now());
        }
      }

      // ---- PositionManagerClosed ----
      {
        const stream = EVENT_TYPES.PositionManagerClosed;
        const cursor = loadCursor(stream);
        const { events, nextCursor } = await pollEvents(stream, cursor);

        for (const ev of events) {
          if (ev.payload.name !== "PositionManagerClosed") continue;
          const { pmId } = ev.payload.data;

          db.transaction(() => {
            // PM is gone on-chain — drop from monitor.
            db.prepare(`DELETE FROM subscriptions WHERE pm_id = ?`).run(pmId);
            saveCursor(stream, { txDigest: ev.txDigest, eventSeq: ev.eventSeq }, Date.now());
          })();

          closed++;
          log.info("subscriptions: PM closed, dropped from monitor", { pmId });
        }

        if (nextCursor) {
          saveCursor(stream, nextCursor, Date.now());
        }
      }

      // ---- Lending events: maintain lending_positions rows ----
      await pollLendingStream(EVENT_TYPES.ScallopSupplied);
      await pollLendingStream(EVENT_TYPES.ScallopRedeemed);
      await pollLendingStream(EVENT_TYPES.KaiSupplied);
      await pollLendingStream(EVENT_TYPES.KaiRedeemed);

      return { added, removed, closed };
    },

    listActive(): Subscription[] {
      const cfg = loadConfig();
      const db = getDb();
      const rows = db
        .query<SubRow, []>(
          "SELECT * FROM subscriptions WHERE status = 'active'",
        )
        .all();

      const result: Subscription[] = [];
      for (const row of rows) {
        if (row.pool_id !== cfg.poolProfile.poolId) {
          if (!warnedPmIds.has(row.pm_id)) {
            warnedPmIds.add(row.pm_id);
            log.warn("subscriptions: skipping PM for different pool", {
              pmId: row.pm_id,
              pmPoolId: row.pool_id,
              configuredPoolId: cfg.poolProfile.poolId,
            });
          }
          continue;
        }
        result.push(rowToSubscription(row));
      }
      return result;
    },

    get(pmId: string): Subscription | null {
      const db = getDb();
      const row = db
        .query<SubRow, [string]>(
          "SELECT * FROM subscriptions WHERE pm_id = ?",
        )
        .get(pmId);
      return row ? rowToSubscription(row) : null;
    },
  };
}
