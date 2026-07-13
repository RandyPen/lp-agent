import type { Database } from "bun:sqlite";
import { getDb } from "../db/client.ts";
import { loadConfig } from "../config.ts";
import { getAgentAddress } from "../sui/keypair.ts";
import { getPositionManager, isAgentAuthorized } from "../sui/cdpm/read.ts";
import { getPoolState } from "../sui/pool.ts";
import { withLock } from "../lib/locks.ts";
import { log } from "../lib/logger.ts";
import { buildStrategy, type StrategyName } from "../strategies/registry.ts";
import type { MlAgentDeps } from "../strategies/registry.ts";
import { saveFillBoundary } from "../strategies/positionState.ts";
import type { Strategy, StrategyInput, StrategyOutput } from "../strategies/types.ts";
import { buildExtremeWithdrawPlan } from "../decision/diffPlanner.ts";
import { rescalePlanToAvailable } from "../decision/planMath.ts";
import { validatePlan, formatViolations } from "../decision/planInvariants.ts";
import { syncLotsAfterRebalance } from "../decision/lotStore.ts";
import type { PnlService } from "./pnlService.ts";
import type { RiskMonitor } from "../risk/monitor.ts";
import { recordRegimeTransition } from "../state/regimeJournal.ts";
import { decide as routeLending } from "../sui/lending/router.ts";
import { canLend } from "../sui/lending/lendingConfig.ts";
import type { LendingDecision } from "../sui/lending/types.ts";
import { attemptCharge, refundCharge } from "../treasury/charges.ts";
import { estimateRebalanceCost } from "../treasury/credits.ts";
import { findUserBySuiAddress } from "../treasury/store.ts";
import type { SubscriptionsService } from "./subscriptions.ts";
import type { ExecutorService } from "./executor.ts";
import type { PriceFeed } from "../data/priceFeed.ts";
import type { RebalancePlan, PMState, PoolState, PriceObservation } from "../domain/types.ts";
import type { AlertDispatcher } from "../alerts/sinks.ts";
import type { MarketSnapshot, StateContext } from "../prediction/types.ts";
import { DataOutageError, type MarketAggregator } from "../data/marketAggregator.ts";

export interface RebalancerService {
  start(): () => void;
  tickOne(pmId: string): Promise<void>;
  /**
   * Resolve once every tick currently in flight (started by the interval
   * scheduled from `start()`) has settled — success or failure, already
   * caught internally, so `drain()` itself never rejects. Used by shutdown
   * to avoid abandoning a tick mid-PTB-submission (Fix 4).
   */
  drain(): Promise<void>;
}

/**
 * Startup reconciliation sweep for rebalances orphaned by a crash between the
 * pre-charge treasury debit (`attemptCharge`, ~line 560 above) and PTB
 * submission / the final status UPDATE. Without this, a crash there leaves
 * credits debited forever and the `rebalances` row stuck in 'planned'.
 *
 * MUST be called once at process startup, BEFORE the rebalance interval
 * starts (before `RebalancerService.start()` and before any tick fires).
 * Because nothing has ticked yet in THIS process, any row still in a
 * non-terminal status ('planned' or 'submitted' — see the `rebalances.status`
 * CHECK constraint in schema.sql) is by construction left over from a
 * PREVIOUS process that died mid-tick — there is no live-run row to
 * accidentally sweep.
 *
 * Ambiguity: a non-terminal row can mean either (a) the PTB never went out,
 * or (b) the PTB succeeded on-chain but the process crashed before the final
 * status UPDATE landed. Distinguishing these would require re-deriving
 * on-chain truth (out of scope here), so we always refund the pre-debited
 * charge when one is recorded (`refundCharge` is idempotent — a no-op when
 * the charge was never 'ok' or was already refunded). This can under-charge
 * a user in case (b); it can never permanently strand a debit or double-charge
 * — the correct failure direction for a custody agent.
 *
 * Schema note: `rebalances.status` has a CHECK(status IN (...)) constraint,
 * not a free-form TEXT column, and SQLite cannot ALTER a CHECK constraint
 * without a full table rebuild — which would violate this project's
 * additive-only schema policy (`ensureColumns` in src/db/client.ts). So
 * rather than introduce a new 'abandoned' enum value, reconciled rows are
 * marked with the existing terminal 'failed' status and a descriptive
 * `error` message.
 */
export function reconcileOrphanedRebalances(db: Database): {
  scanned: number;
  refunded: number;
} {
  const rows = db
    .query<{ id: number; pm_id: string; charge_nonce: string | null }, []>(
      `SELECT id, pm_id, charge_nonce FROM rebalances WHERE status IN ('planned', 'submitted')`,
    )
    .all();

  let refunded = 0;
  for (const row of rows) {
    let wasRefunded = false;
    if (row.charge_nonce) {
      wasRefunded = refundCharge(
        row.charge_nonce,
        "reconciled at startup: rebalance orphaned by a crash between pre-charge and PTB",
      );
      if (wasRefunded) refunded++;
    }
    db.prepare(`UPDATE rebalances SET status = 'failed', error = ? WHERE id = ?`).run(
      row.charge_nonce
        ? `abandoned: reconciled at startup after a crash (charge ${wasRefunded ? "refunded" : "not refunded — already settled"})`
        : "abandoned: reconciled at startup after a crash (no treasury charge to refund)",
      row.id,
    );
    log.warn("rebalancer: reconciled orphaned rebalance from a previous run", {
      rebalanceId: row.id,
      pmId: row.pm_id,
      chargeNonce: row.charge_nonce,
      refunded: wasRefunded,
    });
  }

  if (rows.length > 0) {
    log.warn("rebalancer: startup reconciliation swept orphaned rebalances", {
      scanned: rows.length,
      refunded,
    });
  } else {
    log.info("rebalancer: startup reconciliation found no orphaned rebalances");
  }

  return { scanned: rows.length, refunded };
}

