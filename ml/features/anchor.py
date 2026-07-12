"""Anchor-deviation features — how far price is stretched from its slow mean.

Motivation (operator study on 12 months of SUIUSDC 1m data, 2025-07→2026-07):
SUI mean-reverts at 30min–1d scales (VR(60m)=0.64, Hurst≈0.43; OU half-life
≈1h against a 4h rolling anchor), and forward 60–120m net returns correlate
NEGATIVELY with the current deviation from the 4h anchor (corr ≈ −0.11 —
stretched high → reverts down).

OUTCOME (2026-07, recorded so nobody re-runs this experiment): these features
were added to give the q50 center head a reversion coordinate. They did NOT
rescue it — with them included, walk-forward center MAE stayed WORSE than
centering on spot (ratio 1.009 @h60 / 1.012 @h120; the −0.11 correlation is
an R²≈0.01 signal, below the point-forecast noise floor). The center head was
removed (docs/decision-remove-center-prediction.md). The features are
RETAINED as regime/stretch descriptors: candidate inputs for the vol head
(untested lift) and required inputs for the planned p_break classification
head. Directional use of the reversion signal lives in the rule-based
presence strategies (regime-gated anchor pull), not in a trained head.

All features use only ``sui_close`` — computable both from the training
parquet and at serving time (the live feed keeps 480 1m bars = 8h, enough
for the 4h window; see src/data/feeds/binanceMulti.ts).

Definitions (log units, per the registry NaN policy — insufficient history
→ NaN → default-filled with 0.0):

    dev_<w>   = log(close) − rolling_mean(log(close), w)
    dev_z_4h  = dev_4h / (ewma_sigma × √240)   (deviation in σ-of-horizon units)
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from features.volatility import ewma_sigma

DEV_WINDOWS = {"dev_30m": 30, "dev_1h": 60, "dev_4h": 240}
_Z_WINDOW = 240


def _dev(df: pd.DataFrame, window: int) -> pd.Series:
    log_close = np.log(df["sui_close"])
    anchor = log_close.rolling(window, min_periods=window).mean()
    return log_close - anchor


def dev_30m(df: pd.DataFrame) -> pd.Series:
    """Log deviation from the 30-min rolling mean of log close."""
    return _dev(df, DEV_WINDOWS["dev_30m"])


def dev_1h(df: pd.DataFrame) -> pd.Series:
    """Log deviation from the 1-hour rolling mean of log close."""
    return _dev(df, DEV_WINDOWS["dev_1h"])


def dev_4h(df: pd.DataFrame) -> pd.Series:
    """Log deviation from the 4-hour rolling mean of log close (the primary
    reversion anchor per the operator study)."""
    return _dev(df, DEV_WINDOWS["dev_4h"])


def dev_z_4h(df: pd.DataFrame) -> pd.Series:
    """4h anchor deviation expressed in units of σ scaled to the 4h horizon
    (√240 × per-bar EWMA σ) — "how stretched, relative to current vol"."""
    dev = _dev(df, _Z_WINDOW)
    sigma_h = ewma_sigma(df) * np.sqrt(_Z_WINDOW)
    with np.errstate(divide="ignore", invalid="ignore"):
        z = dev / sigma_h
    return z.replace([np.inf, -np.inf], np.nan)
