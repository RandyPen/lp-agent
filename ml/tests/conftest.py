"""Shared synthetic fixtures — all tests run on generated data, zero network."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

SEED = 1234


def make_ohlcv(
    n: int,
    seed: int = SEED,
    start: str = "2025-01-06",
    freq: str = "1min",
    drift: float = 0.0,
    vol: float = 0.001,
    start_price: float = 1.0,
) -> pd.DataFrame:
    """Random-walk OHLCV bars on a UTC 1-min grid (deterministic per seed)."""
    rng = np.random.default_rng(seed)
    r = rng.normal(drift, vol, n)
    close = start_price * np.exp(np.cumsum(r))
    open_ = np.concatenate([[start_price], close[:-1]])
    wick = np.abs(rng.normal(0.0, vol, n)) * close
    high = np.maximum(open_, close) + wick
    low = np.minimum(open_, close) - wick
    volume = rng.uniform(10.0, 100.0, n)
    index = pd.date_range(start, periods=n, freq=freq, tz="UTC", name="ts")
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=index,
    )


def make_canonical_frame(n: int = 800, seed: int = SEED) -> pd.DataFrame:
    """Synthetic canonical aligned frame (see features.registry docstring)."""
    rng = np.random.default_rng(seed + 99)
    sui = make_ohlcv(n, seed)
    btc = make_ohlcv(n, seed + 1, start_price=100.0)
    eth = make_ohlcv(n, seed + 2, start_price=10.0)
    return pd.DataFrame(
        {
            "sui_open": sui["open"],
            "sui_high": sui["high"],
            "sui_low": sui["low"],
            "sui_close": sui["close"],
            "sui_volume": sui["volume"],
            "btc_close": btc["close"].to_numpy(),
            "eth_close": eth["close"].to_numpy(),
            "funding": rng.normal(0.0001, 0.0002, n),
            "oi": np.abs(1_000_000.0 + np.cumsum(rng.normal(0, 1000, n))),
            "liq_1m": np.abs(rng.normal(0, 5000, n)),
        },
        index=sui.index,
    )


def make_training_set(n: int = 800, seed: int = SEED):
    """(X, y_vol) built through the real feature/label pipeline."""
    from data.labels import make_labels
    from features.registry import build_feature_matrix

    frame = make_canonical_frame(n, seed)
    X, _ = build_feature_matrix(frame)
    labels = make_labels(frame)
    X = X.loc[labels.index]
    return X, labels["label_vol"]


@pytest.fixture
def canonical_frame() -> pd.DataFrame:
    return make_canonical_frame()
