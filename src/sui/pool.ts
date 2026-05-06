import { getSuiClient } from "./client.ts";
import { OnchainFailureError } from "../lib/errors.ts";
import { log } from "../lib/logger.ts";
import { loadConfig } from "../config.ts";
import type { PoolState } from "../domain/types.ts";

/**
 * Fee precision constant used by the Cetus DLMM protocol (constants.move).
 * base_fee_rate = base_factor * bin_step, expressed with this denominator.
 * To convert to basis-points: (base_fee_rate * 10_000) / FEE_PRECISION.
 */
const FEE_PRECISION = 1_000_000_000n;

/**
 * Reinterpret an I32 `{ bits: u32 }` value as a signed JS number.
 * The integer-mate I32 is stored as two's-complement in a u32.
 */
function i32BitsToNumber(raw: unknown): number {
  if (raw == null) return 0;
  const obj = raw as { bits?: unknown };
  const bits = Number(obj.bits ?? 0) >>> 0; // coerce to u32
  return bits & 0x8000_0000 ? bits - 0x1_0000_0000 : bits;
}

/**
 * Fetch the current state of a Cetus DLMM pool object.
 *
 * Field mapping (pool.move:164-180):
 *   active_id   → I32 { bits: u32 }       → activeBinId: number (signed)
 *   v_parameters.bin_step_config.bin_step  → binStep: number
 *   base_fee_rate                          → u64 decimal string
 *
 * Fee-rate approximation (v0):
 *   The pool stores `base_fee_rate = base_factor * bin_step` at fee_precision
 *   scale (1e9). We convert it to basis-points:
 *     feeRateBps = (base_fee_rate * 10_000) / 1_000_000_000
 *   This is the static base fee only; the variable fee component (which grows
 *   with recent price volatility) is intentionally ignored in this v0
 *   implementation. Callers that need the live effective fee should use the
 *   pool_profile.defaultStrategyParams.expectedFeeBps fallback or call
 *   pool.v_parameters.fee_rate() via a devInspect simulation.
 *
 * Fallback:
 *   If the base_fee_rate field cannot be parsed (e.g. future struct upgrade),
 *   we fall back to pool_profile.defaultStrategyParams.expectedFeeBps and log
 *   a warning.
 */
export async function getPoolState(poolId: string): Promise<PoolState> {
  const client = getSuiClient();
  const cfg = loadConfig();

  log.debug("getPoolState fetching", { poolId });

  const resp = await client.getObject({
    id: poolId,
    options: { showContent: true, showType: true },
  });

  if (!resp.data || resp.data.content?.dataType !== "moveObject") {
    throw new OnchainFailureError(`Pool ${poolId} not found or not a Move object`);
  }

  const fields = (
    resp.data.content as { dataType: "moveObject"; fields: Record<string, unknown> }
  ).fields;

  // active_id: I32 { bits: u32 }
  const activeBinId = i32BitsToNumber(fields["active_id"]);

  // bin_step: inside v_parameters → bin_step_config → bin_step (u16 → JS number)
  const vParams = fields["v_parameters"] as
    | { fields?: { bin_step_config?: { fields?: { bin_step?: unknown } } } }
    | undefined;
  const binStepRaw = vParams?.fields?.bin_step_config?.fields?.bin_step;
  const binStep = binStepRaw !== undefined ? Number(binStepRaw) : cfg.poolProfile.binStep;

  if (binStepRaw === undefined) {
    log.warn("getPoolState: bin_step not found in v_parameters, falling back to poolProfile", {
      poolId,
      fallback: cfg.poolProfile.binStep,
    });
  }

  // base_fee_rate: u64 decimal string.
  // Represents base_factor * bin_step at fee_precision (1e9) scale.
  let feeRateBps: number;
  const rawFeeRate = fields["base_fee_rate"];

  if (rawFeeRate !== undefined && rawFeeRate !== null) {
    try {
      const baseFeeRate = BigInt(rawFeeRate as string | number);
      // Convert: (base_fee_rate / fee_precision) * 10_000 bps
      // = base_fee_rate * 10_000 / 1_000_000_000
      feeRateBps = Number((baseFeeRate * 10_000n) / FEE_PRECISION);
      log.debug("getPoolState fee computed", { poolId, baseFeeRate: baseFeeRate.toString(), feeRateBps });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("getPoolState: failed to parse base_fee_rate, falling back to poolProfile", {
        poolId,
        rawFeeRate,
        error: msg,
        fallback: cfg.poolProfile.defaultStrategyParams.expectedFeeBps,
      });
      feeRateBps = cfg.poolProfile.defaultStrategyParams.expectedFeeBps;
    }
  } else {
    log.warn("getPoolState: base_fee_rate field absent, falling back to poolProfile", {
      poolId,
      fallback: cfg.poolProfile.defaultStrategyParams.expectedFeeBps,
    });
    feeRateBps = cfg.poolProfile.defaultStrategyParams.expectedFeeBps;
  }

  log.debug("getPoolState done", { poolId, activeBinId, binStep, feeRateBps });

  return { poolId, activeBinId, binStep, feeRateBps };
}
