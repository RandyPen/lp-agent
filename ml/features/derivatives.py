"""Derivatives features: funding-rate level/trend, OI change, liquidation flow.

Inputs: canonical frame columns ``funding`` (8h funding rate, forward-filled
onto the 1-min grid by the alignment layer), ``oi`` (open interest, base
units) and ``liq_1m`` (liquidation notional in the trailing minute).

At serving time the ``MarketSnapshot`` only carries point-in-time scalars, so
the rolling/delta features here are NaN (no history) and fall back to their
documented defaults — that loss is reflected in ``featureCompleteness``
instead of being faked by broadcasting constants.
"""

from __future__ import annotations

import pandas as pd

FUNDING_MA_WINDOW = 480  # 8h of 1-min bars
OI_CHANGE_WINDOW = 30
LIQ_SUM_WINDOW = 5


def funding_rate(df: pd.DataFrame) -> pd.Series:
    """Current funding rate (as forward-filled onto the grid)."""
    return df["funding"]


def funding_ma_8h(df: pd.DataFrame) -> pd.Series:
    """8-hour rolling mean of the funding rate."""
    return df["funding"].rolling(FUNDING_MA_WINDOW, min_periods=FUNDING_MA_WINDOW).mean()


def oi_change_30m(df: pd.DataFrame) -> pd.Series:
    """Relative open-interest change over 30 minutes; non-positive OI is invalid."""
    oi = df["oi"].where(df["oi"] > 0)
    return oi / oi.shift(OI_CHANGE_WINDOW) - 1.0


def liq_volume_5m(df: pd.DataFrame) -> pd.Series:
    """Liquidation notional summed over the trailing 5 minutes."""
    return df["liq_1m"].rolling(LIQ_SUM_WINDOW, min_periods=LIQ_SUM_WINDOW).sum()
