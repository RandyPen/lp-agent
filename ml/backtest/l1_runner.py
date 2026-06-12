"""L1 bar-replay backtest harness — **relative ranking only** (plan W5).

Iron rule #1 of backtest-framework-design.md: the absolute PnL of an L1
replay is meaningless (full-fill assumption, Binance volume as a proxy for
on-chain flow). The only valid read-out is the *ordering* of strategies run
through the same simulator over the same window — e.g. "mlAgent ≥
multiBinSpot under L1".

Simplifications (deliberate, documented):

* full fill — when the bar's price range overlaps our quoted bin range, the
  overlapping fraction of the bar's notional is credited at ``fee_rate``
  with share 1.0 (no pool-liquidity competition; that is L2/L3 territory);
* no inventory / IL accounting — in-range time and fee capture are the
  ranking signals at this fidelity;
* a flat per-rebalance cost in score units penalises churn.

Strategy stubs implement the minimal ``StrategyStub`` protocol so a
Python-side port of any quoting rule (or a batch model inference) can be
ranked without touching the TS runtime.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Protocol

import numpy as np
import pandas as pd

from data.collectors.binance_klines import parse_utc_ms
from data.labels import DEFAULT_BIN_STEP, bin_of
from data.parquet_writer import DEFAULT_DATA_ROOT, read_partitioned

DEFAULT_DECISION_INTERVAL = 30  # bars between re-quotes
DEFAULT_WARMUP_BARS = 60
DEFAULT_FEE_RATE = 0.004
DEFAULT_REBALANCE_COST = 0.05  # score units per re-quote (gas proxy)


@dataclass(frozen=True)
class Quote:
    """A symmetric-by-construction bin range quote: [center − hw, center + hw]."""

    center_bin: int
    half_width: int


class StrategyStub(Protocol):
    """Minimal python-side strategy interface for L1 ranking."""

    name: str

    def quote(self, history: pd.DataFrame) -> Quote:
        """Return a quote given all bars up to and including 'now'.

        ``history`` columns: open, high, low, close, volume; the last row is
        the current bar. Implementations must not look ahead."""
        ...


@dataclass(frozen=True)
class L1Result:
    name: str
    fees: float
    time_in_range_frac: float
    rebalances: int
    score: float  # fees − rebalances × rebalance_cost; ranking key ONLY


class SymmetricStub:
    """Baseline: re-quote symmetrically around the current bin."""

    def __init__(self, half_width: int = 3) -> None:
        self.name = f"symmetric_hw{half_width}"
        self._half_width = half_width

    def quote(self, history: pd.DataFrame) -> Quote:
        price = float(history["close"].iloc[-1])
        base = float(history["close"].iloc[0])
        return Quote(bin_of(price, base), self._half_width)


class MomentumStub:
    """Shifts the quote center one bin toward the trailing 30-bar drift."""

    def __init__(self, half_width: int = 3, lookback: int = 30) -> None:
        self.name = f"momentum_hw{half_width}"
        self._half_width = half_width
        self._lookback = lookback

    def quote(self, history: pd.DataFrame) -> Quote:
        closes = history["close"]
        price = float(closes.iloc[-1])
        base = float(closes.iloc[0])
        center = bin_of(price, base)
        if len(closes) > self._lookback:
            drift = float(np.log(price / closes.iloc[-1 - self._lookback]))
            center += int(np.sign(drift))
        return Quote(center, self._half_width)


def _bar_overlap_fraction(
    bar_low_bin: int, bar_high_bin: int, range_low: int, range_high: int
) -> float:
    """Fraction of the bins the bar spanned that fall inside our quote range."""
    span = bar_high_bin - bar_low_bin + 1
    overlap = min(bar_high_bin, range_high) - max(bar_low_bin, range_low) + 1
    return max(overlap, 0) / span


def run_l1(
    bars: pd.DataFrame,
    strategies: list[StrategyStub],
    bin_step: float = DEFAULT_BIN_STEP,
    fee_rate: float = DEFAULT_FEE_RATE,
    decision_interval: int = DEFAULT_DECISION_INTERVAL,
    warmup: int = DEFAULT_WARMUP_BARS,
    rebalance_cost: float = DEFAULT_REBALANCE_COST,
) -> list[L1Result]:
    """Replay ``bars`` (columns open/high/low/close/volume) through each
    strategy. Returns results sorted best-first by ``score``."""
    required = {"open", "high", "low", "close", "volume"}
    if not required <= set(bars.columns):
        raise ValueError(f"run_l1: bars need columns {sorted(required)}")
    if len(bars) <= warmup + decision_interval:
        raise ValueError("run_l1: not enough bars for warmup + one decision interval")

    base_price = float(bars["close"].iloc[0])
    low_bins = np.array([bin_of(p, base_price, bin_step) for p in bars["low"]])
    high_bins = np.array([bin_of(p, base_price, bin_step) for p in bars["high"]])
    notional = (bars["volume"] * bars["close"]).to_numpy(dtype=float)

    results = []
    for strategy in strategies:
        fees = 0.0
        in_range_bars = 0
        rebalances = 0
        quote: Quote | None = None

        for i in range(warmup, len(bars)):
            if quote is None or (i - warmup) % decision_interval == 0:
                quote = strategy.quote(bars.iloc[: i + 1])
                rebalances += 1
            lo, hi = quote.center_bin - quote.half_width, quote.center_bin + quote.half_width
            frac = _bar_overlap_fraction(int(low_bins[i]), int(high_bins[i]), lo, hi)
            if frac > 0:
                in_range_bars += 1
                fees += notional[i] * fee_rate * frac

        total_bars = len(bars) - warmup
        results.append(
            L1Result(
                name=strategy.name,
                fees=fees,
                time_in_range_frac=in_range_bars / total_bars,
                rebalances=rebalances,
                score=fees - rebalances * rebalance_cost,
            )
        )

    return sorted(results, key=lambda r: r.score, reverse=True)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="L1 bar-replay ranking of built-in strategy stubs (relative ranking only)"
    )
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_ROOT))
    parser.add_argument("--symbol", default="SUIUSDC")
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--bin-step", type=float, default=DEFAULT_BIN_STEP)
    args = parser.parse_args(argv)

    klines = read_partitioned(
        args.data_dir,
        f"binance/klines/{args.symbol}/{args.interval}",
        "open_time",
        parse_utc_ms(args.start),
        parse_utc_ms(args.end),
    )
    bars = klines[["open", "high", "low", "close", "volume"]]
    results = run_l1(bars, [SymmetricStub(3), SymmetricStub(6), MomentumStub(3)], bin_step=args.bin_step)

    print(f"{'strategy':<20} {'score':>12} {'fees':>12} {'in-range':>9} {'rebal':>6}")
    for r in results:
        print(
            f"{r.name:<20} {r.score:>12.4f} {r.fees:>12.4f} "
            f"{r.time_in_range_frac:>8.1%} {r.rebalances:>6}"
        )
    print("\nNOTE: L1 scores rank strategies within this simulator only — they are not PnL.")


if __name__ == "__main__":
    main()
