import { getDb } from "../db/client.ts";
import { loadConfig } from "../config.ts";
import { getAgentAddress } from "../sui/keypair.ts";
import { getPositionManager, isAgentAuthorized } from "../sui/cdpm/read.ts";
import { getPoolState } from "../sui/pool.ts";
import { withLock } from "../lib/locks.ts";
import { log } from "../lib/logger.ts";
import { createSingleBinStrategy } from "../strategies/singleBin.ts";
import type { SubscriptionsService } from "./subscriptions.ts";
import type { ExecutorService } from "./executor.ts";
import type { PriceFeed } from "../data/priceFeed.ts";
import type { RebalancePlan } from "../domain/types.ts";

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

export function createRebalancerService(
  subscriptions: SubscriptionsService,
  executor: ExecutorService,
  priceFeed: PriceFeed,
): RebalancerService {
  const cfg = loadConfig();
  const strategy = createSingleBinStrategy();
  const agentAddress = getAgentAddress();

  async function tickOne(pmId: string): Promise<void> {
    await withLock(pmId, async () => {
      const db = getDb();

      // Cooldown check: look at the most recent succeeded rebalance.
      const lastRow = db
        .query<RebalanceRow, [string]>(
          `SELECT id, submitted_at_ms, status
           FROM rebalances
           WHERE pm_id = ? AND status = 'succeeded'
           ORDER BY planned_at_ms DESC
           LIMIT 1`,
        )
        .get(pmId);

      if (lastRow && lastRow.submitted_at_ms !== null) {
        const elapsed = Date.now() - lastRow.submitted_at_ms;
        if (elapsed < cfg.perPmCooldownMs) {
          log.debug("rebalancer: cooldown active, skipping tick", {
            pmId,
            remainingMs: cfg.perPmCooldownMs - elapsed,
          });
          return;
        }
      }

      // Authorization check.
      const authorized = await isAgentAuthorized(pmId, agentAddress);
      if (!authorized) {
        log.warn("rebalancer: agent no longer authorized, revoking subscription", { pmId });
        db.prepare(
          `UPDATE subscriptions SET status = 'revoked', removed_at_ms = ? WHERE pm_id = ?`,
        ).run(Date.now(), pmId);
        return;
      }

      // Fetch current state.
      const pm = await getPositionManager(pmId);
      const pool = await getPoolState(cfg.poolProfile.poolId);
      const spot = await priceFeed.getSpot();
      const history = await priceFeed.getHistory(5 * 60 * 1000); // 5-minute window

      // Strategy decision.
      const plan = strategy.plan({
        pm,
        pool,
        spot,
        history,
        profile: cfg.poolProfile,
      });

      if (!plan) {
        log.debug("rebalancer: strategy returned null, no action", { pmId });
        return;
      }

      log.info("rebalancer: plan computed", { pmId, reason: plan.reason });

      // Persist the plan.
      const nowMs = Date.now();
      const insertResult = db
        .prepare(
          `INSERT INTO rebalances (pm_id, planned_at_ms, plan_json, status)
           VALUES (?, ?, ?, 'planned')`,
        )
        .run(pmId, nowMs, serializePlan(plan));

      const rebalanceId = insertResult.lastInsertRowid;

      let finalStatus: "succeeded" | "failed" = "succeeded";
      let finalDigest = "";
      let finalError: string | undefined;

      try {
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
        const freshPm = await getPositionManager(pmId);

        // Step 4: add new position.
        const addResult = await executor.addLiquidity(plan, freshPm);
        if (addResult.status === "failed") {
          throw new Error(addResult.error ?? "addLiquidity failed");
        }
        if (addResult.digest) finalDigest = addResult.digest;

        log.info("rebalancer: tick succeeded", { pmId, digest: finalDigest });
      } catch (err: unknown) {
        finalStatus = "failed";
        finalError = err instanceof Error ? err.message : String(err);
        log.error("rebalancer: tick failed", { pmId, error: finalError });
      }

      // Update the rebalance row.
      db.prepare(
        `UPDATE rebalances
         SET status = ?, submitted_at_ms = ?, digest = ?, error = ?
         WHERE id = ?`,
      ).run(finalStatus, Date.now(), finalDigest || null, finalError ?? null, rebalanceId);
    });
  }

  return {
    start(): () => void {
      const handle = setInterval(async () => {
        const subs = subscriptions.listActive();
        log.debug("rebalancer: interval tick", { activeSubs: subs.length });

        // Fire off all PM ticks concurrently — each is internally serialized by withLock.
        for (const sub of subs) {
          tickOne(sub.pmId).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("rebalancer: unhandled error in tickOne", { pmId: sub.pmId, error: msg });
          });
        }
      }, cfg.rebalanceIntervalMs);

      return () => clearInterval(handle);
    },

    tickOne,
  };
}