/** JSON.stringify replacer that converts bigint to a string representation. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function serializePlan(plan: RebalancePlan): string {
  // Map is not directly serializable; convert to a plain object.
  const plain: Record<string, unknown> = {
    pmId: plan.pmId,
    removeShares: Object.fromEntries(
      Array.from(plan.removeShares.entries()).map(([k, v]) => [k.toString(), v]),
    ),
    addAmountA: plan.addAmountA,
    addAmountB: plan.addAmountB,
    addBins: plan.addBins,
    addAmountsA: plan.addAmountsA,
    addAmountsB: plan.addAmountsB,
    collectFees: plan.collectFees,
    reason: plan.reason,
    plannedActiveBinId: plan.plannedActiveBinId ?? null,
    priority: plan.priority ?? "normal",
  };
  return JSON.stringify(plain, bigintReplacer);
}

interface RebalanceRow {
  id: number;
  submitted_at_ms: number | null;
  status: string;
}

function recordLendingAction(
  decision: Extract<LendingDecision, { kind: "supply" | "redeem" }>,
  result: { status: "succeeded" | "failed"; digest: string; error?: string },
  plannedAtMs: number,
): void {
  const db = getDb();
  const amount = decision.kind === "supply" ? decision.amount : decision.marketCoinAmount;
  db.prepare(
    `INSERT INTO lending_actions
       (pm_id, protocol, action, coin_type, amount, digest, status, error, reason, planned_at_ms, submitted_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    decision.pmId,
    decision.protocol,
    decision.kind,
    decision.coinType,
    amount.toString(),
    result.digest || null,
    result.status,
    result.error ?? null,
    decision.reason,
    plannedAtMs,
    Date.now(),
  );
}

/**
 * Compute the effective cooldown for this strategy configuration. The mlAgent
 * strategy has a shorter default interval because the state machine drives
 * evaluation timing.
 */
export function getEffectiveCooldownMs(
  cfg: ReturnType<typeof loadConfig>,
  liveStrategyName: StrategyName,
  mlDeps?: MlAgentDeps,
): number {
  // When mlAgent is the LIVE strategy, the state machine drives evaluation
  // timing. `current()` is always callable — before the first `advance()` it
  // returns the machine's minimum viable NORMAL context. Note: this keys off
  // the live strategy, not cfg.strategy — in shadow mode the live strategy is
  // the fallback even when cfg.strategy === "mlAgent".
  if (liveStrategyName === "mlAgent" && mlDeps) {
    return mlDeps.stateMachine.current().evalIntervalMs;
  }
  return cfg.perPmCooldownMs;
}

/**
 * Redeem from lending if the next bin add needs more underlying than what's
 * left in `pm.balance` after honouring `minIdleBuffer`. Returns the digest of
 * the last successful redeem (or empty string when nothing was needed).
 */
async function coverShortfallViaLending(
  pm: PMState,
  plan: RebalancePlan,
  executor: ExecutorService,
  stateBias?: StateContext,
): Promise<string> {
  const cfg = loadConfig();
  const profile = cfg.poolProfile;

  const shortfallA = computeShortfall(plan.addAmountA, pm.balance.a, profile, pm.coinTypeA);
  const shortfallB = computeShortfall(plan.addAmountB, pm.balance.b, profile, pm.coinTypeB);

  if (shortfallA === 0n && shortfallB === 0n) return "";

  const routerStateBias = stateBias
    ? { targetLendingPct: stateBias.lendingPct }
    : undefined;

  const { decisions } = await routeLending({
    pm,
    profile,
    shortfall: { a: shortfallA, b: shortfallB },
    stateBias: routerStateBias,
  });

  let digest = "";
  for (const d of decisions) {
    if (d.kind !== "redeem") continue;
    log.info("rebalancer: redeeming from lending", {
      pmId: d.pmId, protocol: d.protocol, coinType: d.coinType, reason: d.reason,
    });
    const plannedAtMs = Date.now();
    const result = await executor.redeemFromLending(d);
    recordLendingAction(d, result, plannedAtMs);
    if (result.status === "failed") {
      throw new Error(result.error ?? "redeemFromLending failed");
    }
    if (result.digest) digest = result.digest;
  }
  return digest;
}

/**
 * Supply idle PM balance into the highest-APY enabled protocol. Returns the
 * digest of the last successful supply (or empty string when nothing was done).
 */
async function deployIdleViaLending(
  pm: PMState,
  executor: ExecutorService,
  stateBias?: StateContext,
): Promise<string> {
  const cfg = loadConfig();
  const profile = cfg.poolProfile;

  const routerStateBias = stateBias
    ? { targetLendingPct: stateBias.lendingPct }
    : undefined;

  const { decisions } = await routeLending({
    pm,
    profile,
    shortfall: { a: 0n, b: 0n },
    stateBias: routerStateBias,
  });

  let digest = "";
  for (const d of decisions) {
    if (d.kind !== "supply") continue;
    log.info("rebalancer: supplying to lending", {
      pmId: d.pmId, protocol: d.protocol, coinType: d.coinType, amount: d.amount, reason: d.reason,
    });
    const plannedAtMs = Date.now();
    const result = await executor.supplyToLending(d);
    recordLendingAction(d, result, plannedAtMs);
    if (result.status === "failed") {
      // Don't throw — supply failures shouldn't abort the rebalance.
      log.warn("rebalancer: supplyToLending failed (continuing)", {
        pmId: d.pmId, error: result.error,
      });
      continue;
    }
    if (result.digest) digest = result.digest;
  }
  return digest;
}

export function computeShortfall(
  needed: bigint,
  idle: bigint,
  profile: import("../pools/types.ts").PoolProfile,
  coinType: string,
): bigint {
  if (needed === 0n) return 0n;
  // Lendability driven by `lendingConfig.LENDING_OPPORTUNITIES` (mirrors cdpm_web).
  if (!canLend(coinType)) return 0n;
  const policy = profile.lendingPolicy[coinType];
  if (!policy) return 0n;
  const usable = idle > policy.minIdleBuffer ? idle - policy.minIdleBuffer : 0n;
  return needed > usable ? needed - usable : 0n;
}

