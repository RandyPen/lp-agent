/**
 * src/risk/emergency.ts
 *
 * L3 emergency stop latch. When tripped, all on-chain operations must cease
 * until a human operator manually resets the latch (calls `reset()`).
 *
 * Design:
 * - Single in-memory latch per process, REHYDRATED from `risk_events` at
 *   construction: an unresolved `emergency_stop` row re-trips the latch, so a
 *   process restart cannot silently clear L3.
 * - `trip(reason)` is idempotent — subsequent calls are no-ops.
 * - Persists one L3 risk_event row per trip invocation (idempotent at the
 *   reason level — duplicate reasons within the same process lifetime are
 *   still stored to maintain a full audit trail).
 * - No process.exit: the caller decides what to do after checking `isTripped()`.
 * - Reset is intentionally manual-only. Two paths:
 *     - in-process `reset(ackReason)` (tests / future admin surface);
 *     - out-of-process `resolveEmergencyStopInDb(db, ackReason)` — the
 *       operator runs `scripts/risk-reset-emergency.ts` (which calls it) and
 *       then RESTARTS the agent; the running process intentionally cannot be
 *       un-tripped externally, the restart's rehydration clears the latch.
 *
 * See docs/risk-monitoring-design.md §4.4.2 (L3) and §9.
 */

import type { Database } from "bun:sqlite";
import { log } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmergencyStop {
  /**
   * Trip the L3 emergency stop. Idempotent — once tripped, subsequent calls
   * log but do not write additional DB rows.
   */
  trip(reason: string): void;
  /** Returns true when the emergency stop is currently active. */
  isTripped(): boolean;
  /**
   * Manually reset the emergency stop. Requires an explicit acknowledgment
   * reason for the audit log. Throws if not currently tripped.
   */
  reset(ackReason: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface EmergencyStopDeps {
  db: Database;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  nowMs?: () => number;
}

/**
 * Create an L3 emergency stop latch.
 *
 * Pass the shared SQLite `Database` instance. The `risk_events` table must
 * already exist (schema.sql creates it on every `openDb()` call).
 */
export function createEmergencyStop(deps: EmergencyStopDeps): EmergencyStop {
  const { db } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());

  let tripped = false;
  let tripReason: string | null = null;
  let tripEventId: number | null = null;

  // Rehydrate from DB: an unresolved emergency_stop row means the latch was
  // tripped by a previous process and never operator-reset. Without this, a
  // simple restart would silently clear L3 — defeating the whole latch.
  const unresolved = db
    .prepare<{ id: number }, []>(
      `SELECT id FROM risk_events
       WHERE kind = 'emergency_stop' AND resolved_at_ms IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get();
  if (unresolved) {
    tripped = true;
    tripEventId = unresolved.id;
    tripReason = `rehydrated:risk_event:${unresolved.id}`;
    log.error(
      "risk/emergency: L3 EMERGENCY STOP rehydrated from DB — still tripped from a previous run. " +
        "Reset via scripts/risk-reset-emergency.ts, then restart.",
      { riskEventId: unresolved.id },
    );
  }

  const insertRiskEvent = db.prepare<
    unknown,
    [
      pool_id: null,
      pm_id: null,
      ts_ms: number,
      level: string,
      kind: string,
      metric: string,
      threshold: number,
      observed: number,
      action: string,
    ]
  >(
    `INSERT INTO risk_events (pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function trip(reason: string): void {
    if (tripped) {
      // Already tripped — only log, no additional DB row (idempotent).
      log.warn("risk/emergency: trip called while already tripped", { reason, tripReason });
      return;
    }

    const ts = nowMs();
    const result = insertRiskEvent.run(
      null,
      null,
      ts,
      "L3",
      "emergency_stop",
      "emergency_stop",
      0,
      1,
      "halt_all_onchain_operations",
    );
    tripEventId = Number(result.lastInsertRowid);

    tripped = true;
    tripReason = reason;

    log.error("risk/emergency: L3 EMERGENCY STOP TRIPPED — all on-chain operations halted", {
      reason,
      ts,
      riskEventId: tripEventId,
    });
  }

  function isTripped(): boolean {
    return tripped;
  }

  function reset(ackReason: string): void {
    if (!tripped) {
      throw new Error("risk/emergency: reset() called but emergency stop is not tripped");
    }

    const ts = nowMs();

    // Mark the original L3 event as resolved
    if (tripEventId !== null) {
      db.run(
        "UPDATE risk_events SET resolved_at_ms = ? WHERE id = ?",
        [ts, tripEventId],
      );
    }

    // Insert a separate L3 reset event for the audit trail
    insertRiskEvent.run(
      null,
      null,
      ts,
      "L3",
      "emergency_stop_reset",
      "emergency_stop",
      0,
      0,
      "manual_reset",
    );

    log.warn("risk/emergency: L3 emergency stop RESET by operator", {
      ackReason,
      originalReason: tripReason,
      ts,
    });

    tripped = false;
    tripReason = null;
    tripEventId = null;
  }

  return { trip, isTripped, reset };
}

// ---------------------------------------------------------------------------
// Out-of-process operator reset
// ---------------------------------------------------------------------------

/**
 * Resolve the latest unresolved L3 `emergency_stop` row directly in the DB.
 *
 * This is the operator-facing reset path: run from an ops script
 * (`scripts/risk-reset-emergency.ts`) while the agent is stopped or about to
 * be restarted. The in-memory latch of a RUNNING process is deliberately not
 * touched — after resolving, restart the agent and `createEmergencyStop`'s
 * rehydration will come up un-tripped.
 *
 * Throws when there is no unresolved emergency_stop row (fail loudly — a
 * reset against a clean latch is an operator mistake worth surfacing).
 *
 * The ackReason lands in the audit trail (`action` column of the reset row).
 */
export function resolveEmergencyStopInDb(
  db: Database,
  ackReason: string,
  nowMsVal?: number,
): { resolvedEventId: number } {
  if (!ackReason || ackReason.trim() === "") {
    throw new Error("risk/emergency: resolveEmergencyStopInDb requires a non-empty ackReason");
  }
  const ts = nowMsVal ?? Date.now();

  const row = db
    .prepare<{ id: number }, []>(
      `SELECT id FROM risk_events
       WHERE kind = 'emergency_stop' AND resolved_at_ms IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get();
  if (!row) {
    throw new Error(
      "risk/emergency: no unresolved emergency_stop row found — the latch is not tripped in the DB",
    );
  }

  db.run("UPDATE risk_events SET resolved_at_ms = ? WHERE id = ?", [ts, row.id]);
  db.run(
    `INSERT INTO risk_events (pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action)
     VALUES (NULL, NULL, ?, 'L3', 'emergency_stop_reset', 'emergency_stop', 0, 0, ?)`,
    [ts, `manual_reset:${ackReason.trim()}`],
  );

  log.warn("risk/emergency: L3 emergency stop resolved in DB by operator", {
    ackReason,
    resolvedEventId: row.id,
    ts,
  });

  return { resolvedEventId: row.id };
}
