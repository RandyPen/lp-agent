import { getSuiClient, type SuiClient } from "../sui/client.ts";
import { getAgentKeypair, getAgentAddress } from "../sui/keypair.ts";
import { submitWithRetry } from "../sui/submit.ts";
import {
  buildCollectFeeTx,
  buildTransferFeeToBalanceTx,
  buildRemoveLiquidityTx,
  buildAddLiquidityTx,
} from "../sui/cdpm/tx.ts";
import {
  buildScallopSupplyTx,
  buildScallopRedeemTx,
  buildKaiSupplyTx,
  buildKaiRedeemTx,
} from "../sui/cdpm/tx_lending.ts";
import {
  buildRemoveProbeTx,
  buildUnifiedRebalanceTx,
  type UnifiedRebalanceInput,
} from "../sui/cdpm/txUnified.ts";
import { decodeEvent } from "../sui/cdpm/events.ts";
import { log } from "../lib/logger.ts";
import type { PMState, RebalancePlan, ExecutionResult } from "../domain/types.ts";
import type { LendingDecision } from "../sui/lending/types.ts";
import type { Transaction } from "@mysten/sui/transactions";

export interface ExecutorService {
  collectAndTransferFees(pmId: string, pm: PMState): Promise<ExecutionResult>;
  removeLiquidity(plan: RebalancePlan, pm: PMState): Promise<ExecutionResult>;
  addLiquidity(plan: RebalancePlan, pm: PMState): Promise<ExecutionResult>;
  supplyToLending(decision: Extract<LendingDecision, { kind: "supply" }>): Promise<ExecutionResult>;
  redeemFromLending(decision: Extract<LendingDecision, { kind: "redeem" }>): Promise<ExecutionResult>;
  /**
   * Submit a single PTB that bundles fee collection, remove, transfer,
   * lending redeems, add, and lending supplies in the canonical order.
   * Atomic on success; reverts everything on failure. Returns the digest and
   * any decoded agent events.
   */
  submitUnifiedRebalance(input: UnifiedRebalanceInput): Promise<ExecutionResult>;
  /**
   * DryRun the plan's collect+remove prefix and decode the exact amounts the
   * remove would free (from the AgentLiquidityRemoved event). Used by the
   * unified path to include just-removed capital in the add amounts —
   * per-bin position amounts are 0n in v0 chain reads, so this dryRun is the
   * only reliable estimator. Returns {0n, 0n} when the plan removes nothing.
   * Throws on dryRun failure (fail loud — the caller decides whether to
   * proceed without the proceeds).
   */
  estimateRemoveProceeds(plan: RebalancePlan, pm: PMState): Promise<{ a: bigint; b: bigint }>;
}

export interface ExecutorDeps {
  /** Injectable Sui client (tests). Defaults to the shared singleton. */
  client?: SuiClient;
}

/**
 * Decode the freed amounts from a remove-probe dryRun result (pure — split
 * out from estimateRemoveProceeds for unit testing). Sums every
 * AgentLiquidityRemoved event; throws when the dryRun did not succeed.
 */
export function decodeRemoveProceedsFromDryRun(
  dryRun: unknown,
  pmId: string,
): { a: bigint; b: bigint } {
  const status = (dryRun as { effects?: { status?: { status?: string; error?: string } } })
    .effects?.status;
  if (status?.status !== "success") {
    throw new Error(
      `estimateRemoveProceeds: dryRun failed for pm ${pmId}: ${status?.error ?? "unknown"}`,
    );
  }

  let a = 0n;
  let b = 0n;
  for (const rawEv of (dryRun as { events?: Array<unknown> | null }).events ?? []) {
    const decoded = decodeEvent(rawEv);
    if (decoded?.payload.name === "AgentLiquidityRemoved") {
      a += decoded.payload.data.amountA;
      b += decoded.payload.data.amountB;
    }
  }
  return { a, b };
}

/** Extract the Move event types that were emitted by our agent address (or for this PM). */
function extractAgentEvents(
  raw: { events?: Array<unknown> | null },
  agentAddress: string,
  pmId: string,
): string[] {
  const types: string[] = [];
  for (const rawEv of raw.events ?? []) {
    const decoded = decodeEvent(rawEv);
    if (!decoded) continue;

    const { payload } = decoded;
    let matches = false;

    if ("data" in payload) {
      const data = payload.data as unknown as Record<string, unknown>;
      if (
        ("by" in data && data["by"] === agentAddress) ||
        ("pm_id" in data && data["pm_id"] === pmId)
      ) {
        matches = true;
      }
    }

    if (matches) {
      types.push(decoded.type);
    }
  }
  return types;
}

