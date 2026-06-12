import { getDb } from "../db/client.ts";
import { loadConfig } from "../config.ts";
import { getAgentAddress } from "../sui/keypair.ts";
import { getPositionManager, isAgentAuthorized } from "../sui/cdpm/read.ts";
import { getPoolState } from "../sui/pool.ts";
import { withLock } from "../lib/locks.ts";
import { log } from "../lib/logger.ts";
import { buildStrategy } from "../strategies/registry.ts";
import type { MlAgentDeps } from "../strategies/registry.ts";
import { saveFillBoundary } from "../strategies/positionState.ts";
import type { Strategy } from "../strategies/types.ts";
import { decide as routeLending } from "../sui/lending/router.ts";
import { canLend } from "../sui/lending/lendingConfig.ts";
import type { LendingDecision } from "../sui/lending/types.ts";
import { attemptCharge, refundCharge } from "../treasury/charges.ts";
import { estimateRebalanceCost } from "../treasury/credits.ts";
import { findUserBySuiAddress } from "../treasury/store.ts";
import type { SubscriptionsService } from "./subscriptions.ts";
import type { ExecutorService } from "./executor.ts";
import type { PriceFeed } from "../data/priceFeed.ts";
import type { RebalancePlan, PMState } from "../domain/types.ts";
import type { StateContext } from "../prediction/types.ts";

