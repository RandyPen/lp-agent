"""Price-momentum features over the SUI 1-minute close series.

All functions take the canonical aligned frame (UTC 1-min DatetimeIndex,
``sui_close`` column — see ``features.registry``) and return a Series aligned
to the frame's index. Rows without enough history are NaN; the registry's
documented NaN policy fills them with each feature's default.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _log_return(close: pd.Series, minutes: int) -> pd.Series:
    return np.log(close / close.shift(minutes))


def ret_5m(df: pd.DataFrame) -> pd.Series:
    """5-minute log return of SUI close."""
    return _log_return(df["sui_close"], 5)


def ret_15m(df: pd.DataFrame) -> pd.Series:
    """15-minute log return of SUI close."""
    return _log_return(df["sui_close"], 15)


def ret_30m(df: pd.DataFrame) -> pd.Series:
    """30-minute log return of SUI close."""
    return _log_return(df["sui_close"], 30)


def ret_60m(df: pd.DataFrame) -> pd.Series:
    """60-minute log return of SUI close."""
    return _log_return(df["sui_close"], 60)


def accel_5m(df: pd.DataFrame) -> pd.Series:
    """Momentum acceleration: ret_5m now minus ret_5m five minutes ago."""
    r5 = _log_return(df["sui_close"], 5)
    return r5 - r5.shift(5)
