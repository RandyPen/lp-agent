"""Label generation for the volatility model.

One label per sample timestamp T, built from the strictly-future window
``(T, T + horizon]`` (the bar at T itself is *feature* territory):

* ``label_vol`` — population std (ddof=0) of the ``horizon`` 1-minute log
  returns inside the future window, i.e. a per-bar σ on the same scale as the
  ``ewma_sigma`` feature.

There is deliberately NO price-center label. The pipeline originally also
produced ``label_center`` (future VWAP as a continuous bin offset) and trained
q10/q50/q90 quantile heads on it; walk-forward falsified that head
(center MAE *worse* than centering on spot, direction ≈ coin flip) — see
docs/decision-remove-center-prediction.md. The serving distribution is
center ≡ spot with width from the vol head.

Future-window truncation: rows whose window extends past the end of the
series are **dropped, not padded** — the last ``horizon`` rows of the input
never produce labels.

``bin_of`` / ``bin_offset`` remain here as the canonical price↔bin unit
conversions (used by the backtest harness and by σ→bin scaling).
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

DEFAULT_HORIZON_BARS = 30
DEFAULT_BIN_STEP = 0.005

# Guard against float noise pushing an exact bin boundary below the floor.
_BIN_EPS = 1e-9


def bin_of(price: float, base_price: float, bin_step: float = DEFAULT_BIN_STEP) -> int:
    """Integer DLMM bin id of ``price`` relative to ``base_price``:
    ``floor(log(price / base) / log(1 + bin_step))`` with an epsilon guard so
    exact boundaries land in the upper bin despite float noise."""
    if price <= 0 or base_price <= 0:
        raise ValueError("bin_of: prices must be positive")
    if bin_step <= 0:
        raise ValueError("bin_of: bin_step must be positive")
    return math.floor(math.log(price / base_price) / math.log(1.0 + bin_step) + _BIN_EPS)


def bin_offset(price: float, base_price: float, bin_step: float = DEFAULT_BIN_STEP) -> float:
    """Continuous bin offset of ``price`` relative to ``base_price``."""
    if price <= 0 or base_price <= 0:
        raise ValueError("bin_offset: prices must be positive")
    return math.log(price / base_price) / math.log(1.0 + bin_step)


def _future_window_sum(values: np.ndarray, horizon: int) -> np.ndarray:
    """Sum of ``values[T+1 .. T+horizon]`` for each T (the (T, T+h] window).

    NaN where the window is truncated at the series end, and NaN where any
    value inside the window is NaN — a single bad bar invalidates the label
    rather than being silently skipped.
    """
    n = len(values)
    nan_mask = np.isnan(values)
    clean = np.where(nan_mask, 0.0, values)
    cum = np.concatenate([[0.0], np.cumsum(clean, dtype=float)])
    cum_nan = np.concatenate([[0], np.cumsum(nan_mask.astype(np.int64))])

    out = np.full(n, np.nan)
    valid = n - horizon
    if valid > 0:
        # window sum for T=i is cum[i+1+horizon] - cum[i+1]
        sums = cum[1 + horizon : 1 + horizon + valid] - cum[1 : 1 + valid]
        nans = cum_nan[1 + horizon : 1 + horizon + valid] - cum_nan[1 : 1 + valid]
        out[:valid] = np.where(nans == 0, sums, np.nan)
    return out


def future_offset(
    df: pd.DataFrame,
    horizon: int = DEFAULT_HORIZON_BARS,
    bin_step: float = DEFAULT_BIN_STEP,
    close_col: str = "sui_close",
) -> pd.Series:
    """Realized end-of-horizon bin offset: ``log(close_{T+h}/close_T)/log(1+step)``.

    NOT a training label — walk-forward uses it as the *evaluation* yardstick
    for σ-band calibration (does ±1.28·σ̂ cover ~80 % of realized offsets),
    which guards the σ-scaling constant that serving's pAbove/pBelow use.
    NaN where the horizon extends past the series end.
    """
    if horizon < 1:
        raise ValueError("future_offset: horizon must be >= 1")
    if close_col not in df.columns:
        raise ValueError(f"future_offset: missing column {close_col!r}")
    close = df[close_col].astype(float)
    with np.errstate(invalid="ignore", divide="ignore"):
        offset = np.log(close.shift(-horizon) / close) / np.log(1.0 + bin_step)
    return pd.Series(offset, index=df.index, name="future_offset")


def make_labels(
    df: pd.DataFrame,
    horizon: int = DEFAULT_HORIZON_BARS,
    close_col: str = "sui_close",
) -> pd.DataFrame:
    """Build ``label_vol`` for each row of ``df``.

    ``df`` is the canonical aligned frame (see ``features.registry``) on a
    1-minute grid. Returns a frame indexed by the subset of ``df.index`` that
    has a complete future window and no NaN inputs inside it; everything else
    (including the last ``horizon`` rows) is dropped.
    """
    if horizon < 1:
        raise ValueError("make_labels: horizon must be >= 1")
    if close_col not in df.columns:
        raise ValueError(f"make_labels: missing column {close_col!r}")

    close = df[close_col].to_numpy(dtype=float)

    # Future per-bar σ: population std of the horizon 1-min log returns.
    with np.errstate(invalid="ignore", divide="ignore"):
        log_close = np.log(close)
    r = np.diff(log_close, prepend=np.nan)  # r[t] = log return ending at bar t
    # Returns inside (T, T+h] are exactly r[T+1] .. r[T+h], which is what
    # _future_window_sum sums; r[0] (NaN by construction) is never inside any window.
    r_sum = _future_window_sum(r, horizon)
    r2_sum = _future_window_sum(r * r, horizon)
    with np.errstate(invalid="ignore"):
        mean = r_sum / horizon
        var = r2_sum / horizon - mean * mean
        label_vol = np.sqrt(np.clip(var, 0.0, None))

    out = pd.DataFrame({"label_vol": label_vol}, index=df.index)
    return out.dropna()
