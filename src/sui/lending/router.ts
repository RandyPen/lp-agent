import { loadConfig } from "../../config.ts";
import { log } from "../../lib/logger.ts";
import type { PMState } from "../../domain/types.ts";
import type { PoolProfile } from "../../pools/types.ts";
import { getApy } from "./apyCache.ts";
import { getKaiAdapter } from "./kai.ts";
import { getScallopAdapter } from "./scallop.ts";
import {
  canLend,
  getMinLendingDeltaRaw,
  lendingProtocolsFor,
} from "./lendingConfig.ts";
import {
  LENDING_SAFE_MARGIN_WRAPPER_RAW,
  SCALLOP_TIE_BREAK_BPS,
  capRedeemBurnRaw,
} from "./math.ts";
import type {
  ApySnapshot,
  LendingDecision,
  LendingProtocol,
} from "./types.ts";

/**
 * APY-aware decision tree for one PM, one rebalancer tick. Returns a list of
 * decisions in execution order. Today this returns at most one decision per
 * coin per tick to bound risk; the rebalancer can call us again next tick.
 *
 * Inputs the rebalancer must already have at hand:
 *   - `pm`: post-rebalance PM snapshot (after add/remove + fee transfers).
 *   - `profile`: pool profile (carries per-coin policy; lendability comes from
 *      `lendingConfig.LENDING_OPPORTUNITIES`, not the profile).
 *   - `shortfall`: amount of each coin the *next* bin op will need beyond
 *      what's left in `pm.balance` after `minIdleBuffer`. 0n when unknown —
 *      the router will then only consider supply / switch.
 */
export interface RouterInput {
  pm: PMState;
  profile: PoolProfile;
  shortfall: { a: bigint; b: bigint };
}

export interface RouterOutput {
  decisions: LendingDecision[];
}

export async function decide(input: RouterInput): Promise<RouterOutput> {
  const cfg = loadConfig();
  if (!cfg.lending.enabled) {
    return { decisions: [{ kind: "noop", reason: "lending disabled in config" }] };
  }

  const decisions: LendingDecision[] = [];
  const sides = [
    { coinType: input.profile.coinTypeA, idle: input.pm.balance.a, shortfall: input.shortfall.a },
    { coinType: input.profile.coinTypeB, idle: input.pm.balance.b, shortfall: input.shortfall.b },
  ] as const;

  for (const side of sides) {
    // Eligibility now driven by `lendingConfig.LENDING_OPPORTUNITIES` (mirrors
    // cdpm_web). pool profile no longer owns the lendable-coins whitelist.
    if (!canLend(side.coinType)) continue;
    const policy = input.profile.lendingPolicy[side.coinType];
    if (!policy) continue;

    const decision = await decideForCoin({
      coinType: side.coinType,
      idle: side.idle,
      shortfall: side.shortfall,
      policy,
      pm: input.pm,
    });
    if (decision.kind !== "noop") {
      decisions.push(decision);
    }
  }

  if (decisions.length === 0) {
    decisions.push({ kind: "noop", reason: "no lending action needed this tick" });
  }
  return { decisions };
}

interface DecideForCoinArgs {
  coinType: string;
  idle: bigint;
  shortfall: bigint;
  policy: {
    minIdleBuffer: bigint;
    supplyThreshold: bigint;
    redeemHeadroom: bigint;
    apySwitchDeltaBps: number;
  };
  pm: PMState;
}

