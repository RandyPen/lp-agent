/**
 * Gasless stablecoin transfer support.
 *
 * Sui mainnet (launched 2026-05-20) allows transactions that spend ZERO gas
 * when ALL of the following hold:
 *   1. The PTB consists exclusively of allowlisted Move functions on allowlisted
 *      stablecoin types (`0x2::balance::send_funds`, `balance::redeem_funds`,
 *      `coin::send_funds`, `coin::into_balance`, `withdrawal_split`).
 *   2. `gasPayment` is EMPTY and `gasPrice = 0`.
 *   3. No objects are written — input coins are fully consumed or converted to
 *      address balances.
 *
 * Ref: https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers
 *
 * Builder approach:
 *   We do NOT use `tx.balance()` (which creates a `CoinWithBalance` intent that
 *   requires async client resolution at serialization time) because:
 *     a) the intent resolution callback requires a gRPC-capable client and
 *     b) we want to be able to inspect the raw PTB shape synchronously in tests.
 *
 *   Instead we use the low-level path:
 *     tx.withdrawal({ amount, type: coinType })   → FundsWithdrawal input
 *     tx.moveCall({ target: "0x2::balance::send_funds", ... })
 *
 *   This produces a PTB that qualifies as gasless because:
 *     - The only command is `0x2::balance::send_funds<T>` (allowlisted).
 *     - The only input is a `FundsWithdrawal` (address balance source, not a
 *       Coin object) — so no objects are written.
 *     - gasPrice=0 and no gasPayment are set explicitly.
 *
 *   The `FundsWithdrawal` input tells the runtime to source the Balance from the
 *   sender's address balance accumulator; the deposit address therefore needs
 *   NO Coin objects in its inventory and NO SUI for gas.
 *
 * SDK ground-truth:
 *   `tx.withdrawal()` is declared in Transaction.d.mts at line ~465:
 *     withdrawal({ amount, type }: { amount: number | bigint | string;
 *                                    type?: string | null }): InputRef
 *   `getData().gasData.payment` is `null | ObjectRef[]`; we set it to `[]` but
 *   the SDK leaves it null unless setGasPayment is called — that is also valid
 *   (the validator treats missing payment as empty).
 */

import { Transaction } from "@mysten/sui/transactions";
import { canonicalType } from "../sui/lending/typeNorm.ts";

// ---------------------------------------------------------------------------
// Allowlisted stablecoin types (mainnet)
// ---------------------------------------------------------------------------

/**
 * Full canonical types of all 7 gasless-eligible mainnet stablecoins.
 *
 * Source: https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers
 * Types are normalised once at startup via canonicalType() which pads addresses
 * to 32-byte long form and preserves module/struct name casing (e.g. USDC, not
 * usdc). The normalised values are used both for set membership checks and as
 * PTB type arguments — no separate "ptbType" map is needed.
 *
 * Note on USDY and AUSD decimals: the doc does not publish decimals for all
 * coins. The coins we have high confidence on (via the USDC/USDT/FDUSD
 * ecosystem standard) are marked 6. USDY (Ondo) and AUSD (Agora) are known
 * to use 6 decimals on Sui from their respective published onchain metadata;
 * USDB and SUI_USDE have 6 decimals as well (all are dollar-pegged with 6d
 * precision on Sui). If any of these are wrong the minimum will be too
 * conservative or too permissive — operators should verify before relying on
 * exact min-transfer logic for non-USDC coins.
 */
const _GASLESS_COIN_TYPES_RAW: readonly string[] = [
  // USDC (Circle)
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  // USDSUI (Agora — native Sui dollar)
  "0xb231fcda8bbddb31f2ef02e6161444aec64a514e2c89279584ac9806ce9cf037::coin::COIN",
  // SUI_USDE (Ethena USDe bridged to Sui)
  "0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN",
  // USDY (Ondo Finance)
  "0xcf72ec52c0f8ddead746252481fb44ff6e8485a39b803825bde6b00d77cdb0bb::usdy::USDY",
  // FDUSD (First Digital USD)
  "0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD",
  // AUSD (Agora USD)
  "0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD",
  // USDB (Blur / Blur Foundation USD)
  "0xa198f3be41cda8c07b3bf3fee02263526e535d682499806979a111e88a5a8d0f::coin::COIN",
];

