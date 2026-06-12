"""Fee-revenue model calibrated from real Cetus swap events (plan W5).

Iron rule #2 of backtest-framework-design.md: fee revenue is calibrated from
**on-chain Cetus swap events** (backfilled in W1 by the TS-side scanner),
never extrapolated from Binance volume.

Input schema — one row per Cetus swap event
-------------------------------------------
``pd.DataFrame`` with columns:

    ts_ms      int    event timestamp, epoch milliseconds
    bin_id     int    active bin the swap (segment) executed in
    amount_in  float  swap input amount in the input token's display units
    fee_rate   float  pool fee rate as a fraction (e.g. 0.004 for 0.4 %)

A swap crossing multiple bins appears as multiple rows (one per bin segment),
which is how the on-chain SwapEvent data decomposes.

Core identity: an LP's fee revenue from one swap segment is

    amount_in × fee_rate × (own liquidity in bin / total bin liquidity)
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import pandas as pd

REQUIRED_COLUMNS = ("ts_ms", "bin_id", "amount_in", "fee_rate")
MS_PER_DAY = 86_400_000


def _validate_events(events: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED_COLUMNS if c not in events.columns]
    if missing:
        raise ValueError(f"fee_model: events missing columns {missing}")
    if len(events) == 0:
        raise ValueError("fee_model: empty events frame")
    if (events["amount_in"] < 0).any() or (events["fee_rate"] < 0).any():
        raise ValueError("fee_model: negative amount_in / fee_rate")


def fee_revenue(
    events: pd.DataFrame,
    our_liquidity: Mapping[int, float],
    pool_liquidity: Mapping[int, float],
) -> float:
    """Total fee revenue our liquidity would have earned over ``events``.

    ``our_liquidity`` / ``pool_liquidity`` map bin_id → liquidity (same
    units). ``pool_liquidity`` must already include our share; a bin where we
    claim more than the pool holds is a data error and raises.
    """
    _validate_events(events)
    total = 0.0
    for bin_id, ours in our_liquidity.items():
        if ours == 0:
            continue
        if ours < 0:
            raise ValueError(f"fee_revenue: negative own liquidity in bin {bin_id}")
        pool = pool_liquidity.get(bin_id)
        if pool is None or pool <= 0:
            raise ValueError(f"fee_revenue: no pool liquidity recorded for bin {bin_id}")
        if ours > pool:
            raise ValueError(
                f"fee_revenue: own liquidity {ours} exceeds pool liquidity {pool} in bin {bin_id}"
            )
        share = ours / pool
        segment = events[events["bin_id"] == bin_id]
        total += float((segment["amount_in"] * segment["fee_rate"]).sum()) * share
    return total


@dataclass(frozen=True)
class FeeCalibration:
    """Summary of historical fee-volume flow, used by the W5 economics table."""

    span_days: float
    total_fee_volume: float  # Σ amount_in × fee_rate over the window
    daily_fee_volume: float  # total / span_days
    fee_volume_by_bin: dict[int, float]  # per-bin share of total_fee_volume


def calibrate(events: pd.DataFrame) -> FeeCalibration:
    """Calibrate the historical fee-volume distribution from swap events."""
    _validate_events(events)
    span_ms = int(events["ts_ms"].max() - events["ts_ms"].min())
    if span_ms <= 0:
        raise ValueError("fee_model.calibrate: events must span a positive time window")
    span_days = span_ms / MS_PER_DAY

    fee_volume = events["amount_in"] * events["fee_rate"]
    by_bin = fee_volume.groupby(events["bin_id"]).sum()
    total = float(fee_volume.sum())
    return FeeCalibration(
        span_days=span_days,
        total_fee_volume=total,
        daily_fee_volume=total / span_days,
        fee_volume_by_bin={int(k): float(v) for k, v in by_bin.items()},
    )


def expected_daily_fee(
    calibration: FeeCalibration,
    share_by_bin: Mapping[int, float],
) -> float:
    """Expected daily fee revenue for a liquidity-share profile.

    ``share_by_bin`` maps bin_id → our share of that bin's liquidity in
    [0, 1]. Bins we hold no share in contribute nothing; historical bins are
    scaled to a per-day rate using the calibration window length."""
    total = 0.0
    for bin_id, share in share_by_bin.items():
        if not 0.0 <= share <= 1.0:
            raise ValueError(f"expected_daily_fee: share for bin {bin_id} outside [0, 1]")
        volume = calibration.fee_volume_by_bin.get(int(bin_id), 0.0)
        total += volume * share
    return total / calibration.span_days