export interface RebalancerOpts {
  /**
   * Risk monitor for the live path — REQUIRED. Risk controls apply to every
   * live strategy, not only mlAgent: the rebalancer runs the pre-tick veto
   * for rule-based strategies (mlAgent runs it internally) and trips the L3
   * latch on repeated tx failures.
   */
  riskMonitor: RiskMonitor;
  /**
   * The strategy that actually trades. Differs from cfg.strategy when shadow
   * mode is on with STRATEGY=mlAgent (live runs the fallback strategy).
   */
  liveStrategyName: StrategyName;
  /** ML dependency graph — required when liveStrategyName === "mlAgent". */
  mlDeps?: MlAgentDeps;
  /**
   * PnL accounting (D1). When present, every evaluated tick records a
   * `pnl_ticks` NAV sample (quiet ticks included — the 24h mark-to-market
   * window needs continuous coverage) and executed rebalances additionally
   * record fee income, treasury cost, and realized IL.
   */
  pnlService?: PnlService;
  /**
   * Where risk events are announced. Without it, every catastrophic state — L3
   * trips, chain outages, failed emergency exits — is visible only as a line on
   * stdout, and the human that L3's design depends on has no way to learn they
   * are needed.
   */
  alerts?: AlertDispatcher;
  /**
   * Market aggregator. When present, every tick passes the assembled
   * `MarketSnapshot` (derivatives, cross-asset, TVL, spread) to the strategy
   * via `StrategyInput.snapshot`.
   *
   * Previously this reached the strategy layer only through `MlAgentDeps`, so
   * only `mlAgent` could see anything richer than price. Threading it here
   * makes every strategy — including fork strategies — first-class.
   */
  marketAggregator?: MarketAggregator;
}

