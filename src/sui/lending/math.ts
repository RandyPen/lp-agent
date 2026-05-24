/**
 * Pure-TS twins of the cdpm lending math, mirroring the on-chain Move logic.
 * See ~/Code/cdpm/skills/cdpm-calculation-skill/reference/
 *     {scallop-lending-math.md, kai-lending-math.md} for derivations.
 *
 * The forward direction predicts what `pm.balance[T]` receives when burning N
 * sCoin / YT. The inverse direction sizes the smallest N such that the
 * post-fee net underlying is >= a target K — this is what a rebalancer needs
 * before issuing `scallop_start_redeem` / `kai_start_redeem`.
 *
 * Both protocols share `fee_house.fee_rate` (default 2000 bp = 20%, capped at
 * 3000 bp), so the yield-fee path is identical; only the snapshot inputs differ.
 */

export const MAX_U64 = (1n << 64n) - 1n;
export const FEE_DENOMINATOR = 10_000n;
export const MAX_FEE_RATE = 3_000n;

/**
 * Defense-in-depth floor for partial / full-drain redeems. Both Scallop and
 * Kai can leave a few units of dust between cdpm's floored prediction and the
 * live walker output (Kai is the worst case — multi-strategy walk floors per
 * step). Keep a small reserve in the wrapper to avoid the trip-wire.
 *
 * 100 raw ≈ negligible USD value at any decimals we care about.
 */
export const LENDING_SAFE_MARGIN_WRAPPER_RAW = 100n;

/**
 * APY tie-break threshold (basis points). When |Δapy| is within this band,
 * Scallop wins — its supply path has lower latency than Kai's multi-strategy
 * walk and avoids the time-locked unlock schedule. See
 * `scallop-lending-math.md` §10.4.
 */
export const SCALLOP_TIE_BREAK_BPS = 25;

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: divisor must be positive");
  return (a + b - 1n) / b;
}

// ---------- Scallop ----------

export interface ScallopReserveSnapshot {
  cash: bigint;
  debt: bigint;
  revenue: bigint;
  supply: bigint;
}

export interface ScallopVaultSnapshot {
  /** balance::value(&KaiVault.scoin) for this PM. */
  scoinTotal: bigint;
  /** ScallopVault.principal for this PM. */
  principalTotal: bigint;
}

export function scallopDenom(r: ScallopReserveSnapshot): bigint {
  if (r.cash + r.debt < r.revenue) {
    throw new Error("EReserveEmpty (1006): cash + debt < revenue");
  }
  const d = r.cash + r.debt - r.revenue;
  if (d === 0n) throw new Error("EReserveEmpty (1006): denom == 0");
  return d;
}

/** floor(scoin × denom / supply). Inverse of `computeExpectedScoin`. */
export function computeExpectedUnderlyingScallop(
  r: ScallopReserveSnapshot,
  scoinAmount: bigint,
): bigint {
  if (r.supply === 0n) throw new Error("EReserveEmpty (1006): supply == 0");
  return (scoinAmount * scallopDenom(r)) / r.supply;
}

/** Mirror of `pull_from_scallop_lending` principal split. */
export function scallopPrincipalPortion(
  pTotal: bigint,
  sTotal: bigint,
  wantScoin: bigint,
): bigint {
  if (sTotal === 0n) return 0n;
  if (wantScoin >= sTotal) return pTotal;
  return (pTotal * wantScoin) / sTotal;
}

export function applyYieldFee(
  redeemedAmount: bigint,
  principalPortion: bigint,
  feeRateBp: bigint,
): { interest: bigint; feeAmount: bigint; toBalance: bigint } {
  if (feeRateBp > MAX_FEE_RATE) throw new Error("EInvalidFeeRate (1003)");
  const interest =
    redeemedAmount > principalPortion ? redeemedAmount - principalPortion : 0n;
  const feeAmount = (interest * feeRateBp) / FEE_DENOMINATOR;
  return { interest, feeAmount, toBalance: redeemedAmount - feeAmount };
}

export interface RedeemPrediction {
  expectedUnderlying: bigint;
  principalPortion: bigint;
  interest: bigint;
  feeAmount: bigint;
  toBalance: bigint;
}

export function predictScallopRedeem(
  reserve: ScallopReserveSnapshot,
  vault: ScallopVaultSnapshot,
  wantScoin: bigint,
  feeRateBp: bigint,
): RedeemPrediction {
  const expectedUnderlying = computeExpectedUnderlyingScallop(reserve, wantScoin);
  const pp = scallopPrincipalPortion(vault.principalTotal, vault.scoinTotal, wantScoin);
  const fee = applyYieldFee(expectedUnderlying, pp, feeRateBp);
  return {
    expectedUnderlying,
    principalPortion: pp,
    interest: fee.interest,
    feeAmount: fee.feeAmount,
    toBalance: fee.toBalance,
  };
}

/**
 * Smallest sCoin N to burn so post-fee net underlying credited to pm.balance[T]
 * is >= desiredNet. Closed-form approximation, then 1-step iterative refinement.
 *
 * Returns MAX_U64 when the vault cannot satisfy the target (caller should drain).
 */
