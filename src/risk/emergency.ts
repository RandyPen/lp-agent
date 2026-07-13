/**
 * src/risk/emergency.ts
 *
 * L3 emergency stop — a DRAIN-THEN-LATCH state machine.
 *
 *     ARMED ──trip()──▶ DRAINING ──position empty──▶ HALTED
 *                          │                            ▲
 *                          └── drain failed N times ────┘
 *
 * WHY IT DRAINS FIRST (this is the load-bearing change)
 * -----------------------------------------------------
 * L3 used to simply halt: the rebalancer saw the veto and `return`ed, leaving
 * the user's liquidity DEPLOYED in the pool, unmanaged, until a human with
 * shell access noticed. Worse, `evaluateL3` runs before the L2 branch, so
 * escalating from L2 to L3 CANCELLED the protective full-withdrawal L2 was
 * about to perform. The response to "things got worse" was to stop defending.
 *
 * The objection to acting under L3 is "we are blind, and acting on bad data may
 * be worse than not acting". That is a real argument for most actions. It does
 * not apply to a full withdrawal, for one reason:
 *
 *     REMOVING LIQUIDITY NEEDS NO PRICE.
 *
 * `agent_remove_liquidity` over our own bins requires no oracle, no spread, no
 * funding rate. It is the one action whose correctness does not depend on the
 * data that just went stale — and, since the agent has no swap permission, it
 * is also the only defensive move it has. Note the `outage_with_position`
 * trigger fires ONLY when a position is open ("we are blind AND exposed"), and
 * the old behaviour was to then disable the only mechanism that could remove
 * that exposure. That was inverted.
 *
 * Draining is not free — it realises IL, stops fee income, and costs gas if the
 * trigger was a false positive. That is a bounded, recoverable cost. Leaving
 * capital deployed, unmanaged and unmonitored is not bounded.
 *
 * Bounded attempts: if the chain itself is what is broken, the withdrawal will
 * fail too. After `drainMaxAttempts` we go to HALTED anyway and raise the
 * loudest alert we have — `l3_drain_failed` — because a halted agent with a
 * still-deployed position is the worst state this system can be in.
 *
 * Everything else is unchanged: the latch is REHYDRATED from `risk_events` at
 * construction (a restart cannot silently clear L3), and reset is manual-only
 * (`scripts/risk-reset-emergency.ts` → restart).
 */

import type { Database } from "bun:sqlite";
import { log } from "../lib/logger.ts";
import type { AlertDispatcher } from "../alerts/sinks.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * ARMED    — normal operation.
 * DRAINING — L3 fired; the agent is force-exiting the position. On-chain
 *            REMOVE operations are still permitted (and are the only thing
 *            permitted); no new liquidity may be added.
 * HALTED   — terminal. Nothing on-chain runs until an operator resets.
 */
export type EmergencyState = "ARMED" | "DRAINING" | "HALTED";

export interface EmergencyStop {
  /**
   * Trip the L3 emergency stop → DRAINING. Idempotent: calling it while already
   * DRAINING or HALTED logs but does not re-enter the state machine.
   */
  trip(reason: string): void;
  /** Current state. */
  state(): EmergencyState;
  /**
   * True when NO on-chain operation may run (state === HALTED).
   *
   * Deliberately NOT true while DRAINING: during a drain the agent must still be
   * able to submit the withdrawal PTB. Callers that mean "should I stop doing
   * normal work?" want `state() !== "ARMED"`.
   */
  isTripped(): boolean;
  /** True while the agent should be force-exiting rather than running a strategy. */
  isDraining(): boolean;
  /**
   * Report the outcome of one drain attempt. The rebalancer calls this after
   * trying the emergency withdrawal.
   *
   * `positionEmpty: true` → HALTED with `l3_drained` (capital is safe in the PM).
   * Otherwise the attempt counter advances; once it exceeds `drainMaxAttempts`
   * → HALTED with `l3_drain_failed` (position STILL DEPLOYED — page a human).
   */
  recordDrainAttempt(opts: { positionEmpty: boolean; pmId?: string; error?: string }): void;
  /**
   * Manually reset. Requires an explicit acknowledgment reason for the audit
   * log. Throws if not currently tripped.
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
  /**
   * How many times to attempt the emergency withdrawal before giving up and
   * going HALTED with the position still deployed. Default 3.
   *
   * Bounded because the L3 trigger may BE the chain being broken (consecutive
   * tx failures, RPC outage) — in which case the withdrawal cannot succeed and
   * retrying forever just delays the page to a human.
   */
  drainMaxAttempts?: number;
  /** Where L3 transitions are announced. Without it, they are silent. */
  alerts?: AlertDispatcher;
}

/**
 * Create an L3 emergency stop latch.
 *
 * Pass the shared SQLite `Database` instance. The `risk_events` table must
 * already exist (schema.sql creates it on every `openDb()` call).
 */