export function createRebalancerService(
  subscriptions: SubscriptionsService,
  executor: ExecutorService,
  priceFeed: PriceFeed,
  opts: RebalancerOpts,
): RebalancerService {
  const cfg = loadConfig();
  const { riskMonitor, liveStrategyName, mlDeps, pnlService, marketAggregator, alerts } = opts;
  const strategy: Strategy = buildStrategy(liveStrategyName, mlDeps);
  log.info("rebalancer: strategy selected", { name: strategy.name });
  const agentAddress = getAgentAddress();

  // G2 fix: track last EVALUATION time per PM (not last succeeded rebalance).
  // The cooldown anchors on last evaluation so that a rapid crash 2 min after
  // a NORMAL tick does not wait ~18 more minutes for response. Per-PM map is
  // reset on restart (in-memory), which is safe: a fresh process simply evaluates
  // immediately on the first scheduler heartbeat.
  const lastEvalMs = new Map<string, number>();

  // Consecutive on-chain failure counter per PM. Reaching
  // cfg.risk.l3.txFailureCount trips the L3 emergency stop — repeated tx
  // failures mean something is systematically wrong (RPC, contract upgrade,
  // corrupted plan math) and automation must stop until an operator looks.
  const consecutiveTxFailures = new Map<string, number>();
  /**
   * Consecutive CHAIN-READ failures per PM (RPC down, price feed unreachable).
   * Tracked separately from tx failures because a read failure means we could
   * not even evaluate — and because these used to be counted nowhere at all,
   * which made the data-outage L3 circuit unreachable during an outage.
   */
  const consecutiveReadFailures = new Map<string, number>();

  /**
   * Record a pnl_ticks NAV sample (D1). Accounting must never abort a tick —
   * failures are logged at error level and swallowed.
   */
  function recordPnlTick(args: {
    pm: PMState;
    spotPrice: number;
    feeIncomeUsd?: number;
    costCredits?: number;
    ilUsd?: number | null;
    marketState?: "NORMAL" | "TREND" | "EXTREME";
    rebalanceId?: number | null;
  }): void {
    if (!pnlService) return;
    try {
      pnlService.recordTick({
        poolId: args.pm.poolId || cfg.poolProfile.poolId,
        pmId: args.pm.pmId,
        tsMs: Date.now(),
        feeIncomeUsd: args.feeIncomeUsd ?? 0,
        costCredits: args.costCredits ?? 0,
        navUsd: pnlService.computeNavUsd(args.pm, args.spotPrice),
        ilUsd: args.ilUsd ?? null,
        marketState: args.marketState ?? null,
        rebalanceId: args.rebalanceId ?? null,
      });
    } catch (err: unknown) {
      log.error("rebalancer: pnl tick recording failed", {
        pmId: args.pm.pmId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function tickOne(pmId: string): Promise<void> {
    // Short correlation id so every log line + DB row produced by this tick
    // can be threaded together. Crockford-base32-ish — readable in journals.
    const tickId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await withLock(pmId, async () => {
      const db = getDb();

      // Effective cooldown — for mlAgent the state machine provides the interval.
      const effectiveCooldown = getEffectiveCooldownMs(cfg, liveStrategyName, mlDeps);

      // G2 fix: when L2 or L3 risk is active for the pool, bypass the eval-interval
      // cooldown so the next scheduler heartbeat evaluates immediately. We check the
      // risk level before the cooldown gate because the risk monitor only knows the
      // poolId (not pmId) at this point. We derive poolId from the subscriptions
      // cache; if missing we fall through to the normal cooldown path.
      //
      // Cooldown anchor: use lastEvalMs (last evaluation, successful or not) rather
      // than last succeeded rebalance. A failed or quiet tick still "used" the eval
      // slot — anchoring on last-success would re-evaluate immediately after every
      // quiet tick, defeating the cooldown.
      const poolIdForPm = subscriptions.listActive().find((s) => s.pmId === pmId)?.poolId;
      const riskLevel = poolIdForPm ? riskMonitor.activeLevel(poolIdForPm) : null;
      const riskActive = riskLevel === "L2" || riskLevel === "L3";

      const lastEval = lastEvalMs.get(pmId) ?? 0;
      const evalElapsed = Date.now() - lastEval;

      if (!riskActive && evalElapsed < effectiveCooldown) {
        log.debug("rebalancer: cooldown active, skipping tick", {
          tickId,
          pmId,
          remainingMs: effectiveCooldown - evalElapsed,
        });
        return;
      }

      if (riskActive) {
        log.debug("rebalancer: bypassing cooldown due to active risk level", {
          tickId,
          pmId,
          riskLevel,
        });
      }

      // Record this as an evaluation (before any early returns below, so even
      // authorization failures count as an evaluation attempt and don't cause
      // a tight loop on permanently-revoked PMs).
      lastEvalMs.set(pmId, Date.now());

      // ---- Chain read phase --------------------------------------------------
      //
      // These RPC calls used to sit OUTSIDE the try/catch that counts failures.
      // So during a Sui RPC outage the very first read threw, the tick unwound
      // to a bare `.catch(log)`, and NOTHING else ran: `checkPreTick` was never
      // reached, so `evaluateL3` never executed, so the `outage_with_position`
      // circuit — the circuit written for exactly this scenario — could not fire
      // during it. The agent would spin its interval for hours, logging an error
      // each time, tripping nothing, alerting no one, while the position drifted
      // out of range unmanaged.
      //
      // Count read failures like any other failure, and escalate.
      let authorized: boolean;
      let pm: PMState;
      let pool: PoolState;
      let spot: PriceObservation;
      let history: PriceObservation[];

      try {
        // Authorization check. If we missed an AgentRemoved event (RPC hiccup),
        // hard-delete the row here too — matches subscriptions.ts behaviour so
        // we never carry a stale "active" subscription forward.
        authorized = await isAgentAuthorized(pmId, agentAddress);
        if (!authorized) {
          log.warn("rebalancer: agent no longer authorized, dropping subscription", {
            tickId,
            pmId,
          });
          db.prepare(`DELETE FROM subscriptions WHERE pm_id = ?`).run(pmId);
          return;
        }

        pm = await getPositionManager(pmId);
        pool = await getPoolState(cfg.poolProfile.poolId);
        spot = await priceFeed.getSpot();
        // Window sized by the live strategy's declared need (presenceAnchor: 4h
        // for its anchor + vol-regime nowcast); default 5 minutes.
        history = await priceFeed.getHistory(strategy.historyWindowMs ?? 5 * 60 * 1000);

        consecutiveReadFailures.delete(pmId); // reads are healthy again
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const failures = (consecutiveReadFailures.get(pmId) ?? 0) + 1;
        consecutiveReadFailures.set(pmId, failures);

        log.error("rebalancer: chain/price read failed — cannot evaluate this tick", {
          tickId,
          pmId,
          error: msg,
          consecutiveFailures: failures,
          threshold: cfg.risk.l3.txFailureCount,
        });

        if (failures >= cfg.risk.l3.txFailureCount) {
          void alerts?.emit({
            severity: "critical",
            code: "chain_unreachable",
            message:
              `Chain/price reads have failed ${failures} times in a row. The agent cannot ` +
              `evaluate or exit the position — capital may be deployed and unmanaged.`,
            tsMs: Date.now(),
            pmId,
            poolId: cfg.poolProfile.poolId,
            fields: { error: msg, consecutiveFailures: failures },
          });

          // Trip L3. We cannot DRAIN — reading the PM is exactly what is
          // failing, so there is no way to build (let alone submit) a
          // withdrawal. Report the attempt as failed so the bounded counter
          // advances to HALTED and raises `l3_drain_failed`, which says the
          // true thing: automation is off and the position may still be
          // deployed. Silently retrying forever would be worse.
          riskMonitor.emergencyStop.trip(
            `chain unreachable: ${failures} consecutive read failures for pm ${pmId} (last: ${msg})`,
            { kind: "pm", pmId },
          );
          riskMonitor.emergencyStop.recordDrainAttempt(
            { pmId },
            {
              positionEmpty: false,
              pmId,
              error: `cannot read chain state: ${msg}`,
              // funds omitted: we could not read the PM, so we do not know.
            },
          );
        }
        return;
      }

      // Market snapshot for the strategy (derivatives, cross-asset, TVL, spread).
      //
      // `latest()` THROWS DataOutageError when an essential feed has never been
      // populated — deliberately, so nothing fabricates a snapshot from zeros.
      // That must not kill the tick: a rule-based strategy that only needs price
      // should still run during a derivatives outage. So we catch that ONE typed
      // error and pass `undefined`, which the contract defines as "not observed".
      // Any other error propagates. The risk layer independently watches feed
      // staleness (riskObserver → checkDataOutage) — degrading here does not hide
      // an outage from the circuits.
      let snapshot: MarketSnapshot | undefined;
      if (marketAggregator) {
        try {
          snapshot = marketAggregator.latest();
        } catch (err: unknown) {
          if (!(err instanceof DataOutageError)) throw err;
          log.warn("rebalancer: market snapshot unavailable, strategy runs on price only", {
            tickId,
            pmId,
            emptySources: err.emptySources,
          });
        }
      }

      const strategyInput: StrategyInput = {
        pm,
        pool,
        spot,
        history,
        profile: cfg.poolProfile,
        ...(snapshot !== undefined ? { snapshot } : {}),
      };

      // ---- L3 gate: applies to EVERY strategy, including mlAgent -------------
      //
      // Safety is not a strategy decision. This runs before the strategy branch
      // so mlAgent cannot keep trading while the emergency stop is draining.
      //
      //   HALTED   → nothing on-chain. Terminal until an operator resets.
      //   DRAINING → force-exit, bypassing the strategy entirely.
      //
      // `plan_only`, NOT `plan_and_reconcile`: an L3 drain must NOT sweep the
      // freed capital into Scallop/Kai. L3 means "something is systematically
      // broken", and the correct destination is the PositionManager balance —
      // where the OWNER can withdraw it without us — not a third-party lending
      // protocol whose health we do not monitor and whose withdrawals can be
      // paused. Get flat, stay in the PM.
      let output: StrategyOutput;
      let drainAttempt = false;

      const emergency = riskMonitor.emergencyStop;
      // Scoped: a latch on ANOTHER PM must not halt this one.
      const emCtx = { poolId: pm.poolId, pmId };

      if (emergency.isTripped(emCtx)) {
        log.warn("rebalancer: L3 HALTED — skipping tick", { tickId, pmId });
        return;
      }

      // Where the money actually is, so the drain alert can tell the truth
      // rather than assume "PM balance". After an L2 EXTREME swept 100% into
      // Scallop/Kai, "exited" means the DLMM position is gone — NOT that the
      // funds are sitting in the PM.
      const fundsNow = {
        balanceA: pm.balance.a,
        balanceB: pm.balance.b,
        lending: pm.lending,
      };

      if (emergency.isDraining(emCtx)) {
        const drainPlan = buildExtremeWithdrawPlan(pm, "L3 emergency drain: force-exit before halt");
        if (!drainPlan) {
          // No DLMM bins and no fees left: the price exposure L3 exists to
          // remove is already gone (typically because an L2 EXTREME withdrew
          // first). Capital may well be in lending — that is fine, and the
          // alert will say so.
          emergency.recordDrainAttempt(emCtx, { positionEmpty: true, pmId, funds: fundsNow });
          return;
        }
        drainPlan.priority = "emergency";
        drainAttempt = true;
        output = { kind: "plan_only", plan: drainPlan };
        log.error("rebalancer: L3 DRAINING — force-exiting the position", { tickId, pmId });
      } else if (strategy.name !== "mlAgent") {
        // Pre-tick risk veto for RULE-BASED strategies. mlAgent runs
        // checkPreTick internally (and persists its own veto rows), so running
        // it here too would double-persist; every other strategy has no risk
        // awareness at all and gets it from the rebalancer:
        //   L3 → handled above, plus the "drain" veto below for a trip that
        //        fires during THIS tick's evaluation.
        //   L2 → bypass the strategy entirely; issue the protective
        //        full-withdrawal plan (lendingPct 1.0 comes from the EXTREME
        //        semantics of deployIdleViaLending post-remove).
        //   L1 → log and proceed (rule strategies have no halfWidth knob).
        const veto = riskMonitor.checkPreTick(strategyInput);
        if (veto?.kind === "emergency") {
          log.warn("rebalancer: L3 HALTED — skipping tick", {
            tickId, pmId, reason: veto.reason,
          });
          return;
        }
        if (veto?.kind === "drain") {
          // L3 tripped during THIS tick's evaluation — start the exit now
          // rather than waiting for the next one.
          const drainPlan = buildExtremeWithdrawPlan(pm, `L3 emergency drain: ${veto.reason}`);
          if (!drainPlan) {
            emergency.recordDrainAttempt(emCtx, { positionEmpty: true, pmId, funds: fundsNow });
            return;
          }
          drainPlan.priority = "emergency";
          drainAttempt = true;
          output = { kind: "plan_only", plan: drainPlan };
          log.error("rebalancer: L3 tripped — force-exiting the position", {
            tickId, pmId, reason: veto.reason,
          });
        } else if (veto?.kind === "extreme") {
          const withdrawPlan = buildExtremeWithdrawPlan(
            pm,
            `EXTREME full withdrawal (L2, rule path): ${veto.trigger}`,
          );
          if (!withdrawPlan) {
            log.info("rebalancer: L2 EXTREME active but nothing to withdraw", {
              tickId, pmId, trigger: veto.trigger,
            });
            return;
          }
          log.warn("rebalancer: L2 EXTREME — issuing full withdrawal (rule path)", {
            tickId, pmId, trigger: veto.trigger,
          });
          output = { kind: "plan_and_reconcile", plan: withdrawPlan };
        } else {
          if (veto?.kind === "soft") {
            log.info("rebalancer: L1 soft circuit active (rule path — no adjustments applicable)", {
              tickId, pmId, reason: veto.reason,
            });
          }
          output = await strategy.plan(strategyInput);
        }
      } else {
        output = await strategy.plan(strategyInput);
      }

      // Quiet path: nothing to do on-chain — still sample NAV (the 24h
      // mark-to-market window needs continuous coverage).
      if (output.kind === "quiet") {
        log.debug("rebalancer: quiet tick", { tickId, pmId, reason: output.reason });
        recordPnlTick({ pm, spotPrice: Number(spot.price) });
        return;
      }

      // Regime journal for rule-based strategies that emit a StateContext
      // (presenceAnchor). mlAgent's state machine writes market_state_history
      // itself — recording here too would double-write.
      if (liveStrategyName !== "mlAgent" && output.stateCtx) {
        try {
          const reasonStr =
            output.kind === "reconcile_only" ? output.reason : output.plan.reason;
          recordRegimeTransition(
            db,
            pm.poolId,
            output.stateCtx.state,
            `presence: ${reasonStr.slice(0, 200)}`,
          );
        } catch (err) {
          // Journal writes must never veto a tick.
          log.warn("rebalancer: regime journal write failed (continuing)", {
            tickId, pmId, err: String(err),
          });
        }
      }

      // Reconcile-only path: no rebalance PTB; just refresh lending state.
      if (output.kind === "reconcile_only") {
        log.info("rebalancer: reconcile-only tick", {
          tickId,
          pmId,
          reason: output.reason,
        });
        if (cfg.lending.enabled) {
          // Prefer the strategy-emitted ctx (carries the L1 lending bonus);
          // fall back to the state machine's last advanced ctx for mlAgent.
          const stateBias = output.stateCtx ??
            (liveStrategyName === "mlAgent" && mlDeps
              ? mlDeps.stateMachine.current()
              : undefined);
          await deployIdleViaLending(pm, executor, stateBias);
        }
        recordPnlTick({
          pm,
          spotPrice: Number(spot.price),
          marketState: output.stateCtx?.state,
        });
        return;
      }

      let plan = output.plan;
      const skipReconcile = output.kind === "plan_only";
      log.info("rebalancer: plan computed", {
        tickId,
        pmId,
        reason: plan.reason,
        kind: output.kind,
      });

      // ----------------------------------------------------------------
      // Proceeds re-planning pass
      // ----------------------------------------------------------------
      // Strategies size their add amounts from the PRE-remove snapshot; the
      // capital freed by removeShares is invisible to them (per-bin position
      // amounts are 0n in v0 chain reads). Without this pass, every recenter
      // re-adds only the previously-idle balance and the removed principal
      // leaks into the lending sweep — for a fully-locked position the
      // "recenter" would silently CLOSE the LP position.
      //
      // Flow: dryRun the collect+remove prefix → exact freed amounts → apply
      // the safety haircut → re-run the (deterministic) strategy with
      // pm.positionValue injected so the plan's amounts include the freed
      // capital.
      //
      // Emergency (EXTREME full-withdrawal) plans still run the dryRun below
      // for `removeProceedsForIl` — realized IL of an emergency withdrawal is
      // the LARGEST IL event and must not be dropped from PnL attribution —
      // but skip the re-plan machinery entirely: emergency is a full
      // withdrawal (nothing to re-add) and EXTREME's 1-min cadence means the
      // extra strategy.plan() round-trip only costs latency for no benefit.
      let removeProceedsForIl: { a: bigint; b: bigint } | null = null;
      if (plan.removeShares.size > 0) {
        const proceeds = await executor.estimateRemoveProceeds(plan, pm);
        removeProceedsForIl = proceeds;
        if (plan.priority !== "emergency" && (proceeds.a > 0n || proceeds.b > 0n)) {
          const haircutBps = BigInt(cfg.readdProceedsHaircutBps);
          const positionValue = {
            a: proceeds.a - (proceeds.a * haircutBps) / 10_000n,
            b: proceeds.b - (proceeds.b * haircutBps) / 10_000n,
          };
          const enrichedOutput = await strategy.plan({
            ...strategyInput,
            pm: { ...pm, positionValue },
          });
          if (enrichedOutput.kind === "plan_and_reconcile" || enrichedOutput.kind === "plan_only") {
            plan = enrichedOutput.plan;
            log.info("rebalancer: re-planned with remove proceeds", {
              tickId,
              pmId,
              proceedsA: positionValue.a.toString(),
              proceedsB: positionValue.b.toString(),
              addAmountA: plan.addAmountA.toString(),
              addAmountB: plan.addAmountB.toString(),
            });
          } else {
            // A deterministic strategy going quiet on strictly-more capital is
            // unexpected — keep the original plan and say so loudly.
            log.warn("rebalancer: re-plan with proceeds returned no plan — keeping original", {
              tickId,
              pmId,
              rePlanKind: enrichedOutput.kind,
            });
          }
        }
      }

      // ----------------------------------------------------------------
      // Churn cap (C3)
      // ----------------------------------------------------------------
      // The risk-active cooldown bypass above means a flapping L2 boundary
      // could drive a rebalance every heartbeat — each costing gas and a
      // treasury charge. Cap NON-emergency executions per rolling hour,
      // counting every rebalances row (failed attempts burned resources too).
      // EXTREME full-withdrawals (priority=emergency) are always exempt.
      // Placed BEFORE the treasury charge so capped ticks never debit users.
      if (plan.priority !== "emergency") {
        const oneHourAgo = Date.now() - 3_600_000;
        const row = db
          .prepare<{ n: number }, [string, number]>(
            `SELECT COUNT(*) AS n FROM rebalances WHERE pm_id = ? AND planned_at_ms >= ?`,
          )
          .get(pmId, oneHourAgo);
        const recentCount = row?.n ?? 0;
        if (recentCount >= cfg.rebalanceMaxPerHour) {
          log.warn("rebalancer: churn cap reached — skipping non-emergency rebalance", {
            tickId,
            pmId,
            recentCount,
            cap: cfg.rebalanceMaxPerHour,
          });
          return;
        }
      }

      // ----------------------------------------------------------------
      // Treasury gate + pre-charge
      // ----------------------------------------------------------------
      // When TREASURY_ENABLED=true:
      //   - PM owner must be registered (or `TREASURY_REQUIRE_REGISTRATION=false`
      //     lets unregistered PMs through for free — useful in dev)
      //   - Pre-debit credits before submitting the PTB. On PTB failure we
      //     refund this nonce so the user pays only for executed work.
      let chargeNonce: string | null = null;
      let chargedCredits = 0;
      if (cfg.treasury.enabled) {
        const registered = findUserBySuiAddress(pm.owner) !== null;
        if (!registered && cfg.treasury.requireRegistration) {
          log.info("rebalancer: skipping — PM owner not registered with treasury", {
            tickId,
            pmId,
            owner: pm.owner,
          });
          return;
        }
        if (registered) {
          const cost = estimateRebalanceCost({
            plan,
            profile: cfg.poolProfile,
            spotPriceUsdcPerA: Number(spot.price),
            cfg: cfg.treasury,
          });
          if (cost > 0) {
            const charge = attemptCharge({
              suiAddress: pm.owner,
              pmId,
              cost,
              nonce: `${tickId}:${pmId}`,
              memo: `rebalance volA=${plan.addAmountA} volB=${plan.addAmountB}`,
            });
            if (!charge.ok) {
              log.warn("rebalancer: skipping — treasury charge rejected", {
                tickId,
                pmId,
                owner: pm.owner,
                cost,
                error: charge.error,
              });
              return;
            }
            chargeNonce = charge.chargeNonce;
            chargedCredits = cost;
          }
        }
      }

      // Persist fillBoundary when the strategy emitted one. Used by bid-ask /
      // only-bid / only-sell strategies (v2) to freeze a price interval at
      // target = 0 across rebalances; v0 strategies don't emit it.
      if (output.fillBoundary !== undefined) {
        try {
          saveFillBoundary(pmId, output.fillBoundary, strategy.name);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn("rebalancer: failed to persist fillBoundary", { pmId, error: msg });
        }
      }

      // Persist the plan. `charge_nonce` (nullable — treasury may be
      // disabled, or cost may be 0) lets the startup reconciliation sweep
      // (see `reconcileOrphanedRebalances` below) correlate this row back to
      // its pre-debited charge if the process dies before this tick completes.
      const nowMs = Date.now();
      const insertResult = db
        .prepare(
          `INSERT INTO rebalances (pm_id, planned_at_ms, plan_json, status, charge_nonce)
           VALUES (?, ?, ?, 'planned', ?)`,
        )
        .run(pmId, nowMs, serializePlan(plan), chargeNonce);

      const rebalanceId = insertResult.lastInsertRowid;

      // Snapshot the state context once for this tick. The strategy-emitted
      // ctx (output.stateCtx) is authoritative — it carries the advance()-
      // derived lendingPct including the TREND ramp and the L1 soft-circuit
      // bonus. current() is the fallback (last advanced ctx, no L1 bonus).
      const stateBias = output.stateCtx ??
        (liveStrategyName === "mlAgent" && mlDeps
          ? mlDeps.stateMachine.current()
          : undefined);

      let finalStatus: "succeeded" | "failed" = "succeeded";
      let finalDigest = "";
      let finalError: string | undefined;

      try {
        // Client-side slippage check: the per-bin split is priced for the
        // planned active bin. Re-fetch the pool right before submitting and
        // abort when it drifted beyond tolerance — the on-chain guard would
        // abort anyway, this saves the gas and gives a clean journal entry.
        if (
          plan.plannedActiveBinId !== undefined &&
          plan.addBins.length > 0 &&
          (plan.addAmountA > 0n || plan.addAmountB > 0n)
        ) {
          const poolNow = await getPoolState(cfg.poolProfile.poolId);
          const drift = Math.abs(poolNow.activeBinId - plan.plannedActiveBinId);
          if (drift > cfg.slippageMaxBinDrift) {
            throw new Error(
              `active bin drifted ${drift} bins (planned ${plan.plannedActiveBinId}, now ${poolNow.activeBinId}, max ${cfg.slippageMaxBinDrift}) between plan and execution`,
            );
          }
        }

        // Physical-validity guard: refuse to submit a plan that breaks the
        // DLMM's own rules (wrong-side placement, active-bin placement, per-bin
        // amounts that don't sum to the declared totals).
        //
        // This exists because the framework now runs strategies it did not
        // write. A fork strategy with an inverted side-split would otherwise
        // place a user's liquidity on the wrong side of the market and lose real
        // money — this repo shipped exactly that bug once, unnoticed, because
        // nothing asserted plan shape. We fail loudly rather than "fixing" the
        // plan: a strategy that emits invalid plans is broken, and quietly
        // rewriting its intent would hide that.
        if (plan.addBins.length > 0) {
          const violations = validatePlan(
            plan,
            cfg.poolProfile,
            plan.plannedActiveBinId ?? pool.activeBinId,
          );
          if (violations.length > 0) {
            log.error("rebalancer: strategy produced a physically invalid plan — refusing to submit", {
              tickId,
              pmId,
              strategy: strategy.name,
              violations: violations.map((v) => v.code),
            });
            throw new Error(
              `strategy '${strategy.name}' produced an invalid RebalancePlan:\n` +
                formatViolations(violations),
            );
          }
        }

        if (cfg.unifiedTx) {
          // Unified PTB path (the default): DLMM ops (collect + remove +
          // transfer + add) run atomically. Lending stays as separate
          // post-hoc transactions so the post-add residual can be observed
          // before sizing supplies.
          const unifiedResult = await executor.submitUnifiedRebalance({
            plan,
            pm,
            lendingDecisions: [],
          });
          if (unifiedResult.status === "failed") {
            throw new Error(unifiedResult.error ?? "submitUnifiedRebalance failed");
          }
          if (unifiedResult.digest) finalDigest = unifiedResult.digest;

          if (cfg.lending.enabled && !skipReconcile) {
            const postPm = await getPositionManager(pmId);
            const supplyDigest = await deployIdleViaLending(postPm, executor, stateBias);
            if (supplyDigest) finalDigest = supplyDigest;
          }
        } else {
          // Legacy multi-tx path (opt-out via UNIFIED_TX=false). NON-ATOMIC:
          // a failed add after a successful remove leaves the position closed
          // — see the recovery handling below.

          // Step 1: collect + transfer fees if needed.
          if (plan.collectFees || pm.feeBag.a > 0n || pm.feeBag.b > 0n) {
            const feeResult = await executor.collectAndTransferFees(pmId, pm);
            if (feeResult.status === "failed") {
              throw new Error(feeResult.error ?? "collectAndTransferFees failed");
            }
          }

          // Step 2: remove old position.
          let removedOk = false;
          if (plan.removeShares.size > 0) {
            const removeResult = await executor.removeLiquidity(plan, pm);
            if (removeResult.status === "failed") {
              throw new Error(removeResult.error ?? "removeLiquidity failed");
            }
            removedOk = true;
            finalDigest = removeResult.digest;
          }

          try {
            // Step 3: re-fetch PM to get updated balances after remove + fee transfer.
            let freshPm = await getPositionManager(pmId);

            // Step 3.5: cover any shortfall for the planned add by redeeming from lending.
            if (cfg.lending.enabled) {
              const redeemDigest = await coverShortfallViaLending(freshPm, plan, executor, stateBias);
              if (redeemDigest) {
                finalDigest = redeemDigest;
                freshPm = await getPositionManager(pmId);
              }
            }

            // Step 4: add new position. The plan is re-scaled to the REAL
            // post-remove balances (exact — no estimate needed on this path);
            // the pre-remove plan's amounts already target balance+proceeds,
            // this trues them up to what actually landed.
            const execPlan = rescalePlanToAvailable(plan, freshPm.balance.a, freshPm.balance.b);
            const addResult = await executor.addLiquidity(execPlan, freshPm);
            if (addResult.status === "failed") {
              throw new Error(addResult.error ?? "addLiquidity failed");
            }
            if (addResult.digest) finalDigest = addResult.digest;
          } catch (addErr: unknown) {
            // Recovery: the remove landed but the re-add (or a step before
            // it) failed — the position is CLOSED and the freed capital sits
            // idle. Best-effort sweep it into lending so it at least earns
            // until the next tick recenters; then rethrow so the tick is
            // recorded failed and the treasury charge refunded.
            if (removedOk) {
              const msg = addErr instanceof Error ? addErr.message : String(addErr);
              log.error(
                "rebalancer: LEGACY ADD FAILED AFTER REMOVE — position closed, sweeping idle capital to lending",
                { tickId, pmId, error: msg },
              );
              if (cfg.lending.enabled) {
                try {
                  const strandedPm = await getPositionManager(pmId);
                  await deployIdleViaLending(strandedPm, executor, stateBias);
                } catch (sweepErr: unknown) {
                  log.error("rebalancer: post-failure lending sweep also failed", {
                    tickId,
                    pmId,
                    error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
                  });
                }
              }
            }
            throw addErr;
          }

          // Step 5: park residual idle balance into lending (skipped when the
          // strategy signalled plan_only — the strategy intends to keep the
          // idle balance free this tick).
          if (cfg.lending.enabled && !skipReconcile) {
            const postAddPm = await getPositionManager(pmId);
            const supplyDigest = await deployIdleViaLending(postAddPm, executor, stateBias);
            if (supplyDigest) finalDigest = supplyDigest;
          }
        }

        consecutiveTxFailures.delete(pmId);
        log.info("rebalancer: tick succeeded", {
          tickId,
          pmId,
          digest: finalDigest,
          path: cfg.unifiedTx ? "unified" : "legacy",
        });

        // Reconcile the age-stop-loss lot book (C2). Carries lot age + cost
        // basis forward across the full rebuild — see lotStore.ts. A failure
        // here must not mask the succeeded rebalance, but must be loud.
        try {
          syncLotsAfterRebalance(db, pmId, plan, Number(spot.price), Date.now());
        } catch (lotErr: unknown) {
          log.error("rebalancer: lot bookkeeping failed after succeeded rebalance", {
            tickId,
            pmId,
            error: lotErr instanceof Error ? lotErr.message : String(lotErr),
          });
        }

        // PnL accounting (D1/D2): realized IL from the remove (hold-value of
        // the entry vs the dryRun-estimated proceeds, both at the current
        // spot), then refresh the entry snapshot to what was just deployed,
        // then record the tick with fees + treasury cost + fresh NAV.
        if (pnlService) {
          try {
            const spotPrice = Number(spot.price);
            const ilUsd =
              removeProceedsForIl !== null
                ? pnlService.computeIlUsd(pmId, removeProceedsForIl, spotPrice)
                : null;
            const feeIncomeUsd = plan.collectFees
              ? pnlService.valuePhysicalUsd(pm.feeBag.a, pm.feeBag.b, spotPrice)
              : 0;
            pnlService.snapshotEntry(pmId, plan, spotPrice, Date.now());
            const postPm = await getPositionManager(pmId);
            recordPnlTick({
              pm: postPm,
              spotPrice,
              feeIncomeUsd,
              costCredits: chargedCredits,
              ilUsd,
              marketState: output.stateCtx?.state,
              rebalanceId: Number(rebalanceId),
            });
          } catch (pnlErr: unknown) {
            log.error("rebalancer: pnl accounting failed after succeeded rebalance", {
              tickId,
              pmId,
              error: pnlErr instanceof Error ? pnlErr.message : String(pnlErr),
            });
          }
        }
      } catch (err: unknown) {
        finalStatus = "failed";
        finalError = err instanceof Error ? err.message : String(err);
        log.error("rebalancer: tick failed", { tickId, pmId, error: finalError });

        // A failed DRAIN is the dangerous case: we are trying to get flat and
        // cannot. Advance the bounded attempt counter — once exhausted, the
        // emergency stop goes HALTED and raises `l3_drain_failed` (position
        // still deployed, automation off, human needed now).
        if (drainAttempt) {
          riskMonitor.emergencyStop.recordDrainAttempt(
            { poolId: pm.poolId, pmId },
            { positionEmpty: false, pmId, error: finalError, funds: fundsNow },
          );
        }

        // L3 escalation on repeated failures: something is systematically
        // broken (RPC, contract, plan math) — start the emergency exit.
        const failures = (consecutiveTxFailures.get(pmId) ?? 0) + 1;
        consecutiveTxFailures.set(pmId, failures);
        if (failures >= cfg.risk.l3.txFailureCount) {
          // PM scope: one user's malformed position, dust plan, or revoked
          // authorization must not force-exit every other user's position.
          riskMonitor.emergencyStop.trip(
            `${failures} consecutive failed rebalance attempts for pm ${pmId} (last: ${finalError})`,
            { kind: "pm", pmId },
          );
        }

        // On PTB failure, refund the pre-debited credits so the user only
        // pays for executed work.
        if (chargeNonce) {
          try {
            refundCharge(chargeNonce, finalError);
          } catch (refundErr: unknown) {
            const msg = refundErr instanceof Error ? refundErr.message : String(refundErr);
            log.warn("rebalancer: refundCharge failed", { tickId, pmId, error: msg });
          }
        }
      }

      // A drain PTB that landed removed every bin (buildExtremeWithdrawPlan
      // withdraws the whole position), so the position is now flat: go HALTED
      // with `l3_drained` — capital sits in the PositionManager balance, where
      // the owner can withdraw it without us.
      if (drainAttempt && finalStatus === "succeeded") {
        // The withdraw PTB landed, so every bin is gone. Re-read balances is not
        // needed for safety (exposure is what matters) but the freed principal is
        // now in the PM balance — reflect that in the alert.
        riskMonitor.emergencyStop.recordDrainAttempt(
          { poolId: pm.poolId, pmId },
          {
            positionEmpty: true,
            pmId,
            funds: {
              balanceA: fundsNow.balanceA + (pm.positionValue?.a ?? 0n),
              balanceB: fundsNow.balanceB + (pm.positionValue?.b ?? 0n),
              lending: pm.lending,
            },
          },
        );
      }

      // Update the rebalance row.
      db.prepare(
        `UPDATE rebalances
         SET status = ?, submitted_at_ms = ?, digest = ?, error = ?
         WHERE id = ?`,
      ).run(finalStatus, Date.now(), finalDigest || null, finalError ?? null, rebalanceId);
    });
  }

  // Track in-flight ticks per PM so a new interval doesn't fire fresh ticks
  // for PMs whose previous tick is still running (e.g., a slow Anthropic
  // brief call inside a strategy). `withLock` already serializes one PM, but
  // pre-filtering here avoids piling promises on the event loop.
  //
  // Maps pmId -> the SETTLED tracking promise (catch+finally already
  // attached, so it always fulfills — never rejects) so `drain()` can
  // `Promise.all` the in-flight set without needing per-tick error handling
  // of its own (Fix 4: shutdown must not abandon a tick mid-PTB-submission).
  const inFlight = new Map<string, Promise<void>>();

  return {
    start(): () => void {
      const handle = setInterval(() => {
        const subs = subscriptions.listActive();
        const skipped: string[] = [];
        let fired = 0;
        for (const sub of subs) {
          if (inFlight.has(sub.pmId)) {
            skipped.push(sub.pmId);
            continue;
          }
          fired += 1;
          const settled = tickOne(sub.pmId)
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              log.error("rebalancer: unhandled error in tickOne", { pmId: sub.pmId, error: msg });
            })
            .finally(() => {
              inFlight.delete(sub.pmId);
            });
          inFlight.set(sub.pmId, settled);
        }
        log.debug("rebalancer: interval tick", {
          activeSubs: subs.length,
          fired,
          skippedInFlight: skipped.length,
        });
      }, cfg.rebalanceIntervalMs);

      return () => clearInterval(handle);
    },

    tickOne,

    drain(): Promise<void> {
      return Promise.all(Array.from(inFlight.values())).then(() => undefined);
    },
  };
}
