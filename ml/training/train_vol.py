"""LightGBM volatility-model training pipeline.

Trains ONE booster on the horizon-ahead label from ``data.labels``:

    vol    objective=regression_l1, future per-bar σ

This module was ``train_quantile.py`` until 2026-07: it also trained
q10/q50/q90 quantile heads on a future-VWAP center offset. Walk-forward
falsified the center head (worse than centering on spot; direction ≈ coin
flip) and showed the q10/q90 lift was the vol edge re-expressed — see
docs/decision-remove-center-prediction.md. The vol head is the only model.

Everything is seeded and LightGBM runs in deterministic single-strategy mode,
so a fork re-running the same data window reproduces the same artifacts
(models_meta.json records window + seed + git sha).

CLI:

    uv run python -m training.train_vol \
        --start 2025-09-01 --end 2026-03-01 \
        --version v1.0.0 [--data-dir data/parquet] [--out-dir artifacts] \
        [--seed 42] [--bin-step 0.005] [--horizon 30]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import lightgbm as lgb
import pandas as pd

from data.alignment import align_sources, from_klines, from_scalar_series
from data.collectors.binance_klines import parse_utc_ms
from data.labels import DEFAULT_BIN_STEP, DEFAULT_HORIZON_BARS, make_labels
from data.parquet_writer import DEFAULT_DATA_ROOT, read_partitioned
from features.registry import FEATURE_NAMES, build_feature_matrix
from training.export import export_artifacts

DEFAULT_SEED = 42
MODEL_KEYS: tuple[str, ...] = ("vol",)

# Hyper-parameter starting point per prediction-service-design.md §3.2.
BASE_PARAMS: dict = {
    "num_leaves": 31,
    "max_depth": 6,
    "min_data_in_leaf": 100,
    "learning_rate": 0.05,
    "lambda_l1": 0.1,
    "lambda_l2": 0.1,
    "verbosity": -1,
    "deterministic": True,
    "force_row_wise": True,
}
DEFAULT_NUM_BOOST_ROUND = 400

SPOT_SYMBOLS = {"sui": "SUIUSDC", "btc": "BTCUSDT", "eth": "ETHUSDT"}
FUTURES_SYMBOL = "SUIUSDT"
FUNDING_FFILL_LIMIT = 8 * 60 + 5  # funding settles every 8h
OI_FFILL_LIMIT = 5  # OI history is sampled at 5m


def train_models(
    X: pd.DataFrame,
    y_vol: pd.Series,
    seed: int = DEFAULT_SEED,
    num_boost_round: int = DEFAULT_NUM_BOOST_ROUND,
    params_override: dict | None = None,
) -> dict[str, lgb.Booster]:
    """Train the vol booster. ``params_override`` lets tests shrink
    ``min_data_in_leaf`` etc. for tiny synthetic datasets. Returns a dict
    (single key ``"vol"``) so export/registry keep one artifact shape."""
    if list(X.columns) != FEATURE_NAMES:
        raise ValueError("train_models: X columns must match features.registry.FEATURE_NAMES")
    if len(X) != len(y_vol):
        raise ValueError("train_models: X / y length mismatch")

    params = {
        **BASE_PARAMS,
        "objective": "regression_l1",
        "seed": seed,
        **(params_override or {}),
    }
    dataset = lgb.Dataset(
        X.to_numpy(dtype=float), label=y_vol.to_numpy(dtype=float), feature_name=FEATURE_NAMES
    )
    return {"vol": lgb.train(params, dataset, num_boost_round=num_boost_round)}


def load_canonical_frame(
    data_root: Path | str,
    start_ms: int,
    end_ms: int,
) -> pd.DataFrame:
    """Load backfilled parquet into the canonical aligned 1-min frame.

    Spot klines (SUI/BTC/ETH) are required. Funding and OI are optional
    datasets — when their parquet is absent the columns are omitted, the
    affected features default-fill and ``feature_completeness`` reflects it
    (same semantics as serving).
    """
    frames: dict[str, pd.DataFrame] = {}
    limits: dict[str, int] = {}

    sui = read_partitioned(data_root, f"binance/klines/{SPOT_SYMBOLS['sui']}/1m", "open_time", start_ms, end_ms)
    frames["sui"] = from_klines(sui, "sui")
    for name in ("btc", "eth"):
        klines = read_partitioned(
            data_root, f"binance/klines/{SPOT_SYMBOLS[name]}/1m", "open_time", start_ms, end_ms
        )
        frames[name] = from_klines(klines, name, fields=("close",))

    for dataset, value_cols, limit in (
        ("funding", {"funding_rate": "funding"}, FUNDING_FFILL_LIMIT),
        ("oi", {"open_interest": "oi"}, OI_FFILL_LIMIT),
    ):
        try:
            raw = read_partitioned(data_root, f"binance/{dataset}/{FUTURES_SYMBOL}", "ts", start_ms, end_ms)
        except FileNotFoundError:
            # Documented optional dataset: liquidations have no backfill path at
            # all, and OI history only covers ~30 days (see binance_derivatives).
            print(f"[train] note: optional dataset {dataset!r} not present, features will default-fill")
            continue
        frames[dataset] = from_scalar_series(raw, value_cols)
        limits[dataset] = limit

    return align_sources(frames, freq="1min", ffill_limits=limits)


def build_training_set(
    df: pd.DataFrame,
    horizon: int = DEFAULT_HORIZON_BARS,
) -> tuple[pd.DataFrame, pd.Series]:
    """Canonical frame → (X, y_vol) on the common labelled index."""
    X, _completeness = build_feature_matrix(df)
    labels = make_labels(df, horizon=horizon)
    X = X.loc[labels.index]
    return X, labels["label_vol"]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Train the LightGBM vol model")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_ROOT), help="parquet root")
    parser.add_argument("--start", required=True, help="training window start (ISO, UTC)")
    parser.add_argument("--end", required=True, help="training window end (ISO, UTC, exclusive)")
    parser.add_argument("--out-dir", default="artifacts", help="artifact root directory")
    parser.add_argument("--version", required=True, help="artifact version, e.g. v1.0.0")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--bin-step", type=float, default=DEFAULT_BIN_STEP)
    parser.add_argument("--horizon", type=int, default=DEFAULT_HORIZON_BARS, help="label horizon in 1-min bars")
    parser.add_argument("--num-boost-round", type=int, default=DEFAULT_NUM_BOOST_ROUND)
    args = parser.parse_args(argv)

    start_ms, end_ms = parse_utc_ms(args.start), parse_utc_ms(args.end)
    frame = load_canonical_frame(args.data_dir, start_ms, end_ms)
    X, y_vol = build_training_set(frame, horizon=args.horizon)
    print(f"[train] {len(X)} samples, {len(FEATURE_NAMES)} features")

    models = train_models(X, y_vol, seed=args.seed, num_boost_round=args.num_boost_round)
    out = export_artifacts(
        models,
        args.out_dir,
        version=args.version,
        data_window={"start": args.start, "end": args.end},
        seed=args.seed,
        X_train=X,
        bin_step=args.bin_step,
        horizon=args.horizon,
    )
    print(f"[train] artifacts written to {out}")


if __name__ == "__main__":
    main()
