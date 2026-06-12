"""Cyclical time-of-day / day-of-week features.

Derived purely from the frame's UTC DatetimeIndex, so they are always present
(never NaN) regardless of market-data coverage.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

_TWO_PI = 2.0 * np.pi


def _hour_fraction(index: pd.DatetimeIndex) -> np.ndarray:
    return (index.hour + index.minute / 60.0) / 24.0


def hod_sin(df: pd.DataFrame) -> pd.Series:
    """sin(2π · hour-of-day / 24)."""
    return pd.Series(np.sin(_TWO_PI * _hour_fraction(df.index)), index=df.index)


def hod_cos(df: pd.DataFrame) -> pd.Series:
    """cos(2π · hour-of-day / 24)."""
    return pd.Series(np.cos(_TWO_PI * _hour_fraction(df.index)), index=df.index)


def dow_sin(df: pd.DataFrame) -> pd.Series:
    """sin(2π · day-of-week / 7), Monday = 0."""
    return pd.Series(np.sin(_TWO_PI * df.index.dayofweek / 7.0), index=df.index)


def dow_cos(df: pd.DataFrame) -> pd.Series:
    """cos(2π · day-of-week / 7), Monday = 0."""
    return pd.Series(np.cos(_TWO_PI * df.index.dayofweek / 7.0), index=df.index)