/**
 * Canonical (address-normalised, case-preserving) full types of the 7
 * gasless-eligible stablecoins. Values match what `canonicalType()` produces —
 * suitable for map/DB lookups, membership checks (`isGaslessEligible()`), and
 * PTB type arguments (module/struct names retain their original casing).
 */
export const GASLESS_STABLECOINS: ReadonlySet<string> = new Set(
  _GASLESS_COIN_TYPES_RAW.map(canonicalType),
);

/**
 * Decimal places for each gasless-eligible coin (used by gaslessMinAtomic).
 * Key: canonical coin type (address-normalised, case-preserving). Value: decimal places.
 */
const GASLESS_DECIMALS: ReadonlyMap<string, number> = new Map(
  _GASLESS_COIN_TYPES_RAW.map(canonicalType).map((ct) => [ct, 6]),
);

// ---------------------------------------------------------------------------
// Eligibility check
// ---------------------------------------------------------------------------

/**
 * Returns true when `coinType` is one of the 7 allowlisted gasless stablecoins.
 * Always canonicalises the type before checking so short- and long-form
 * addresses compare equal.
 */
export function isGaslessEligible(coinType: string): boolean {
  return GASLESS_STABLECOINS.has(canonicalType(coinType));
}

// ---------------------------------------------------------------------------
// Minimum transfer amount
// ---------------------------------------------------------------------------

/**
 * Protocol minimum: 0.01 whole-unit stablecoin (per Sui docs).
 * Returns the minimum in atomic units for the given coin.
 *
 * All 7 gasless-eligible mainnet coins have 6 decimal places, so the minimum
 * is `0.01 × 10^6 = 10_000` atomic units for all of them.
 *
 * Throws when `coinType` is not in the allowlist — callers should gate on
 * `isGaslessEligible()` first.
 */
export function gaslessMinAtomic(coinType: string): bigint {
  const ct = canonicalType(coinType);
  const decimals = GASLESS_DECIMALS.get(ct);
  if (decimals === undefined) {
    throw new Error(
      `gaslessMinAtomic: coin ${coinType} is not a gasless-eligible stablecoin`,
    );
  }
  // minimum = 0.01 × 10^decimals = 10^(decimals - 2)
  return 10n ** BigInt(decimals - 2);
}

/**
 * The gasless minimum for USDC (6 decimals): 10_000 atomic units = 0.01 USDC.
 * Exported for documentation / test reference.
 */
export const GASLESS_MIN_USDC_ATOMIC = 10_000n; // 0.01 USDC

// ---------------------------------------------------------------------------
// PTB builder
// ---------------------------------------------------------------------------

export interface BuildGaslessTransferArgs {
  /** Sender's Sui address (the deposit address whose address balance to draw from). */
  sender: string;
  /** Coin type (will be canonicalised). Must be a gasless-eligible stablecoin. */
  coinType: string;
  /** Amount in atomic units (must be ≥ gaslessMinAtomic). */
  amountAtomic: bigint;
  /** Recipient Sui address. */
  recipient: string;
}

