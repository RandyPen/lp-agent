/**
 * src/risk/emergency.ts
 *
 * L3 emergency stop — a SCOPED, DRAIN-THEN-LATCH state machine.
 *
 *     ARMED ──trip()──▶ DRAINING ──DLMM position gone──▶ HALTED
 *                          │                                ▲
 *                          └──── drain failed N times ──────┘
 *
 * WHY IT DRAINS FIRST
 * -------------------
 * L3 used to simply halt: the rebalancer saw the veto and `return`ed, leaving
 * the user's liquidity DEPLOYED, unmanaged, until a human with shell access
 * noticed. Worse, `evaluateL3` runs before the L2 branch, so escalating from L2
 * to L3 CANCELLED the protective withdrawal L2 was about to perform.
 *
 * The objection to acting under L3 is "we are blind, and acting on bad data may
 * be worse than not acting". That is a real argument for most actions. It does
 * not apply to a full withdrawal, because REMOVING LIQUIDITY NEEDS NO PRICE:
 * `agent_remove_liquidity` over our own bins requires no oracle, no spread, no
 * funding rate. And since the agent has no swap permission, it is also the only
 * defensive move it has.
 *
 * WHAT "DRAINED" MEANS (and what it does not)
 * -------------------------------------------
 * L3 exists to remove PRICE-VOLATILITY exposure — to stop being an LP in a
 * market we cannot manage. Once the DLMM position is gone, that objective is
 * met. Where the capital then sits is a separate question: `PM.balance` and
 * Scallop/Kai are BOTH acceptable, because neither is exposed to impermanent
 * loss or adverse selection, and the CDPM contract lets the OWNER redeem from
 * lending without the agent (`assert_caller_authorized` is `is_owner ||
 * is_agent`). A halted agent therefore does not trap anyone's funds.
 *
 * So `positionEmpty` means "no DLMM bins remain", not "no funds anywhere". But
 * the alert MUST then say where the money actually is — an operator woken at 3am
 * needs the truth, and "funds are in the PositionManager balance" is a lie when
 * an L2 EXTREME already swept 100% of them into Scallop.
 *
 * SCOPES
 * ------
 * A latch is keyed by scope, because the blast radius of a trigger is not
 * uniform:
 *
 *   pm    — this PositionManager only (consecutive tx failures, unreadable PM).
 *           One user's malformed position must not exit everyone else's.
 *   pool  — every PM on the pool (repeated L2, catastrophic PnL, pool unreadable).
 *   global— operator-initiated.
 *
 * The effective state for a tick is the most severe latch among global,
 * pool:<poolId> and pm:<pmId>.
 *
 * Everything else is unchanged: latches REHYDRATE from `risk_events` at
 * construction (a restart cannot silently clear L3), and reset is manual-only.
 */

import type { Database } from "bun:sqlite";
import { log } from "../lib/logger.ts";
import type { AlertDispatcher } from "../alerts/sinks.ts";
import type { LendingState } from "../sui/lending/types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EmergencyState = "ARMED" | "DRAINING" | "HALTED";

export type EmergencyScope =
  | { kind: "global" }
  | { kind: "pool"; poolId: string }
  | { kind: "pm"; pmId: string };

/** Which latches apply to a given tick. */
export interface EmergencyContext {
  poolId?: string;
  pmId?: string;
}

/**
 * Where the capital ended up after a drain. Carried into the alert so the
 * message can be true rather than reassuring.
 */
export interface FundsLocation {
  /** PHYSICAL coin amounts sitting in the PositionManager balance. */
  balanceA: bigint;
  balanceB: bigint;
  lending: LendingState;
}

export interface DrainOutcome {
  /**
   * True when NO DLMM position bins remain — i.e. the volatility exposure L3
   * exists to remove is gone. NOT "no funds anywhere": capital in lending is
   * fine (see the module header).
   */
  positionEmpty: boolean;
  pmId?: string;
  error?: string;
  /** Where the money actually is. Omit only when it could not be read. */
  funds?: FundsLocation;
}

