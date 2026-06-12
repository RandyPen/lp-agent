"""Single source of truth for the feature vector — imported by BOTH training
and serving. This is the no-train/serve-skew core of implementation-plan-v1:
there is exactly one definition of every feature, in Python, and the sidecar
assembles inference inputs through the same ``FEATURES`` list the trainer used.

Canonical input frame
---------------------
A pandas DataFrame with a tz-aware UTC ``DatetimeIndex`` on a 1-minute grid
(see ``data.alignment``) and these columns (a missing column simply makes the
features that need it NaN → default-filled, with completeness reduced):

    sui_open, sui_high, sui_low, sui_close          Binance SUIUSDC 1m OHLC
    sui_volume                                       (training only — labels)
    btc_close, eth_close                             Binance BTC/ETH 1m close
    funding, oi, liq_1m                              derivatives scalars

NaN policy (explicit, deterministic)
------------------------------------
1. Every feature is computed vectorised over the frame; rows lacking history
   or inputs are NaN.
2. ``feature_completeness`` for a row = fraction of non-NaN features *before*
   filling.
3. NaNs are then filled with the per-feature ``default`` declared below
   (returns/deltas → 0.0, σ estimators → 0.0, vol_ratio → 1.0, corr → 0.0).
   The defaults are part of the model contract: training and serving fill
   identically.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import pandas as pd

from features import cross_asset, derivatives, momentum, time as time_features, volatility


@dataclass(frozen=True)
class FeatureSpec:
    """One feature: a name, a pure frame→Series function, the canonical
    columns it consumes, and the value used to fill NaNs."""

    name: str
    fn: Callable[[pd.DataFrame], pd.Series]
    inputs: tuple[str, ...]
    default: float


_OHLC = ("sui_open", "sui_high", "sui_low", "sui_close")

FEATURES: tuple[FeatureSpec, ...] = (
    # — momentum —
    FeatureSpec("ret_5m", momentum.ret_5m, ("sui_close",), 0.0),
    FeatureSpec("ret_15m", momentum.ret_15m, ("sui_close",), 0.0),
    FeatureSpec("ret_30m", momentum.ret_30m, ("sui_close",), 0.0),
    FeatureSpec("ret_60m", momentum.ret_60m, ("sui_close",), 0.0),
    FeatureSpec("accel_5m", momentum.accel_5m, ("sui_close",), 0.0),
    # — volatility (mirrors src/forecast/volatility.ts) —
    FeatureSpec("ewma_sigma", volatility.ewma_sigma, ("sui_close",), 0.0),
    FeatureSpec("parkinson_30m", volatility.parkinson_30m, ("sui_high", "sui_low"), 0.0),
    FeatureSpec("gk_30m", volatility.gk_30m, _OHLC, 0.0),
    FeatureSpec("vol_ratio", volatility.vol_ratio, ("sui_close",), 1.0),
    FeatureSpec("atr_14", volatility.atr_14, ("sui_high", "sui_low", "sui_close"), 0.0),
    # — cross-asset —
    FeatureSpec("btc_ret_5m", cross_asset.btc_ret_5m, ("btc_close",), 0.0),
    FeatureSpec("btc_ret_30m", cross_asset.btc_ret_30m, ("btc_close",), 0.0),
    FeatureSpec("eth_ret_30m", cross_asset.eth_ret_30m, ("eth_close",), 0.0),
    FeatureSpec("corr_btc_30m", cross_asset.corr_btc_30m, ("sui_close", "btc_close"), 0.0),
    FeatureSpec("rel_strength_btc", cross_asset.rel_strength_btc, ("sui_close", "btc_close"), 0.0),
    # — derivatives —
    FeatureSpec("funding_rate", derivatives.funding_rate, ("funding",), 0.0),
    FeatureSpec("funding_ma_8h", derivatives.funding_ma_8h, ("funding",), 0.0),
    FeatureSpec("oi_change_30m", derivatives.oi_change_30m, ("oi",), 0.0),
    FeatureSpec("liq_volume_5m", derivatives.liq_volume_5m, ("liq_1m",), 0.0),
    # — time —
    FeatureSpec("hod_sin", time_features.hod_sin, (), 0.0),
    FeatureSpec("hod_cos", time_features.hod_cos, (), 0.0),
    FeatureSpec("dow_sin", time_features.dow_sin, (), 0.0),
    FeatureSpec("dow_cos", time_features.dow_cos, (), 0.0),
)

FEATURE_NAMES: list[str] = [spec.name for spec in FEATURES]


def build_feature_matrix(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Compute the full feature matrix for every row of the canonical frame.

    Returns ``(X, completeness)`` where ``X`` is default-filled (model-ready,
    columns in ``FEATURE_NAMES`` order) and ``completeness`` is the per-row
    fraction of features that were non-NaN before filling.
    """
    if not isinstance(df.index, pd.DatetimeIndex):
        raise ValueError("build_feature_matrix: frame needs a DatetimeIndex")

    columns: dict[str, pd.Series] = {}
    available = set(df.columns)
    for spec in FEATURES:
        if set(spec.inputs) <= available:
            series = spec.fn(df).astype(float)
        else:
            series = pd.Series(np.nan, index=df.index, dtype=float)
        columns[spec.name] = series

    raw = pd.DataFrame(columns, index=df.index, columns=FEATURE_NAMES)
    completeness = raw.notna().sum(axis=1) / len(FEATURES)
    filled = raw.fillna({spec.name: spec.default for spec in FEATURES})
    return filled, completeness


def build_feature_vector(df: pd.DataFrame) -> tuple[np.ndarray, float]:
    """Last-row feature vector for serving.

    Returns ``(x, completeness)`` with ``x`` of shape ``(1, len(FEATURES))``
    ready for ``Booster.predict`` — produced by exactly the same code path as
    training rows.
    """
    if len(df) == 0:
        raise ValueError("build_feature_vector: empty frame")
    X, completeness = build_feature_matrix(df)
    return X.iloc[[-1]].to_numpy(dtype=float), float(completeness.iloc[-1])
