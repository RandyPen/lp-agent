"""Volatility features mirroring the TS estimators in ``src/forecast/volatility.ts``.

Same math, same constants:

* ``ewma_sigma``     — RiskMetrics EWMA (λ=0.94) on close-to-close 1-min log
                       returns, variance initialised from the first squared
                       return (exactly the TS recursion).
* ``parkinson_30m``  — √( mean of ln²(H/L) / (4·ln 2) ) over a rolling 30-bar
                       window; bars with H==L or non-positive H/L are invalid
                       (NaN), as the TS version skips them.
* ``gk_30m``         — Garman-Klass, 0.5·ln²(H/L) − (2·ln 2 − 1)·ln²(C/O),
                       negative bar values invalid, rolling 30-bar mean.
* ``vol_ratio``      — short σ (30-bar) / long σ (360-bar) of 1-min returns.
* ``atr_14``         — 14-bar average true range normalised by close
                       (unitless so it is price-scale free).

All outputs are per-1-min-bar σ in log-return units (callers scale by √h).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

EWMA_LAMBDA = 0.94
PARKINSON_FACTOR = 1.0 / (4.0 * np.log(2.0))
GK_COEF = 2.0 * np.log(2.0) - 1.0
SHORT_WINDOW = 30
LONG_WINDOW = 360
ATR_WINDOW = 14


def ewma_sigma(df: pd.DataFrame) -> pd.Series:
    """EWMA σ per 1-min bar. Matches TS ``ewmaSigma``: var₀ = r₀²,
    varₜ = λ·varₜ₋₁ + (1−λ)·rₜ²."""
    r = np.log(df["sui_close"] / df["sui_close"].shift(1))
    r2 = r * r
    # adjust=False gives y₀ = first valid x, yₜ = λ·yₜ₋₁ + (1−λ)·xₜ — the TS recursion.
    var = r2.ewm(alpha=1.0 - EWMA_LAMBDA, adjust=False).mean()
    return np.sqrt(var)


def parkinson_30m(df: pd.DataFrame) -> pd.Series:
    """Rolling 30-bar Parkinson σ; invalid bars (H==L, non-positive) are NaN."""
    high, low = df["sui_high"], df["sui_low"]
    valid = (high > 0) & (low > 0) & (high != low)
    ln = np.log(high / low).where(valid)
    x = PARKINSON_FACTOR * ln * ln
    return np.sqrt(x.rolling(SHORT_WINDOW, min_periods=SHORT_WINDOW).mean())


def gk_30m(df: pd.DataFrame) -> pd.Series:
    """Rolling 30-bar Garman-Klass σ; non-positive bar variance is invalid."""
    high, low = df["sui_high"], df["sui_low"]
    open_, close = df["sui_open"], df["sui_close"]
    valid = (high > 0) & (low > 0) & (open_ > 0) & (close > 0)
    ln_hl = np.log(high / low).where(valid)
    ln_co = np.log(close / open_).where(valid)
    v = 0.5 * ln_hl * ln_hl - GK_COEF * ln_co * ln_co
    v = v.where(v > 0)
    return np.sqrt(v.rolling(SHORT_WINDOW, min_periods=SHORT_WINDOW).mean())


def vol_ratio(df: pd.DataFrame) -> pd.Series:
    """Short-horizon σ / long-horizon σ of 1-min log returns (regime gauge)."""
    r = np.log(df["sui_close"] / df["sui_close"].shift(1))
    short = r.rolling(SHORT_WINDOW, min_periods=SHORT_WINDOW).std(ddof=0)
    long = r.rolling(LONG_WINDOW, min_periods=LONG_WINDOW).std(ddof=0)
    return short / long


def atr_14(df: pd.DataFrame) -> pd.Series:
    """14-bar ATR divided by close (unitless true-range measure)."""
    high, low, close = df["sui_high"], df["sui_low"], df["sui_close"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    atr = tr.rolling(ATR_WINDOW, min_periods=ATR_WINDOW).mean()
    return atr / close