export function createEmergencyStop(deps: EmergencyStopDeps): EmergencyStop {
  const { db, alerts } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const drainMaxAttempts = deps.drainMaxAttempts ?? 3;

  let current: EmergencyState = "ARMED";
  let tripReason: string | null = null;
  let tripEventId: number | null = null;
  let drainAttempts = 0;

  /**
   * Fire-and-forget: an alert must never delay or abort the unwind it reports
   * on. The dispatcher already swallows sink errors; this also detaches the
   * await so a slow pager cannot stall the emergency path.
   */
  function alert(
    severity: "info" | "warn" | "critical",
    code: Parameters<NonNullable<typeof alerts>["emit"]>[0]["code"],
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    void alerts?.emit({ severity, code, message, tsMs: nowMs(), fields });
  }

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
    // Come up HALTED, not DRAINING. We cannot know from the row alone whether
    // the previous run managed to exit, and re-entering a drain on every
    // restart could thrash the position. A human is already required here; the
    // alert tells them so instead of letting the agent boot quietly frozen.
    current = "HALTED";
    tripEventId = unresolved.id;
    tripReason = `rehydrated:risk_event:${unresolved.id}`;
    log.error(
      "risk/emergency: L3 EMERGENCY STOP rehydrated from DB — still tripped from a previous run. " +
        "Reset via 'bun run risk-reset \"<reason>\"', then restart.",
      { riskEventId: unresolved.id },
    );
    alert(
      "critical",
      "l3_rehydrated",
      "Agent started with L3 STILL TRIPPED from a previous run — automation is halted. " +
        "Check whether the position was exited before resetting.",
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
    if (current !== "ARMED") {
      // Already DRAINING or HALTED — log only, no additional DB row (idempotent).
      log.warn("risk/emergency: trip called while already tripped", {
        reason,
        state: current,
        tripReason,
      });
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
      // The action the agent now takes. It used to be "halt_all_onchain_operations",
      // which was accurate and was the bug: it halted while still exposed.
      "drain_position_then_halt",
    );
    tripEventId = Number(result.lastInsertRowid);

    current = "DRAINING";
    drainAttempts = 0;
    tripReason = reason;

    log.error(
      "risk/emergency: L3 TRIPPED — force-exiting the position, then halting",
      { reason, ts, riskEventId: tripEventId, drainMaxAttempts },
    );
    alert("critical", "l3_tripped", `L3 emergency stop: ${reason}. Force-exiting the position.`, {
      reason,
      riskEventId: tripEventId,
      drainMaxAttempts,
    });
  }

  function recordDrainAttempt(opts: {
    positionEmpty: boolean;
    pmId?: string;
    error?: string;
  }): void {
    if (current !== "DRAINING") return;

    if (opts.positionEmpty) {
      current = "HALTED";
      log.warn("risk/emergency: L3 drain complete — position exited, agent halted", {
        attempts: drainAttempts,
        pmId: opts.pmId,
      });
      alert(
        "critical",
        "l3_drained",
        "L3: position exited successfully. Funds are in the PositionManager balance and the " +
          "agent is halted. Reset with 'bun run risk-reset \"<reason>\"' + restart.",
        { attempts: drainAttempts, pmId: opts.pmId, reason: tripReason },
      );
      return;
    }

    drainAttempts++;
    if (drainAttempts < drainMaxAttempts) {
      log.error("risk/emergency: L3 drain attempt failed, will retry", {
        attempt: drainAttempts,
        of: drainMaxAttempts,
        pmId: opts.pmId,
        error: opts.error,
      });
      return;
    }

    // Give up. This is the worst state the system can reach: automation off,
    // capital still in the market. Say so as loudly as we can.
    current = "HALTED";
    log.error(
      "risk/emergency: L3 DRAIN FAILED — HALTED WITH THE POSITION STILL DEPLOYED. " +
        "Capital is exposed and unmanaged. Human intervention required NOW.",
      { attempts: drainAttempts, pmId: opts.pmId, error: opts.error, reason: tripReason },
    );
    alert(
      "critical",
      "l3_drain_failed",
      "L3 COULD NOT EXIT THE POSITION after " +
        `${drainAttempts} attempts. The agent is halted and the position is STILL DEPLOYED — ` +
        "capital is exposed with automation disabled. Intervene manually.",
      { attempts: drainAttempts, pmId: opts.pmId, error: opts.error, reason: tripReason },
    );
  }

  function state(): EmergencyState {
    return current;
  }

  /**
   * "No on-chain operation may run." False while DRAINING — the drain itself
   * needs to submit a PTB.
   */
  function isTripped(): boolean {
    return current === "HALTED";
  }

  function isDraining(): boolean {
    return current === "DRAINING";
  }

  function reset(ackReason: string): void {
    if (current === "ARMED") {
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
      previousState: current,
      ts,
    });

    current = "ARMED";
    tripReason = null;
    tripEventId = null;
    drainAttempts = 0;
  }

  return { trip, state, isTripped, isDraining, recordDrainAttempt, reset };
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