export function createExecutorService(deps: ExecutorDeps = {}): ExecutorService {
  const client = deps.client ?? getSuiClient();
  const agentAddress = getAgentAddress();

  /** Submit with idempotent retry (build once, sign once, resubmit same bytes). */
  function submit(tx: Transaction) {
    return submitWithRetry(client, tx, getAgentKeypair());
  }

  async function runLendingTx(
    pmId: string,
    op: "supply" | "redeem",
    built: { tx: Transaction; description: string },
  ): Promise<ExecutionResult> {
    log.info(`executor: ${op}ToLending`, { pmId, description: built.description });
    try {
      const result = await submit(built.tx);
      log.info(`executor: ${op}ToLending executed`, { pmId, digest: result.digest });
      return {
        pmId,
        digest: result.digest,
        status: "succeeded",
        emittedAgentEvents: extractAgentEvents(result, agentAddress, pmId),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`executor: ${op}ToLending failed`, { pmId, error: msg });
      return { pmId, digest: "", status: "failed", error: msg, emittedAgentEvents: [] };
    }
  }

  return {
    async collectAndTransferFees(pmId: string, pm: PMState): Promise<ExecutionResult> {
      // Skip when there are truly no fees and the plan doesn't require collection.
      if (pm.feeBag.a === 0n && pm.feeBag.b === 0n) {
        return {
          pmId,
          digest: "",
          status: "succeeded",
          emittedAgentEvents: [],
        };
      }

      try {
        // Collect fee first.
        const { tx: collectTx, description: collectDesc } = buildCollectFeeTx({
          pmId,
          poolId: pm.poolId,
          coinTypeA: pm.coinTypeA,
          coinTypeB: pm.coinTypeB,
        });

        log.info("executor: collectAndTransferFees", { pmId, description: collectDesc });

        const collectResult = await submit(collectTx);

        log.info("executor: collect fee executed", { pmId, digest: collectResult.digest });

        // Transfer each non-zero side back to balance.
        const transferResults: ExecutionResult[] = [];

        for (const [coinType, amount] of [
          [pm.coinTypeA, pm.feeBag.a] as const,
          [pm.coinTypeB, pm.feeBag.b] as const,
        ]) {
          if (amount === 0n) continue;

          const { tx: transferTx, description: transferDesc } = buildTransferFeeToBalanceTx({
            pmId,
            coinType,
            amount,
          });

          log.info("executor: transferFeeToBalance", { pmId, description: transferDesc });

          const transferResult = await submit(transferTx);

          log.info("executor: transfer fee executed", { pmId, digest: transferResult.digest });

          transferResults.push({
            pmId,
            digest: transferResult.digest,
            status: "succeeded",
            emittedAgentEvents: extractAgentEvents(transferResult, agentAddress, pmId),
          });
        }

        const allEvents = [
          ...extractAgentEvents(collectResult, agentAddress, pmId),
          ...transferResults.flatMap((r) => r.emittedAgentEvents),
        ];

        // Return the collect digest as the primary; transfer digests are logged.
        return {
          pmId,
          digest: collectResult.digest,
          status: "succeeded",
          emittedAgentEvents: allEvents,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("executor: collectAndTransferFees failed", { pmId, error: msg });
        return { pmId, digest: "", status: "failed", error: msg, emittedAgentEvents: [] };
      }
    },

    async removeLiquidity(plan: RebalancePlan, pm: PMState): Promise<ExecutionResult> {
      if (plan.removeShares.size === 0) {
        return { pmId: plan.pmId, digest: "", status: "succeeded", emittedAgentEvents: [] };
      }

      const bins: number[] = [];
      const shares: bigint[] = [];
      for (const [binId, share] of plan.removeShares) {
        bins.push(binId);
        shares.push(share);
      }

      try {
        const { tx, description } = buildRemoveLiquidityTx({
          pmId: plan.pmId,
          poolId: pm.poolId,
          coinTypeA: pm.coinTypeA,
          coinTypeB: pm.coinTypeB,
          bins,
          liquidityShares: shares,
        });

        log.info("executor: removeLiquidity", { pmId: plan.pmId, description });

        const result = await submit(tx);

        log.info("executor: removeLiquidity executed", {
          pmId: plan.pmId,
          digest: result.digest,
        });

        return {
          pmId: plan.pmId,
          digest: result.digest,
          status: "succeeded",
          emittedAgentEvents: extractAgentEvents(result, agentAddress, plan.pmId),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("executor: removeLiquidity failed", { pmId: plan.pmId, error: msg });
        return { pmId: plan.pmId, digest: "", status: "failed", error: msg, emittedAgentEvents: [] };
      }
    },

    async supplyToLending(
      decision: Extract<LendingDecision, { kind: "supply" }>,
    ): Promise<ExecutionResult> {
      try {
        const built =
          decision.protocol === "scallop"
            ? await buildScallopSupplyTx({
                pmId: decision.pmId,
                coinType: decision.coinType,
                amount: decision.amount,
              })
            : buildKaiSupplyTx({
                pmId: decision.pmId,
                coinType: decision.coinType,
                ytType: decision.ytType,
                amount: decision.amount,
              });
        return await runLendingTx(decision.pmId, "supply", built);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("executor: supplyToLending failed (pre-flight)", { pmId: decision.pmId, error: msg });
        return { pmId: decision.pmId, digest: "", status: "failed", error: msg, emittedAgentEvents: [] };
      }
    },

    async redeemFromLending(
      decision: Extract<LendingDecision, { kind: "redeem" }>,
    ): Promise<ExecutionResult> {
      try {
        const built =
          decision.protocol === "scallop"
            ? await buildScallopRedeemTx({
                pmId: decision.pmId,
                coinType: decision.coinType,
                marketCoinAmount: decision.marketCoinAmount,
              })
            : buildKaiRedeemTx({
                pmId: decision.pmId,
                coinType: decision.coinType,
                ytType: decision.ytType,
                ytAmount: decision.marketCoinAmount,
              });
        return await runLendingTx(decision.pmId, "redeem", built);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("executor: redeemFromLending failed (pre-flight)", { pmId: decision.pmId, error: msg });
        return { pmId: decision.pmId, digest: "", status: "failed", error: msg, emittedAgentEvents: [] };
      }
    },

    async submitUnifiedRebalance(input: UnifiedRebalanceInput): Promise<ExecutionResult> {
      const pmId = input.plan.pmId;
      let built;
      try {
        built = await buildUnifiedRebalanceTx(input);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("executor: submitUnifiedRebalance build failed", { pmId, error: msg });
        return { pmId, digest: "", status: "failed", error: msg, emittedAgentEvents: [] };
      }
      if (built.commandCount === 0) {
        // No-op rebalance — strategy + lending decisions resolved to nothing.
        return { pmId, digest: "", status: "succeeded", emittedAgentEvents: [] };
      }

      log.info("executor: submitUnifiedRebalance", {
        pmId,
        commandCount: built.commandCount,
        description: built.description,
      });

      try {
        const result = await submit(built.tx);
        log.info("executor: submitUnifiedRebalance executed", {
          pmId,
          digest: result.digest,
        });
        return {
          pmId,
          digest: result.digest,
          status: "succeeded",
          emittedAgentEvents: extractAgentEvents(result, agentAddress, pmId),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("executor: submitUnifiedRebalance failed", { pmId, error: msg });
        return { pmId, digest: "", status: "failed", error: msg, emittedAgentEvents: [] };
      }
    },

    async addLiquidity(plan: RebalancePlan, pm: PMState): Promise<ExecutionResult> {
      // Skip if there is nothing to add.
      if (plan.addBins.length === 0 || (plan.addAmountA === 0n && plan.addAmountB === 0n)) {
        return { pmId: plan.pmId, digest: "", status: "succeeded", emittedAgentEvents: [] };
      }

      try {
        const { tx, description } = buildAddLiquidityTx({
          pmId: plan.pmId,
          poolId: pm.poolId,
          coinTypeA: pm.coinTypeA,
          coinTypeB: pm.coinTypeB,
          amountA: plan.addAmountA,
          amountB: plan.addAmountB,
          bins: plan.addBins,
          amountsA: plan.addAmountsA,
          amountsB: plan.addAmountsB,
          plannedActiveBinId: plan.plannedActiveBinId,
        });

        log.info("executor: addLiquidity", { pmId: plan.pmId, description });

        const result = await submit(tx);

        log.info("executor: addLiquidity executed", {
          pmId: plan.pmId,
          digest: result.digest,
        });

        return {
          pmId: plan.pmId,
          digest: result.digest,
          status: "succeeded",
          emittedAgentEvents: extractAgentEvents(result, agentAddress, plan.pmId),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("executor: addLiquidity failed", { pmId: plan.pmId, error: msg });
        return { pmId: plan.pmId, digest: "", status: "failed", error: msg, emittedAgentEvents: [] };
      }
    },

    async estimateRemoveProceeds(
      plan: RebalancePlan,
      pm: PMState,
    ): Promise<{ a: bigint; b: bigint }> {
      if (plan.removeShares.size === 0) return { a: 0n, b: 0n };

      const { tx, commandCount } = buildRemoveProbeTx(pm, plan);
      if (commandCount === 0) return { a: 0n, b: 0n };

      const bytes = await tx.build({ client });
      const dryRun = await client.dryRunTransactionBlock({ transactionBlock: bytes });

      const { a, b } = decodeRemoveProceedsFromDryRun(dryRun, pm.pmId);
      log.debug("executor: estimateRemoveProceeds", {
        pmId: pm.pmId,
        bins: plan.removeShares.size,
        a: a.toString(),
        b: b.toString(),
      });
      return { a, b };
    },
  };
}