async function decideForCoin(args: DecideForCoinArgs): Promise<LendingDecision> {
  const cfg = loadConfig();
  const { coinType, idle, shortfall, policy, pm } = args;

  const scallopPos = pm.lending.scallop[coinType];
  const kaiPos = pm.lending.kai[coinType];
  const supplied: LendingProtocol | null = scallopPos
    ? "scallop"
    : kaiPos
      ? "kai"
      : null;
  const suppliedPos = scallopPos ?? kaiPos;

  // 1) Redeem when the upcoming bin op needs more balance than we have idle.
  if (shortfall > 0n) {
    const idleAvailable = idle > policy.minIdleBuffer ? idle - policy.minIdleBuffer : 0n;
    const need = shortfall + policy.redeemHeadroom;
    if (idleAvailable < need && suppliedPos) {
      // Approximate sCoin/YT to redeem proportionally to local underlyingPrincipal.
      // This is conservative when fee_rate × interest is small relative to the
      // headroom (true in v0 — see lendingPolicy defaults). Live snapshot-based
      // sizing via math.scoinToBurnForTargetNet / ytToBurnForTargetNet lives in
      // the math module; plumb it in when we add a reserve/vault reader.
      const wantUnderlying = need - idleAvailable;
      const principal =
        suppliedPos.underlyingPrincipal === 0n ? 1n : suppliedPos.underlyingPrincipal;
      const rawAsk =
        wantUnderlying >= principal
          ? suppliedPos.marketCoinAmount
          : ceilDiv(suppliedPos.marketCoinAmount * wantUnderlying, principal);

      // Cap by LENDING_SAFE_MARGIN_WRAPPER_RAW so a partial drain never trips
      // EAmountShortfall on multi-strategy walks. When the wrapper holds less
      // than the floor we drain everything we can (the rebalancer will surface
      // any further shortfall by the next tick).
      const capped = capRedeemBurnRaw(
        rawAsk > 0n ? rawAsk : 1n,
        suppliedPos.marketCoinAmount,
      );
      const marketCoinToRedeem =
        capped !== null
          ? capped
          : suppliedPos.marketCoinAmount; // entry below floor: redeem what's there

      return {
        kind: "redeem",
        pmId: pm.pmId,
        protocol: supplied!,
        coinType,
        ytType: suppliedPos.ytType,
        marketCoinAmount: marketCoinToRedeem,
        reason: `cover shortfall=${shortfall} headroom=${policy.redeemHeadroom} via ${supplied} (cap=${LENDING_SAFE_MARGIN_WRAPPER_RAW})`,
      };
    }
  }

  // 2) Supply when idle balance is significantly above the minimum buffer.
  const supplyable = idle > policy.minIdleBuffer ? idle - policy.minIdleBuffer : 0n;

  // Dust filter (mirrors cdpm_web LENDING_OPPORTUNITIES + MIN_LENDING_DELTA_RAW):
  // even if `supplyable >= policy.supplyThreshold`, skip when below the
  // per-coin dust floor — gas would dominate yield on micro-amounts.
  const dustFloor = getMinLendingDeltaRaw(coinType);
  if (supplyable < dustFloor) {
    return {
      kind: "noop",
      reason: `${coinType}: supplyable ${supplyable} < dust floor ${dustFloor}`,
    };
  }

  if (supplyable >= policy.supplyThreshold) {
    const allowedProtocols = lendingProtocolsFor(coinType);
    const winner = await pickHighestApy(coinType, cfg.lending.protocols, allowedProtocols);
    if (!winner) {
      return { kind: "noop", reason: `no enabled protocol supports ${coinType}` };
    }

    // 3) If already supplied elsewhere with worse APY, prefer to redeem-and-switch
    //    next tick. Today we only switch when supplyable is enough to bootstrap a
    //    new position; otherwise we keep status quo.
    if (supplied && supplied !== winner.protocol) {
      const alt = await getApy(supplied, coinType);
      if (alt && winner.apy - alt.apy >= policy.apySwitchDeltaBps / 10_000) {
        // Issue a redeem first; supply will happen next tick once balance is back.
        return {
          kind: "redeem",
          pmId: pm.pmId,
          protocol: supplied,
          coinType,
          ytType: suppliedPos!.ytType,
          marketCoinAmount: suppliedPos!.marketCoinAmount,
          reason: `apy switch ${supplied}(${alt.apy.toFixed(4)})→${winner.protocol}(${winner.apy.toFixed(4)})`,
        };
      }
    }

    return {
      kind: "supply",
      pmId: pm.pmId,
      protocol: winner.protocol,
      coinType,
      ytType: ytTypeFor(winner.protocol, coinType),
      amount: supplyable,
      reason: `idle ${supplyable} ≥ supplyThreshold ${policy.supplyThreshold}, apy=${winner.apy.toFixed(4)}`,
    };
  }

  return { kind: "noop", reason: `${coinType}: nothing to do` };
}

async function pickHighestApy(
  coinType: string,
  protocols: { scallop: { enabled: boolean }; kai: { enabled: boolean } },
  allowedProtocols: LendingProtocol[],
): Promise<ApySnapshot | null> {
  // Intersect operator's env toggle (`LENDING_SCALLOP_ENABLED` etc.) with the
  // coin's per-protocol whitelist from `lendingConfig.LENDING_OPPORTUNITIES`.
  const scallopAllowed = protocols.scallop.enabled && allowedProtocols.includes("scallop");
  const kaiAllowed = protocols.kai.enabled && allowedProtocols.includes("kai");
  const [scallop, kai] = await Promise.all([
    scallopAllowed ? getApy("scallop", coinType) : Promise.resolve(null),
    kaiAllowed ? getApy("kai", coinType) : Promise.resolve(null),
  ]);

  if (!scallop && !kai) {
    log.debug("router: no APY available", { coinType });
    return null;
  }
  if (!kai) return scallop;
  if (!scallop) return kai;

  // Tie-break: Scallop wins when |Δapy| < SCALLOP_TIE_BREAK_BPS. Scallop's
  // supply path is lower-latency and avoids Kai's time-locked unlock schedule,
  // so the picker prefers it inside the noise band. See
  // cdpm-calculation-skill/reference/scallop-lending-math.md §10.4.
  const deltaBps = (kai.apy - scallop.apy) * 10_000;
  if (Math.abs(deltaBps) < SCALLOP_TIE_BREAK_BPS) return scallop;
  return kai.apy > scallop.apy ? kai : scallop;
}

/**
 * Resolve the YT type tag for a lending decision. Scallop has no YT type
 * (sCoin holds principal+interest in one), so the field is empty there;
 * Kai needs the vault's YT type to thread through the hot-potato PTB.
 */
function ytTypeFor(protocol: LendingProtocol, coinType: string): string {
  if (protocol !== "kai") return "";
  return getKaiAdapter().metaOf(coinType)?.ytType ?? "";
}

function ceilDiv(num: bigint, den: bigint): bigint {
  if (den === 0n) return 0n;
  return (num + den - 1n) / den;
}

/**
 * Helper used in unit tests / ad-hoc scripts. Forces a fresh APY fetch and
 * returns it for both protocols without consulting the cache directly.
 */
export async function snapshotApys(coinType: string): Promise<{
  scallop: ApySnapshot | null;
  kai: ApySnapshot | null;
}> {
  await getScallopAdapter().init();
  const [scallop, kai] = await Promise.all([
    getApy("scallop", coinType),
    getApy("kai", coinType),
  ]);
  return { scallop, kai };
}
