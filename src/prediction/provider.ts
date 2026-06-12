/**
 * PredictionProvider — the open-source seam for swapping prediction models.
 *
 * Fork users replace the model by implementing this interface and passing their
 * implementation to `createMlAgentStrategy`. The framework never knows what is
 * behind the interface — Python sidecar, remote service, or a future Rust impl
 * all satisfy the same contract.
 *
 * v1 ships two implementations:
 *   - `NullPredictionProvider` (`./nullProvider.ts`): deterministic, rule-based,
 *     no I/O. Used in W2 to wire up the full decision chain before the ML model
 *     is available, and as the final fallback when sidecar inference is not
 *     possible.
 *   - `SidecarPredictionProvider` (`./sidecarProvider.ts`): HTTP POST to the
 *     local Python sidecar. Added in W4 once the model is trained.
 *
 * See `docs/prediction-service-design.md §4.3` for the rationale and
 * `implementation-plan-v1.md §3.2` for the interface contract.
 */

import type { MarketSnapshot, PmRangeContext, PredictionResponse, ProviderHealth } from "./types.ts";

export interface PredictionProvider {
  /**
   * Human-readable identifier for this provider implementation.
   * Used in logs, the `predictions.model_version` DB column, and shadow reports.
   */
  readonly name: string;

  /**
   * Produce a `PredictionResponse` for the given market snapshot and PM context.
   *
   * Implementations MUST NOT throw on inference failure. Instead, return a
   * response with an appropriate `fallback` value so that `mlAgent` can record
   * the degradation and switch to Tier 0 explicitly. Silent failures are bugs.
   *
   * `snapshot` is assembled by `marketAggregator` and contains the latest
   * multi-source market data. `ctx` provides the PM's current bin coverage so
   * the provider can compute bin-relative outputs (pAbove/pBelow).
   */
  predict(snapshot: MarketSnapshot, ctx: PmRangeContext): Promise<PredictionResponse>;

  /**
   * Return the current health of this provider.
   *
   * Called periodically by the monitoring loop and before the first prediction
   * of a session. A healthy provider (`ok: true`) serves predictions directly;
   * an unhealthy one causes `mlAgent` to stay on Tier 0 until health recovers.
   *
   * This method should never throw — it is called in health-check contexts
   * where a thrown exception would be treated as a hard failure.
   */
  health(): Promise<ProviderHealth>;
}