export function scoinToBurnForTargetNet(
  reserve: ScallopReserveSnapshot,
  vault: ScallopVaultSnapshot,
  desiredNet: bigint,
  feeRateBp: bigint,
  maxIterations = 8,
): bigint {
  if (desiredNet <= 0n) return 0n;
  if (vault.scoinTotal === 0n) return MAX_U64;
  const denom = scallopDenom(reserve);
  if (reserve.supply === 0n) throw new Error("EReserveEmpty (1006): supply == 0");

  // p = denom / supply, π = P / S. p > π iff denom * S > supply * P.
  const interestExists =
    denom * vault.scoinTotal > reserve.supply * vault.principalTotal;

  let n: bigint;
  if (!interestExists) {
    n = ceilDiv(desiredNet * reserve.supply, denom);
  } else {
    const r = feeRateBp;
    const numer =
      desiredNet * FEE_DENOMINATOR * reserve.supply * vault.scoinTotal;
    const denomTerm =
      (FEE_DENOMINATOR - r) * denom * vault.scoinTotal +
      r * reserve.supply * vault.principalTotal;
    if (denomTerm === 0n) return MAX_U64;
    n = ceilDiv(numer, denomTerm);
  }

  if (n > vault.scoinTotal) return MAX_U64;

  // Iterative refinement — closed form is usually exact or off by ≤1.
  for (let i = 0; i < maxIterations; i++) {
    if (n > vault.scoinTotal) return MAX_U64;
    if (n === 0n) {
      n = 1n;
      continue;
    }
    const sim = predictScallopRedeem(reserve, vault, n, feeRateBp);
    if (sim.toBalance >= desiredNet) return n;
    n += 1n;
  }
  return n > vault.scoinTotal ? MAX_U64 : n;
}

// ---------- Kai ----------

export interface KaiVaultSnapshot {
  /** total_available_balance(vault, clock) */
  totalAvailable: bigint;
  /** total_yt_supply(vault) */
  ytSupply: bigint;
}

export interface KaiPmVaultSnapshot {
  /** balance::value(&KaiVault.yt_balance) for this PM. */
  ytInPm: bigint;
  /** KaiVault.principal for this PM. */
  principalInPm: bigint;
}

/** floor(yt × total / yt_supply). Inverse of `computeExpectedYt`. */
export function computeExpectedUnderlyingKai(
  v: KaiVaultSnapshot,
  ytAmount: bigint,
): bigint {
  if (v.ytSupply === 0n) throw new Error("EReserveEmpty (1006): yt_supply == 0");
  return (ytAmount * v.totalAvailable) / v.ytSupply;
}

export function kaiPrincipalPortion(
  pInPm: bigint,
  ytInPm: bigint,
  wantYt: bigint,
): bigint {
  if (ytInPm === 0n) return 0n;
  if (wantYt >= ytInPm) return pInPm;
  return (pInPm * wantYt) / ytInPm;
}

export function predictKaiRedeem(
  vault: KaiVaultSnapshot,
  pm: KaiPmVaultSnapshot,
  wantYt: bigint,
  feeRateBp: bigint,
): RedeemPrediction {
  const expectedUnderlying = computeExpectedUnderlyingKai(vault, wantYt);
  const pp = kaiPrincipalPortion(pm.principalInPm, pm.ytInPm, wantYt);
  const fee = applyYieldFee(expectedUnderlying, pp, feeRateBp);
  return {
    expectedUnderlying,
    principalPortion: pp,
    interest: fee.interest,
    feeAmount: fee.feeAmount,
    toBalance: fee.toBalance,
  };
}

export function ytToBurnForTargetNet(
  vault: KaiVaultSnapshot,
  pm: KaiPmVaultSnapshot,
  desiredNet: bigint,
  feeRateBp: bigint,
  maxIterations = 8,
): bigint {
  if (desiredNet <= 0n) return 0n;
  if (pm.ytInPm === 0n) return MAX_U64;
  if (vault.totalAvailable === 0n) return MAX_U64;
  if (vault.ytSupply === 0n) throw new Error("EReserveEmpty (1006): yt_supply == 0");

  const interestExists =
    vault.totalAvailable * pm.ytInPm > vault.ytSupply * pm.principalInPm;

  let n: bigint;
  if (!interestExists) {
    n = ceilDiv(desiredNet * vault.ytSupply, vault.totalAvailable);
  } else {
    const r = feeRateBp;
    const numer =
      desiredNet * FEE_DENOMINATOR * vault.ytSupply * pm.ytInPm;
    const denomTerm =
      (FEE_DENOMINATOR - r) * vault.totalAvailable * pm.ytInPm +
      r * vault.ytSupply * pm.principalInPm;
    if (denomTerm === 0n) return MAX_U64;
    n = ceilDiv(numer, denomTerm);
  }

  if (n > pm.ytInPm) return MAX_U64;

  for (let i = 0; i < maxIterations; i++) {
    if (n > pm.ytInPm) return MAX_U64;
    if (n === 0n) {
      n = 1n;
      continue;
    }
    const sim = predictKaiRedeem(vault, pm, n, feeRateBp);
    if (sim.toBalance >= desiredNet) return n;
    n += 1n;
  }
  return n > pm.ytInPm ? MAX_U64 : n;
}

// ---------- Shared helpers ----------

/**
 * Cap the wrapper amount we burn so partial redeems never trip cdpm's
 * `EAmountShortfall (1009)` due to per-strategy floor-div dust. Returns null
 * when the entry is below the safe margin floor — caller should defer to a
 * user-driven full close (which uses a top-up to absorb the dust).
 */
export function capRedeemBurnRaw(
  exact: bigint,
  wrapperRaw: bigint,
  safeMargin: bigint = LENDING_SAFE_MARGIN_WRAPPER_RAW,
): bigint | null {
  if (wrapperRaw <= safeMargin) return null;
  const safeMax = wrapperRaw - safeMargin;
  return exact >= safeMax ? safeMax : exact;
}
