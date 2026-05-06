import type { PriceObservation } from "../domain/types.ts";

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
}