/**
 * Build a qualifying gasless-stablecoin PTB.
 *
 * IMPORTANT — two-step PTB shape:
 *   The correct on-chain pattern uses TWO MoveCall commands (resolved at
 *   `tx.build({ client })` time from the single `tx.balance()` intent):
 *     1. `0x2::balance::redeem_funds<T>(FundsWithdrawal)` → `Balance<T>`
 *     2. `0x2::balance::send_funds<T>(Balance<T>, address)`
 *
 *   Using `tx.withdrawal()` directly as an argument to `send_funds` is
 *   INCORRECT: it produces a `FundsWithdrawal` input reference where a
 *   `Balance<T>` value is expected, causing a `TypeMismatch` at execution.
 *   The `tx.balance()` intent resolver inserts the `redeem_funds` call
 *   automatically when the sender's address balance is sufficient.
 *
 * The returned Transaction (before `build()`):
 *   - Has `sender` set.
 *   - Has `gasPrice = 0` (required for the JSON-RPC path).
 *   - Has `gasPayment = []` and `gasBudget = 0` (both required for the gasless
 *     path — empty payment tells the SDK not to search for SUI gas coins;
 *     budget=0 is valid for a gasless tx and skips the SDK's budget simulation).
 *   - Contains a `CoinWithBalance` intent command that resolves to
 *     `redeem_funds + send_funds` when `tx.build({ client })` is called.
 *
 * Callers MUST call `await tx.build({ client })` before serializing or
 * submitting. The `client` must be a JSON-RPC or gRPC-capable SuiClient.
 *
 * Before resolution (`getData()` before `build()`):
 *   - `commands[0]` is a `$Intent` (CoinWithBalance), not a final MoveCall.
 *   - `commands[1]` is the `MoveCall balance::send_funds`.
 *   After `build()`, `commands` expands to the resolved two-MoveCall form.
 *
 * The `coinType` is normalised via `canonicalType` before use — both short-form
 * (`0x2::sui::SUI`) and long-form (`0x000…002::sui::SUI`) are accepted. Module
 * and struct name casing is preserved in the normalised output, which is used
 * directly as the PTB type argument.
 *
 * Throws immediately (never degrades silently) when:
 *   - `coinType` is not an allowlisted gasless stablecoin.
 *   - `amountAtomic` is below the protocol minimum.
 */
export function buildGaslessTransfer(args: BuildGaslessTransferArgs): Transaction {
  const { sender, recipient, amountAtomic } = args;

  // canonicalType normalises the address to 32-byte long form and preserves
  // module/struct name casing — the result is suitable for both set/map lookups
  // and as a PTB type argument.
  const coinTypeKey = canonicalType(args.coinType);

  if (!GASLESS_STABLECOINS.has(coinTypeKey)) {
    throw new Error(
      `buildGaslessTransfer: ${args.coinType} is not a gasless-eligible stablecoin — ` +
      `use the gas-paid path for this coin type`,
    );
  }

  const minAtomic = gaslessMinAtomic(coinTypeKey);
  if (amountAtomic < minAtomic) {
    throw new Error(
      `buildGaslessTransfer: amount ${amountAtomic} is below the protocol minimum ` +
      `${minAtomic} atomic units (0.01 whole units) for ${args.coinType}`,
    );
  }

  // canonicalType preserves the original module/struct casing (e.g. ::usdc::USDC),
  // so coinTypeKey is already the correct PTB type argument — no separate lookup needed.
  const coinTypePtb = coinTypeKey;

  const tx = new Transaction();

  // Set sender (required for the CoinWithBalance intent resolver — it calls
  // getBalance on the sender to check the address balance accumulator).
  tx.setSender(sender);

  // JSON-RPC path: set gasPrice=0 explicitly.
  tx.setGasPrice(0);

  // Gasless path requires empty gasPayment (no SUI gas coins needed) and
  // budget=0 (gasless txs have zero gas cost). Setting both explicitly prevents
  // the SDK's core resolver from fetching SUI coins or running a budget
  // simulation — both of which would fail for a deposit address that holds no SUI.
  tx.setGasBudget(0);
  tx.setGasPayment([]);

  // `tx.balance()` creates a CoinWithBalance intent. The intent resolver
  // (called during `build({ client })`) checks the sender's fundsInAddressBalance
  // via getBalance, then generates:
  //   cmd[0]: 0x2::balance::redeem_funds<T>(FundsWithdrawal) → Balance<T>
  //   cmd[1]: 0x2::balance::send_funds<T>(Balance<T>, address)
  //
  // Using `tx.withdrawal()` directly as argument to `send_funds` is WRONG —
  // it would pass a FundsWithdrawal input reference where a Balance<T> value
  // is expected, causing TypeMismatch at execution time.
  //
  // coinTypePtb is canonicalType output — address normalised, module/struct
  // casing preserved (e.g. ::usdc::USDC). The Sui validator's gasless allowlist
  // is case-sensitive and accepts the correctly-cased form directly.
  const balanceInput = tx.balance({ type: coinTypePtb, balance: amountAtomic });

  // The outer send_funds call — receives the Balance<T> produced by redeem_funds.
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [coinTypePtb],
    arguments: [balanceInput, tx.pure.address(recipient)],
  });

  return tx;
}
