"""Cross-asset features: BTC/ETH returns, rolling correlation, relative strength.

Inputs: canonical frame columns ``sui_close``, ``btc_close``, ``eth_close``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

CORR_WINDOW = 30


def _log_return(close: pd.Series, minutes: int) -> pd.Series:
    return np.log(close / close.shift(minutes))


def btc_ret_5m(df: pd.DataFrame) -> pd.Series:
    """5-minute BTC log return."""
    return _log_return(df["btc_close"], 5)


def btc_ret_30m(df: pd.DataFrame) -> pd.Series:
    """30-minute BTC log return."""
    return _log_return(df["btc_close"], 30)


def eth_ret_30m(df: pd.DataFrame) -> pd.Series:
    """30-minute ETH log return."""
    return _log_return(df["eth_close"], 30)


def corr_btc_30m(df: pd.DataFrame) -> pd.Series:
    """Rolling 30-bar Pearson correlation between SUI and BTC 1-min returns."""
    r_sui = _log_return(df["sui_close"], 1)
    r_btc = _log_return(df["btc_close"], 1)
    return r_sui.rolling(CORR_WINDOW, min_periods=CORR_WINDOW).corr(r_btc)


def rel_strength_btc(df: pd.DataFrame) -> pd.Series:
    """SUI 30-min return minus BTC 30-min return (idiosyncratic drift)."""
    return _log_return(df["sui_close"], 30) - _log_return(df["btc_close"], 30)
