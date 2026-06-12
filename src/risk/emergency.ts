/**
 * src/risk/emergency.ts
 *
 * L3 emergency stop latch. When tripped, all on-chain operations must cease
 * until a human operator manually resets the latch (calls `reset()`).
 *
 * Design:
 * - Single in-memory latch per process.
 * - `trip(reason)` is idempotent — subsequent calls are no-ops.
 * - Persists one L3 risk_event row per trip invocation (idempotent at the
 *   reason level — duplicate reasons within the same process lifetime are
 *   still stored to maintain a full audit trail).
 * - No process.exit: the caller decides what to do after checking `isTripped()`.
 * - Reset is intentionally manual-only: the operator must call `reset()` with
 *   an explicit acknowledgment reason, which also logs the reset.
 *
 * See docs/risk-monitoring-design.md §四.4.2 (L3) and §九.
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
