/**
 * The PnL backtest must produce numbers you can actually rank strategies with.
 * These pin the accounting identities and the two behaviours that would silently
 * corrupt a comparison:
 *
 *   - cross-tick strategy state must persist (presenceSweep reads back its fill
 *     boundary; without it, it degenerates into presenceAnchor and the backtest
 *     reports two different strategies as identical);
 *   - an invalid plan must abort, not be quietly simulated — a backtest that
 *     credits profits the chain would never have paid is worse than no backtest.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { runPnlBacktest, type StoredSwapEvent } from "../../src/backtest/pnlReplay.ts";
import { registerStrategy, resetCustomStrategiesForTests } from "../../src/strategies/registry.ts";
import type { RawDlmmSwapEvent } from "../../src/services/shadowBook.ts";
import type { StrategyInput, StrategyOutput } from "../../src/strategies/types.ts";
import { makeTestProfile } from "../helpers/index.ts";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

// Physical order for SUI/USDC: A = USDC (6dp), B = SUI (9dp).
const PHYS_A = USDC;
const PHYS_B = SUI;

const profile = makeTestProfile();
let tmp: string;

function rawSwap(bins: { bin: number; amountIn: string; amountOut: string; fee: string }[], inputName: string): RawDlmmSwapEvent {
  return {
    pool: "0xpool",
    amount_in: "0",
    amount_out: "0",
    fee: "0",
    bin_swaps: bins.map((b) => ({
      bin_id: { bits: b.bin >= 0 ? b.bin : b.bin + 0x100000000 },
      amount_in: b.amountIn,
      amount_out: b.amountOut,
      fee: b.fee,
    })),
    from: { name: inputName },
    target: { name: inputName === USDC ? SUI : USDC },
  };
}

/** A steady stream of swaps crossing bins around the active bin. */
function makeSwaps(count: number, startTs = 1_700_000_000_000): StoredSwapEvent[] {
  const out: StoredSwapEvent[] = [];
  for (let i = 0; i < count; i++) {
    // Alternate direction so the book gets filled on both sides.
    const inputName = i % 2 === 0 ? USDC : SUI;
    const bin = 1445 + (i % 3) - 1; // 1444, 1445, 1446 …
    out.push({
      tsMs: startTs + i * 60_000,
      raw: rawSwap(
        [
          { bin, amountIn: "1000000", amountOut: "1000000", fee: "2500" },
          { bin: bin + 1, amountIn: "1000000", amountOut: "1000000", fee: "2500" },
        ],
        inputName,
      ),
    });
  }
  return out;
}

beforeEach(() => {
  resetDbCacheForTests();
  resetCustomStrategiesForTests();
  tmp = mkdtempSync(join(tmpdir(), "pnl-replay-"));
  openDb(join(tmp, "test.db"));
});

afterEach(() => {
  resetCustomStrategiesForTests();
  resetDbCacheForTests();
  rmSync(tmp, { recursive: true, force: true });
});

const base = {
  profile,
  initialA: 100_000_000n, // 100 USDC
  initialB: 135_000_000_000n, // 135 SUI
  physicalTypeA: PHYS_A,
  physicalTypeB: PHYS_B,
};

describe("runPnlBacktest", () => {
  it("reports fee income, IL and vs-HODL over real fills", async () => {
    const { summary, samples } = await runPnlBacktest({
      ...base,
      strategyName: "multiBinSpot",
      swaps: makeSwaps(120),
    });

    expect(summary.swapsReplayed).toBe(120);
    expect(samples.length).toBeGreaterThan(0);
    expect(summary.rebalances).toBeGreaterThan(0);

    // Accounting identity: NAV = HODL + fees + IL, by construction of `il`.
    const reconstructed = summary.finalHodlQuote + summary.feeIncomeQuote + summary.ilQuote;
    expect(Math.abs(reconstructed - summary.finalNavQuote)).toBeLessThan(1e-6);

    // A position that took fills must have earned fees.
    expect(summary.fills).toBeGreaterThan(0);
    expect(summary.feeIncomeQuote).toBeGreaterThan(0);
  });

  it("persists cross-tick state, so a stateful strategy is not silently crippled", async () => {
    // presenceSweep reads its fill boundary back from position_state. If the
    // replay dropped it, the strategy would behave like presenceAnchor and the
    // backtest would report two different strategies as identical.
    let sawBoundaryReadBack = false;

    registerStrategy("boundary-probe", () => ({
      name: "boundary-probe",
      async plan(input: StrategyInput): Promise<StrategyOutput> {
        // positionState is keyed on pmId; the replay must have used a stable one.
        const { loadPositionState } = await import("../../src/strategies/positionState.ts");
        const st = loadPositionState(input.pm.pmId);
        if (st?.fillBoundaryBinId === 4242) sawBoundaryReadBack = true;

        return {
          kind: "plan_and_reconcile",
          fillBoundary: 4242,
          plan: {
            pmId: input.pm.pmId,
            removeShares: new Map(),
            addAmountA: 0n,
            addAmountB: 0n,
            addBins: [],
            addAmountsA: [],
            addAmountsB: [],
            collectFees: false,
            reason: "probe",
            plannedActiveBinId: input.pool.activeBinId,
          },
        };
      },
    }));

    await runPnlBacktest({ ...base, strategyName: "boundary-probe", swaps: makeSwaps(10) });

    expect(sawBoundaryReadBack).toBe(true);
  });

  it("ABORTS on a physically invalid plan rather than simulating fake profits", async () => {
    registerStrategy("bad-orientation", () => ({
      name: "bad-orientation",
      async plan(input: StrategyInput): Promise<StrategyOutput> {
        const active = input.pool.activeBinId;
        return {
          kind: "plan_and_reconcile",
          plan: {
            pmId: input.pm.pmId,
            removeShares: new Map(),
            // Inverted side-split: coinB above the active bin, coinA below.
            addAmountA: 100n,
            addAmountB: 200n,
            addBins: [active - 1, active + 1],
            addAmountsA: [100n, 0n],
            addAmountsB: [0n, 200n],
            collectFees: false,
            reason: "wrong side",
            plannedActiveBinId: active,
          },
        };
      },
    }));

    await expect(
      runPnlBacktest({ ...base, strategyName: "bad-orientation", swaps: makeSwaps(5) }),
    ).rejects.toThrow(/invalid plan/);
  });

  it("throws rather than reporting an empty result when there are no swaps", async () => {
    await expect(
      runPnlBacktest({ ...base, strategyName: "multiBinSpot", swaps: [] }),
    ).rejects.toThrow(/no swap events/);
  });
});
