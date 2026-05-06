import { getSuiClient } from "../sui/client.ts";
import { getAgentKeypair, getAgentAddress } from "../sui/keypair.ts";
import {
  buildCollectFeeTx,
  buildTransferFeeToBalanceTx,
  buildRemoveLiquidityTx,
  buildAddLiquidityTx,
} from "../sui/cdpm/tx.ts";
import { decodeEvent } from "../sui/cdpm/events.ts";
import { log } from "../lib/logger.ts";
import type { PMState, RebalancePlan, ExecutionResult } from "../domain/types.ts";

export interface ExecutorService {
  collectAndTransferFees(pmId: string, pm: PMState): Promise<ExecutionResult>;
  removeLiquidity(plan: RebalancePlan, pm: PMState): Promise<ExecutionResult>;
  addLiquidity(plan: RebalancePlan, pm: PMState): Promise<ExecutionResult>;
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

export function createExecutorService(): ExecutorService {
  const client = getSuiClient();
  const agentAddress = getAgentAddress();

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

        const collectResult = await client.signAndExecuteTransaction({
          transaction: collectTx,
          signer: getAgentKeypair(),
          options: { showEvents: true },
        });

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

          const transferResult = await client.signAndExecuteTransaction({
            transaction: transferTx,
            signer: getAgentKeypair(),
            options: { showEvents: true },
          });

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

        const result = await client.signAndExecuteTransaction({
          transaction: tx,
          signer: getAgentKeypair(),
          options: { showEvents: true },
        });

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
        });

        log.info("executor: addLiquidity", { pmId: plan.pmId, description });

        const result = await client.signAndExecuteTransaction({
          transaction: tx,
          signer: getAgentKeypair(),
          options: { showEvents: true },
        });

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
  };
}
