import type { PriceObservation } from "../domain/types.ts";
import type { OhlcvBar } from "../forecast/types.ts";

export interface PriceFeed {
  /** Identifier (used in logs and rebalance journal). */
  readonly source: string;
  /** Most recent price for the configured pool. */
  getSpot(): Promise<PriceObservation>;
  /**
   * Recent price history, oldest-first. `windowMs` is a hint;
   * implementations may return less if not enough data is available.
   */
  getHistory(windowMs: number): Promise<PriceObservation[]>;
  /**
   * Bucketed OHLCV bars over `windowMs`. Reads from the persisted
   * `price_observations` table so the resolution improves as the agent runs.
   * `bucketMs` is the bar width (e.g. 60_000 for 1-minute bars).
   */
  getOhlcv(bucketMs: number, windowMs: number): Promise<OhlcvBar[]>;
}
