/**
 * Shared types for the lending integration. The agent supplies idle PM balance
 * into either Scallop (sCoin) or Kai (YT) and redeems on demand. Yield fee
 * accounting (interest portion only, capped at FeeHouse.fee_rate) is enforced
 * on-chain by CDPM; we mirror just enough state here to make routing decisions.
 */

export type LendingProtocol = "scallop" | "kai";

/** A single PM's holding in one lending protocol, keyed by underlying coin type. */
export interface LendingPosition {
  protocol: LendingProtocol;
  /** Underlying coin type tag (e.g. "0x...::usdc::USDC"). */
  coinType: string;
  /**
   * Kai stores entries under `type_name<YT>`; Scallop under `type_name<T>`. We
   * carry the YT type explicitly so the redeem path knows the second type arg.
   * Empty string when protocol === "scallop".
   */
  ytType: string;
  /** Principal previously supplied (sum of net deposits, less prior redeems' principal portions). */
  underlyingPrincipal: bigint;
  /** sCoin (Scallop) or YT (Kai) amount currently held inside the PM lending bag. */
  marketCoinAmount: bigint;
}

/** All lending positions tracked for a PM, indexed by protocol + coinType. */
export interface LendingState {
  scallop: Record<string, LendingPosition>;
  kai: Record<string, LendingPosition>;
}

export function emptyLendingState(): LendingState {
  return { scallop: {}, kai: {} };
}

/** Per-coin APY snapshot returned by adapters. APY is an annualised decimal (e.g. 0.045 = 4.5%). */
export interface ApySnapshot {
  protocol: LendingProtocol;
  coinType: string;
  apy: number;
  /** When the value was sampled (ms since epoch). */
  observedAtMs: number;
}

export type LendingDecision =
  | { kind: "noop"; reason: string }
  | {
      kind: "supply";
      pmId: string;
      protocol: LendingProtocol;
      coinType: string;
      ytType: string;
      amount: bigint;
      reason: string;
    }
  | {
      kind: "redeem";
      pmId: string;
      protocol: LendingProtocol;
      coinType: string;
      ytType: string;
      /** market_coin_amount (sCoin for Scallop, YT for Kai) to burn. */
      marketCoinAmount: bigint;
      reason: string;
    };

/** Strategy walk descriptor; required by Kai redeem to discharge each active strategy. */
export interface StrategyWalker {
  /** Move target, e.g. `<pkg>::<module>::strategy_withdraw_for_vault`. */
  target: string;
  typeArguments: string[];
  /**
   * Build the move-call arguments for this walker given the current tx and the
   * `withdraw_ticket` handle produced by `vault::withdraw`. Implementations
   * append `tx.object(...)` / `tx.pure.*(...)` as needed.
   */
  buildArguments(tx: import("@mysten/sui/transactions").Transaction, withdrawTicket: unknown): unknown[];
}

/** Resolved Scallop runtime IDs needed to build supply/redeem PTBs. */
export interface ScallopIds {
  /** Scallop protocol package id, e.g. `${scallop.address.get('core.packages.protocol.id')}`. */
  protocolPackageId: string;
  /** Version shared object id. */
  versionId: string;
  /** Market shared object id. */
  marketId: string;
}

/** Resolved Kai runtime IDs needed to build supply/redeem PTBs. */
export interface KaiVaultIds {
  /** kai_sav package id at current publish. */
  savPackageId: string;
  /** Vault<T, YT> object id. */
  vaultId: string;
  /** Underlying coin type T tag. */
  coinType: string;
  /** Yield token type YT tag. */
  ytType: string;
}
