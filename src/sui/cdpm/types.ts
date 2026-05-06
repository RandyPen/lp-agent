/**
 * Decoded shapes for the CDPM events we care about. Source of truth: cdpm.move struct
 * definitions. All u64/u128 values are surfaced as bigint to preserve precision; type
 * names (like `coin_type`) come back as the on-chain ASCII string with the leading
 * "0x" prefix preserved.
 */

export interface DecodedEventEnvelope<T> {
  /** Move struct fully-qualified name, e.g. `${PACKAGE}::cdpm::AgentAdded`. */
  type: string;
  /** Tx digest where this event was emitted. */
  txDigest: string;
  /** Per-tx event sequence (monotonic within a tx). */
  eventSeq: string;
  /** Sui timestamp (ms) when the tx was finalized; 0 if unavailable. */
  timestampMs: number;
  payload: T;
}

export interface PositionManagerCreatedPayload {
  pmId: string;
  owner: string;
  poolId: string;
  /** I32-encoded; lower/upper bin ids of the initial position. */
  lowerBinId: number;
  upperBinId: number;
  liquidityShares: bigint[];
}

export interface AgentAddedPayload {
  pmId: string;
  agent: string;
}

export interface AgentRemovedPayload {
  pmId: string;
  agent: string;
}

export interface PositionManagerClosedPayload {
  pmId: string;
  owner: string;
}

export interface AgentLiquidityAddedPayload {
  pmId: string;
  poolId: string;
  bins: number[];
  amountA: bigint;
  amountB: bigint;
  by: string;
}

export interface AgentLiquidityRemovedPayload {
  pmId: string;
  poolId: string;
  bins: number[];
  liquidityShares: bigint[];
  amountA: bigint;
  amountB: bigint;
  by: string;
}

export interface AgentFeeCollectedPayload {
  pmId: string;
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  amountA: bigint;
  amountB: bigint;
  by: string;
}

export interface AgentRewardCollectedPayload {
  pmId: string;
  poolId: string;
  coinType: string;
  amount: bigint;
  by: string;
}

export type CdpmEventName =
  | "PositionManagerCreated"
  | "AgentAdded"
  | "AgentRemoved"
  | "PositionManagerClosed"
  | "AgentLiquidityAdded"
  | "AgentLiquidityRemoved"
  | "AgentFeeCollected"
  | "AgentRewardCollected";

export type CdpmEventPayload =
  | { name: "PositionManagerCreated"; data: PositionManagerCreatedPayload }
  | { name: "AgentAdded"; data: AgentAddedPayload }
  | { name: "AgentRemoved"; data: AgentRemovedPayload }
  | { name: "PositionManagerClosed"; data: PositionManagerClosedPayload }
  | { name: "AgentLiquidityAdded"; data: AgentLiquidityAddedPayload }
  | { name: "AgentLiquidityRemoved"; data: AgentLiquidityRemovedPayload }
  | { name: "AgentFeeCollected"; data: AgentFeeCollectedPayload }
  | { name: "AgentRewardCollected"; data: AgentRewardCollectedPayload };

export type DecodedCdpmEvent = DecodedEventEnvelope<CdpmEventPayload>;

/** Persistent cursor for resuming an event stream after restart. */
export interface EventCursor {
  /** Last tx digest seen on this stream. */
  txDigest: string;
  /** Per-tx event seq of the last consumed event. */
  eventSeq: string;
}
