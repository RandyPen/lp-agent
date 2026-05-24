/**
 * Treasury domain types. Mirrors SQL schema in `src/db/schema.sql` §"Treasury".
 *
 * Convention: bigints serialised to/from SQLite as strings (SQLite has no
 * native bigint). credit-domain integers fit in JS `number` (≤ 2^53).
 */

export interface TreasuryUser {
  suiAddress: string;          // owner's main wallet (FK from subscriptions.owner)
  derivationIndex: number;     // ≥ 1 — index 0 reserved for treasury master
  depositAddress: string;      // derived address user funds the agent through
  credits: number;             // current off-chain credit balance
  createdAtMs: number;
}

export interface CreditRate {
  coinType: string;
  rateNum: bigint;             // credits = floor(amount_atomic × num / den)
  rateDen: bigint;
  updatedAtMs: number;
  updatedBy: string | null;
}

export interface AddressBalanceSnapshot {
  depositAddress: string;
  coinType: string;
  lastSeenBalance: bigint;
  lastSeenMs: number;
}

export interface DepositRecord {
  id: string;                  // ULID
  suiAddress: string;
  depositAddress: string;
  coinType: string;
  amountDelta: bigint;         // raw chain delta this watcher tick saw
  prevBalance: bigint;
  newBalance: bigint;
  creditsGranted: number;      // floor(amountDelta × rate.num / rate.den);
                               // 0 when rate unset (backfill later via script)
  rateNum: bigint | null;
  rateDen: bigint | null;
  observedAtMs: number;
}

export type ServiceChargeStatus = "ok" | "rejected" | "refunded";

export interface ServiceCharge {
  nonce: string;               // PK — `${tickId}:${pmId}` from rebalancer
  suiAddress: string;
  pmId: string | null;
  creditsDebited: number;
  memo: string | null;
  status: ServiceChargeStatus;
  error: string | null;
  createdAtMs: number;
}

export type OpKind = "sweep" | "transfer" | "swap";
export type OpStatus = "pending" | "succeeded" | "failed";

export interface TreasuryOp {
  id: string;
  opKind: OpKind;
  fromAddress: string;
  toAddress: string | null;
  coinTypeIn: string;
  amountIn: bigint;
  coinTypeOut: string | null;
  amountOut: bigint | null;
  digest: string | null;
  status: OpStatus;
  error: string | null;
  initiatedBy: string;         // 'operator-script' / 'auto-sweep' / etc.
  createdAtMs: number;
}

/**
 * Result of an `attemptCharge` call. `ok=false` means the rebalancer should
 * NOT proceed with the on-chain action.
 */
export interface ChargeResult {
  ok: boolean;
  chargeNonce: string;
  remainingCredits: number;
  error?: string;              // 'not_registered' / 'insufficient_credits' / ...
}
