import { getDb } from "../db/client.ts";
import { getAgentAddress } from "../sui/keypair.ts";
import { getPositionManager } from "../sui/cdpm/read.ts";
import { pollEvents } from "../sui/cdpm/events.ts";
import { EVENT_TYPES } from "../sui/cdpm/package.ts";
import { loadConfig } from "../config.ts";
import { log } from "../lib/logger.ts";
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
            db.prepare(
              `UPDATE subscriptions SET status = 'revoked', removed_at_ms = ?
               WHERE pm_id = ?`,
            ).run(ev.timestampMs || Date.now(), pmId);

            saveCursor(stream, { txDigest: ev.txDigest, eventSeq: ev.eventSeq }, Date.now());
          })();

          removed++;
          log.info("subscriptions: agent removed", { pmId, agent });
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
            db.prepare(
              `UPDATE subscriptions SET status = 'closed', removed_at_ms = ?
               WHERE pm_id = ?`,
            ).run(ev.timestampMs || Date.now(), pmId);

            saveCursor(stream, { txDigest: ev.txDigest, eventSeq: ev.eventSeq }, Date.now());
          })();

          closed++;
          log.info("subscriptions: PM closed", { pmId });
        }

        if (nextCursor) {
          saveCursor(stream, nextCursor, Date.now());
        }
      }

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