export interface EmergencyStop {
  /** Trip the given scope → DRAINING. Idempotent per scope. */
  trip(reason: string, scope: EmergencyScope): void;
  /** Most severe state among the latches applying to `ctx`. */
  state(ctx?: EmergencyContext): EmergencyState;
  /** True when NO on-chain operation may run (HALTED). False while DRAINING. */
  isTripped(ctx?: EmergencyContext): boolean;
  /** True while the agent should be force-exiting rather than running a strategy. */
  isDraining(ctx?: EmergencyContext): boolean;
  /** Report one drain attempt against every DRAINING latch applicable to `ctx`. */
  recordDrainAttempt(ctx: EmergencyContext, outcome: DrainOutcome): void;
  /** Manually reset every tripped latch. Throws if none is tripped. */
  reset(ackReason: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface EmergencyStopDeps {
  db: Database;
  nowMs?: () => number;
  /**
   * Emergency-withdrawal attempts before going HALTED anyway. Default 3.
   * Bounded because the trigger may BE the chain being broken, in which case
   * the exit cannot succeed and retrying forever only delays paging a human.
   */
  drainMaxAttempts?: number;
  alerts?: AlertDispatcher;
}

interface Latch {
  state: EmergencyState;
  reason: string;
  eventId: number | null;
  attempts: number;
}

function scopeKey(scope: EmergencyScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "pool") return `pool:${scope.poolId}`;
  return `pm:${scope.pmId}`;
}

const SEVERITY: Record<EmergencyState, number> = { ARMED: 0, DRAINING: 1, HALTED: 2 };

/** Human-readable "where the money is", for the alert body. */
function describeFunds(funds: FundsLocation | undefined): string {
  if (!funds) return "fund location unknown (the PM could not be read)";

  const parts: string[] = [];
  if (funds.balanceA > 0n || funds.balanceB > 0n) {
    parts.push(`PM balance (a=${funds.balanceA}, b=${funds.balanceB})`);
  }
  for (const [protocol, positions] of Object.entries(funds.lending)) {
    for (const pos of Object.values(positions) as Array<{
      coinType: string;
      underlyingPrincipal: bigint;
    }>) {
      if (pos.underlyingPrincipal > 0n) {
        const coin = pos.coinType.split("::").pop() ?? pos.coinType;
        parts.push(`${protocol} lending (${pos.underlyingPrincipal} ${coin})`);
      }
    }
  }
  return parts.length > 0 ? parts.join(" + ") : "nothing (the PM is empty)";
}

export function createEmergencyStop(deps: EmergencyStopDeps): EmergencyStop {
  const { db, alerts } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const drainMaxAttempts = deps.drainMaxAttempts ?? 3;

  const latches = new Map<string, Latch>();

  function alert(
    severity: "info" | "warn" | "critical",
    code: "l3_tripped" | "l3_drained" | "l3_drain_failed" | "l3_rehydrated",
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    // Fire-and-forget: a slow pager must never delay the unwind it reports on.
    void alerts?.emit({ severity, code, message, tsMs: nowMs(), fields });
  }

  const insertRiskEvent = db.prepare<
    unknown,
    [
      pool_id: string | null,
      pm_id: string | null,
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

  // ---- Rehydrate every unresolved latch -------------------------------------
  //
  // Come up HALTED, not DRAINING: we cannot tell from the row alone whether the
  // previous run managed to exit, and re-entering a drain on every restart
  // could thrash the position. A human is already required; the alert says so.
  const unresolved = db
    .prepare<{ id: number; pool_id: string | null; pm_id: string | null }, []>(
      `SELECT id, pool_id, pm_id FROM risk_events
       WHERE kind = 'emergency_stop' AND resolved_at_ms IS NULL
       ORDER BY id ASC`,
    )
    .all();

  for (const row of unresolved) {
    const scope: EmergencyScope = row.pm_id
      ? { kind: "pm", pmId: row.pm_id }
      : row.pool_id
        ? { kind: "pool", poolId: row.pool_id }
        : { kind: "global" };
    latches.set(scopeKey(scope), {
      state: "HALTED",
      reason: `rehydrated:risk_event:${row.id}`,
      eventId: row.id,
      attempts: 0,
    });
  }

  if (unresolved.length > 0) {
    const scopes = [...latches.keys()];
    log.error(
      "risk/emergency: L3 rehydrated from DB — still tripped from a previous run. " +
        "Reset via 'bun run risk-reset \"<reason>\"', then restart.",
      { scopes },
    );
    alert(
      "critical",
      "l3_rehydrated",
      `Agent started with L3 STILL TRIPPED from a previous run (${scopes.join(", ")}) — ` +
        "automation is halted. Check whether the position was exited before resetting.",
      { scopes },
    );
  }

  // ---- Scope resolution -----------------------------------------------------

  /** Every latch that applies to `ctx`, most severe first. */
  function applicable(ctx: EmergencyContext | undefined): Array<[string, Latch]> {
    const keys = ["global"];
    if (ctx?.poolId) keys.push(`pool:${ctx.poolId}`);
    if (ctx?.pmId) keys.push(`pm:${ctx.pmId}`);

    const out: Array<[string, Latch]> = [];
    for (const k of keys) {
      const l = latches.get(k);
      if (l && l.state !== "ARMED") out.push([k, l]);
    }
    // When no ctx is given, fall back to "any latch anywhere" so a bare
    // isTripped() cannot silently report ARMED while a PM is halted.
    if (!ctx) {
      for (const [k, l] of latches) {
        if (l.state !== "ARMED" && !out.some(([ok]) => ok === k)) out.push([k, l]);
      }
    }
    return out.sort((a, b) => SEVERITY[b[1].state] - SEVERITY[a[1].state]);
  }

  function state(ctx?: EmergencyContext): EmergencyState {
    const hits = applicable(ctx);
    return hits.length > 0 ? hits[0]![1].state : "ARMED";
  }

  function isTripped(ctx?: EmergencyContext): boolean {
    return state(ctx) === "HALTED";
  }

  function isDraining(ctx?: EmergencyContext): boolean {
    return state(ctx) === "DRAINING";
  }

  // ---- Transitions ----------------------------------------------------------

  function trip(reason: string, scope: EmergencyScope): void {
    const key = scopeKey(scope);
    const existing = latches.get(key);
    if (existing && existing.state !== "ARMED") {
      log.warn("risk/emergency: trip called while already tripped", {
        reason,
        scope: key,
        state: existing.state,
      });
      return;
    }

    const ts = nowMs();
    const result = insertRiskEvent.run(
      scope.kind === "pool" ? scope.poolId : null,
      scope.kind === "pm" ? scope.pmId : null,
      ts,
      "L3",
      "emergency_stop",
      "emergency_stop",
      0,
      1,
      "drain_position_then_halt",
    );

    latches.set(key, {
      state: "DRAINING",
      reason,
      eventId: Number(result.lastInsertRowid),
      attempts: 0,
    });

    log.error("risk/emergency: L3 TRIPPED — force-exiting the position, then halting", {
      reason,
      scope: key,
      drainMaxAttempts,
    });
    alert(
      "critical",
      "l3_tripped",
      `L3 emergency stop [${key}]: ${reason}. Force-exiting the DLMM position.`,
      { reason, scope: key, drainMaxAttempts },
    );
  }

  function recordDrainAttempt(ctx: EmergencyContext, outcome: DrainOutcome): void {
    for (const [key, latch] of applicable(ctx)) {
      if (latch.state !== "DRAINING") continue;

      if (outcome.positionEmpty) {
        latch.state = "HALTED";
        const where = describeFunds(outcome.funds);
        log.warn("risk/emergency: L3 drain complete — DLMM position exited, agent halted", {
          scope: key,
          attempts: latch.attempts,
          pmId: outcome.pmId,
          fundsNow: where,
        });
        alert(
          "critical",
          "l3_drained",
          `L3 [${key}]: DLMM position exited — price exposure is now ZERO. ` +
            `Funds are in: ${where}. The agent is halted; reset with ` +
            `'bun run risk-reset "<reason>"' + restart. ` +
            `(The owner can withdraw or redeem directly at any time — the agent is not needed.)`,
          { scope: key, attempts: latch.attempts, pmId: outcome.pmId, fundsNow: where },
        );
        continue;
      }

      latch.attempts++;
      if (latch.attempts < drainMaxAttempts) {
        log.error("risk/emergency: L3 drain attempt failed, will retry", {
          scope: key,
          attempt: latch.attempts,
          of: drainMaxAttempts,
          pmId: outcome.pmId,
          error: outcome.error,
        });
        continue;
      }

      // Give up. Automation off, capital still in the market. Say so as loudly
      // as we can — this is the worst state the system can reach.
      latch.state = "HALTED";
      log.error(
        "risk/emergency: L3 DRAIN FAILED — HALTED WITH THE POSITION STILL DEPLOYED. " +
          "Capital is exposed and unmanaged. Human intervention required NOW.",
        { scope: key, attempts: latch.attempts, pmId: outcome.pmId, error: outcome.error },
      );
      alert(
        "critical",
        "l3_drain_failed",
        `L3 [${key}] COULD NOT EXIT THE DLMM POSITION after ${latch.attempts} attempts. ` +
          "The agent is halted and the position is STILL DEPLOYED — capital is exposed to " +
          "price movement with automation disabled. Intervene manually.",
        { scope: key, attempts: latch.attempts, pmId: outcome.pmId, error: outcome.error },
      );
    }
  }

  function reset(ackReason: string): void {
    const tripped = [...latches.entries()].filter(([, l]) => l.state !== "ARMED");
    if (tripped.length === 0) {
      throw new Error("risk/emergency: reset() called but no emergency stop is tripped");
    }

    const ts = nowMs();
    for (const [key, latch] of tripped) {
      if (latch.eventId !== null) {
        db.run("UPDATE risk_events SET resolved_at_ms = ? WHERE id = ?", [ts, latch.eventId]);
      }
      insertRiskEvent.run(
        null,
        null,
        ts,
        "L3",
        "emergency_stop_reset",
        "emergency_stop",
        0,
        0,
        `manual_reset:${key}`,
      );
      log.warn("risk/emergency: L3 emergency stop RESET by operator", {
        scope: key,
        ackReason,
        originalReason: latch.reason,
        previousState: latch.state,
      });
      latches.delete(key);
    }
  }

  return { trip, state, isTripped, isDraining, recordDrainAttempt, reset };
}

// ---------------------------------------------------------------------------
// Out-of-process operator reset
// ---------------------------------------------------------------------------

/**
 * Resolve EVERY unresolved L3 `emergency_stop` row directly in the DB.
 *
 * The operator-facing reset path: run from `scripts/risk-reset-emergency.ts`
 * while the agent is stopped or about to be restarted. The in-memory latches of
 * a RUNNING process are deliberately untouched — after resolving, restart, and
 * rehydration comes up clean.
 *
 * Throws when there is nothing to resolve (a reset against a clean latch is an
 * operator mistake worth surfacing).
 */
export function resolveEmergencyStopInDb(
  db: Database,
  ackReason: string,
  nowMsVal?: number,
): { resolvedEventIds: number[] } {
  if (!ackReason || ackReason.trim() === "") {
    throw new Error("risk/emergency: resolveEmergencyStopInDb requires a non-empty ackReason");
  }
  const ts = nowMsVal ?? Date.now();

  const rows = db
    .prepare<{ id: number }, []>(
      `SELECT id FROM risk_events
       WHERE kind = 'emergency_stop' AND resolved_at_ms IS NULL
       ORDER BY id ASC`,
    )
    .all();
  if (rows.length === 0) {
    throw new Error(
      "risk/emergency: no unresolved emergency_stop row found — the latch is not tripped in the DB",
    );
  }

  for (const row of rows) {
    db.run("UPDATE risk_events SET resolved_at_ms = ? WHERE id = ?", [ts, row.id]);
  }
  db.run(
    `INSERT INTO risk_events (pool_id, pm_id, ts_ms, level, kind, metric, threshold, observed, action)
     VALUES (NULL, NULL, ?, 'L3', 'emergency_stop_reset', 'emergency_stop', 0, 0, ?)`,
    [ts, `manual_reset:${ackReason.trim()}`],
  );

  log.warn("risk/emergency: L3 emergency stops resolved in DB by operator", {
    ackReason,
    resolvedEventIds: rows.map((r) => r.id),
    ts,
  });

  return { resolvedEventIds: rows.map((r) => r.id) };
}