export interface RebalancerService {
  start(): () => void;
  tickOne(pmId: string): Promise<void>;
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
  mlDeps?: MlAgentDeps,
): number {
  // When mlAgent is active, the state machine drives evaluation timing.
  // `current()` is always callable — before the first `advance()` it returns
  // the machine's minimum viable NORMAL context.
  if (cfg.strategy === "mlAgent" && mlDeps) {
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

export function createRebalancerService(
  subscriptions: SubscriptionsService,
  executor: ExecutorService,
  priceFeed: PriceFeed,
  mlDeps?: MlAgentDeps,
): RebalancerService {
  const cfg = loadConfig();
  const strategy: Strategy = buildStrategy(cfg.strategy, mlDeps);
  log.info("rebalancer: strategy selected", { name: strategy.name });
  const agentAddress = getAgentAddress();

  // G2 fix: track last EVALUATION time per PM (not last succeeded rebalance).
  // The cooldown anchors on last evaluation so that a rapid crash 2 min after
  // a NORMAL tick does not wait ~18 more minutes for response. Per-PM map is
  // reset on restart (in-memory), which is safe: a fresh process simply evaluates
  // immediately on the first scheduler heartbeat.
  const lastEvalMs = new Map<string, number>();

  async function tickOne(pmId: string): Promise<void> {
    // Short correlation id so every log line + DB row produced by this tick
    // can be threaded together. Crockford-base32-ish — readable in journals.
    const tickId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await withLock(pmId, async () => {
      const db = getDb();

      // Effective cooldown — for mlAgent the state machine provides the interval.
      const effectiveCooldown = getEffectiveCooldownMs(cfg, mlDeps);

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
      const riskLevel = poolIdForPm && mlDeps
        ? mlDeps.riskMonitor.activeLevel(poolIdForPm)
        : null;
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

      // Authorization check. If we missed an AgentRemoved event (RPC hiccup),
      // hard-delete the row here too — matches subscriptions.ts behaviour so
      // we never carry a stale "active" subscription forward.
      const authorized = await isAgentAuthorized(pmId, agentAddress);
      if (!authorized) {
        log.warn("rebalancer: agent no longer authorized, dropping subscription", {
          tickId,
          pmId,
        });
        db.prepare(`DELETE FROM subscriptions WHERE pm_id = ?`).run(pmId);
        return;
      }

      // Fetch current state.
      const pm = await getPositionManager(pmId);
      const pool = await getPoolState(cfg.poolProfile.poolId);
      const spot = await priceFeed.getSpot();
      const history = await priceFeed.getHistory(5 * 60 * 1000); // 5-minute window

      // Strategy decision.
      const output = await strategy.plan({
        pm,
        pool,
        spot,
        history,
        profile: cfg.poolProfile,
      });

      // Quiet path: nothing to do.
      if (output.kind === "quiet") {
        log.debug("rebalancer: quiet tick", { tickId, pmId, reason: output.reason });
        return;
      }

      // Reconcile-only path: no rebalance PTB; just refresh lending state.
      if (output.kind === "reconcile_only") {
        log.info("rebalancer: reconcile-only tick", {
          tickId,
          pmId,
          reason: output.reason,
        });
        if (cfg.lending.enabled) {
          // For mlAgent, thread the state machine context so the router respects lendingPct.
          const stateBias = cfg.strategy === "mlAgent" && mlDeps
            ? mlDeps.stateMachine.current()
            : undefined;
          await deployIdleViaLending(pm, executor, stateBias);
        }
        return;
      }

      const plan = output.plan;
      const skipReconcile = output.kind === "plan_only";
      log.info("rebalancer: plan computed", {
        tickId,
        pmId,
        reason: plan.reason,
        kind: output.kind,
      });

      // ----------------------------------------------------------------
      // Treasury gate + pre-charge
      // ----------------------------------------------------------------
      // When TREASURY_ENABLED=true:
      //   - PM owner must be registered (or `TREASURY_REQUIRE_REGISTRATION=false`
      //     lets unregistered PMs through for free — useful in dev)
      //   - Pre-debit credits before submitting the PTB. On PTB failure we
      //     refund this nonce so the user pays only for executed work.
      let chargeNonce: string | null = null;
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

      // Persist the plan.
      const nowMs = Date.now();
      const insertResult = db
        .prepare(
          `INSERT INTO rebalances (pm_id, planned_at_ms, plan_json, status)
           VALUES (?, ?, ?, 'planned')`,
        )
        .run(pmId, nowMs, serializePlan(plan));

      const rebalanceId = insertResult.lastInsertRowid;

      // Snapshot the state machine context once for this tick (mlAgent only).
      const stateBias = cfg.strategy === "mlAgent" && mlDeps
        ? mlDeps.stateMachine.current()
        : undefined;

      let finalStatus: "succeeded" | "failed" = "succeeded";
      let finalDigest = "";
      let finalError: string | undefined;

      try {
        if (cfg.unifiedTx) {
          // Unified PTB path: DLMM ops (collect + remove + transfer + add)
          // run atomically. Lending stays as separate post-hoc transactions
          // so the post-add residual can be observed before sizing supplies.
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
          // Legacy multi-tx path. Preserved as the default until the unified
          // path is mainnet-validated. Flip UNIFIED_TX=true to use the
          // atomic single-PTB rebalance instead.

          // Step 1: collect + transfer fees if needed.
          if (plan.collectFees || pm.feeBag.a > 0n || pm.feeBag.b > 0n) {
            const feeResult = await executor.collectAndTransferFees(pmId, pm);
            if (feeResult.status === "failed") {
              throw new Error(feeResult.error ?? "collectAndTransferFees failed");
            }
          }

          // Step 2: remove old position.
          if (plan.removeShares.size > 0) {
            const removeResult = await executor.removeLiquidity(plan, pm);
            if (removeResult.status === "failed") {
              throw new Error(removeResult.error ?? "removeLiquidity failed");
            }
            finalDigest = removeResult.digest;
          }

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

          // Step 4: add new position.
          const addResult = await executor.addLiquidity(plan, freshPm);
          if (addResult.status === "failed") {
            throw new Error(addResult.error ?? "addLiquidity failed");
          }
          if (addResult.digest) finalDigest = addResult.digest;

          // Step 5: park residual idle balance into lending (skipped when the
          // strategy signalled plan_only — the strategy intends to keep the
          // idle balance free this tick).
          if (cfg.lending.enabled && !skipReconcile) {
            const postAddPm = await getPositionManager(pmId);
            const supplyDigest = await deployIdleViaLending(postAddPm, executor, stateBias);
            if (supplyDigest) finalDigest = supplyDigest;
          }
        }

        log.info("rebalancer: tick succeeded", {
          tickId,
          pmId,
          digest: finalDigest,
          path: cfg.unifiedTx ? "unified" : "legacy",
        });
      } catch (err: unknown) {
        finalStatus = "failed";
        finalError = err instanceof Error ? err.message : String(err);
        log.error("rebalancer: tick failed", { tickId, pmId, error: finalError });
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
  const inFlight = new Set<string>();

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
          inFlight.add(sub.pmId);
          fired += 1;
          tickOne(sub.pmId)
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              log.error("rebalancer: unhandled error in tickOne", { pmId: sub.pmId, error: msg });
            })
            .finally(() => {
              inFlight.delete(sub.pmId);
            });
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
  };
}
