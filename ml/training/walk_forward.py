"""Walk-forward evaluation with purged k-fold + embargo (vol head).

Overlapping horizon labels leak across a naive time split: a sample at T and a
sample at T+1 share horizon−1 minutes of future window. Purging removes the
``purge`` (= label horizon) training bars immediately before each test fold;
the embargo removes ``embargo`` bars immediately after it.

Metrics (REVISED 2026-07 — the center/quantile heads were removed after this
protocol falsified them; see docs/decision-remove-center-prediction.md):

* vol MAE vs the EWMA-σ feature baseline
  → THE gate: model < 0.9 × baseline
* σ-band calibration (INFORMATIONAL): empirical coverage of
  ±1.28 × σ̂ × √h / ln(1+bin_step) against the realized end-of-horizon bin
  offset. Target ≈ 80 %. This guards the σ-scaling constant that serving's
  pAbove/pBelow computation depends on; it is not a gate because band width
  is a serving calibration knob, not a model property.

Writes ``reports/wf_<date>.json``.

CLI:

    uv run python -m training.walk_forward \
        --start 2025-09-01 --end 2026-03-01 [--n-splits 5] [--embargo 30]
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from data.collectors.binance_klines import parse_utc_ms
from data.labels import DEFAULT_BIN_STEP, DEFAULT_HORIZON_BARS, future_offset
from data.parquet_writer import DEFAULT_DATA_ROOT
from training.train_vol import (
    DEFAULT_SEED,
    build_training_set,
    load_canonical_frame,
    train_models,
)

DEFAULT_N_SPLITS = 5
DEFAULT_REPORTS_DIR = Path("reports")
Z_80_BAND = 1.28  # ±1.28 σ ≈ the 80 % equal-tailed interval of a normal

GATES = {
    # vol head must beat the EWMA-σ persistence baseline by ≥ 10 %.
    "vol_mae_ratio_max": 0.9,
}


def purged_kfold_indices(
    n: int,
    n_splits: int,
    purge: int,
    embargo: int,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Contiguous test folds; train = everything outside
    ``[test_start - purge, test_end + embargo)``."""
    if n_splits < 2:
        raise ValueError("purged_kfold_indices: need n_splits >= 2")
    if n < n_splits * 2:
        raise ValueError(f"purged_kfold_indices: n={n} too small for {n_splits} splits")

    indices = np.arange(n)
    bounds = np.linspace(0, n, n_splits + 1, dtype=int)
    folds: list[tuple[np.ndarray, np.ndarray]] = []
    for k in range(n_splits):
        t0, t1 = int(bounds[k]), int(bounds[k + 1])
        test = indices[t0:t1]
        train_mask = (indices < t0 - purge) | (indices >= t1 + embargo)
        train = indices[train_mask]
        if len(train) == 0:
            raise ValueError("purged_kfold_indices: fold produced an empty train set")
        folds.append((train, test))
    return folds


def sigma_to_bins(sigma_per_bar: np.ndarray, horizon: int, bin_step: float) -> np.ndarray:
    """Per-bar σ → σ of the end-of-horizon offset in bin units (√h scaling).
    The SAME constant serving uses to build widthSigma from the vol head."""
    return sigma_per_bar * np.sqrt(horizon) / np.log(1.0 + bin_step)


def band_coverage(
    realized_offset: np.ndarray,
    sigma_per_bar: np.ndarray,
    horizon: int,
    bin_step: float,
    z: float = Z_80_BAND,
) -> float:
    """Fraction of realized end-of-horizon offsets inside ±z·σ̂_bins."""
    band = z * sigma_to_bins(sigma_per_bar, horizon, bin_step)
    return float(np.mean(np.abs(realized_offset) <= band))


def run_walk_forward(
    X: pd.DataFrame,
    y_vol: pd.Series,
    n_splits: int = DEFAULT_N_SPLITS,
    horizon: int = DEFAULT_HORIZON_BARS,
    embargo: int = DEFAULT_HORIZON_BARS,
    seed: int = DEFAULT_SEED,
    bin_step: float = DEFAULT_BIN_STEP,
    num_boost_round: int = 200,
    params_override: dict | None = None,
    y_offset: pd.Series | None = None,
) -> dict:
    """Train/evaluate across purged folds; returns the report dict.

    ``y_offset`` (optional) is the realized end-of-horizon bin offset aligned
    to ``X.index`` — supplying it enables the informational σ-band calibration
    metric (see module docstring)."""
    yv = y_vol.to_numpy(dtype=float)
    yo = None
    if y_offset is not None:
        if not y_offset.index.equals(X.index):
            raise ValueError("run_walk_forward: y_offset index must match X")
        yo = y_offset.to_numpy(dtype=float)
    folds = purged_kfold_indices(len(X), n_splits, purge=horizon, embargo=embargo)

    fold_reports: list[dict] = []
    pooled: dict[str, list[np.ndarray]] = {
        "vol_y": [], "vol_pred": [], "vol_base": [], "offset": [],
    }

    for k, (train_idx, test_idx) in enumerate(folds):
        models = train_models(
            X.iloc[train_idx],
            y_vol.iloc[train_idx],
            seed=seed,
            num_boost_round=num_boost_round,
            params_override=params_override,
        )
        X_test = X.iloc[test_idx].to_numpy(dtype=float)
        vol_pred = models["vol"].predict(X_test)
        vol_base = X.iloc[test_idx]["ewma_sigma"].to_numpy()

        yv_test = yv[test_idx]
        fold_mae_model = float(np.mean(np.abs(yv_test - vol_pred)))
        fold_mae_base = float(np.mean(np.abs(yv_test - vol_base)))
        fold_reports.append(
            {
                "fold": k,
                "n_train": len(train_idx),
                "n_test": len(test_idx),
                "vol_mae_model": fold_mae_model,
                "vol_mae_baseline": fold_mae_base,
                "vol_mae_ratio": fold_mae_model / fold_mae_base if fold_mae_base > 0 else float("inf"),
            }
        )

        pooled["vol_y"].append(yv_test)
        pooled["vol_pred"].append(vol_pred)
        pooled["vol_base"].append(vol_base)
        if yo is not None:
            pooled["offset"].append(yo[test_idx])

    vol_y = np.concatenate(pooled["vol_y"])
    vol_pred_all = np.concatenate(pooled["vol_pred"])
    vol_base_all = np.concatenate(pooled["vol_base"])
    vol_mae_model = float(np.mean(np.abs(vol_y - vol_pred_all)))
    vol_mae_base = float(np.mean(np.abs(vol_y - vol_base_all)))
    vol_mae_ratio = vol_mae_model / vol_mae_base if vol_mae_base > 0 else float("inf")

    aggregate: dict = {
        "vol_mae_model": vol_mae_model,
        "vol_mae_baseline": vol_mae_base,
        "vol_mae_ratio": vol_mae_ratio,
    }
    if yo is not None:
        offset_all = np.concatenate(pooled["offset"])
        finite = np.isfinite(offset_all)
        aggregate["sigma_band_coverage"] = {
            # informational: how often ±1.28·σ̂_bins covered the realized offset
            "model": band_coverage(offset_all[finite], vol_pred_all[finite], horizon, bin_step),
            "baseline": band_coverage(offset_all[finite], vol_base_all[finite], horizon, bin_step),
            "target": 0.80,
            "n": int(finite.sum()),
        }

    gates = {
        "vol": vol_mae_ratio < GATES["vol_mae_ratio_max"],
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": len(X),
        "n_splits": n_splits,
        "horizon": horizon,
        "embargo": embargo,
        "seed": seed,
        "bin_step": bin_step,
        "folds": fold_reports,
        "aggregate": aggregate,
        "gates": gates,
        "gates_passed": all(gates.values()),
    }


def write_report(report: dict, reports_dir: Path | str = DEFAULT_REPORTS_DIR) -> Path:
    reports_dir = Path(reports_dir)
    reports_dir.mkdir(parents=True, exist_ok=True)
    path = reports_dir / f"wf_{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    return path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Purged walk-forward evaluation (vol head)")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_ROOT))
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--n-splits", type=int, default=DEFAULT_N_SPLITS)
    parser.add_argument("--embargo", type=int, default=DEFAULT_HORIZON_BARS)
    parser.add_argument("--horizon", type=int, default=DEFAULT_HORIZON_BARS)
    parser.add_argument("--bin-step", type=float, default=DEFAULT_BIN_STEP)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--num-boost-round", type=int, default=200)
    parser.add_argument("--reports-dir", default=str(DEFAULT_REPORTS_DIR))
    args = parser.parse_args(argv)

    frame = load_canonical_frame(args.data_dir, parse_utc_ms(args.start), parse_utc_ms(args.end))
    X, y_vol = build_training_set(frame, horizon=args.horizon)
    offset = future_offset(frame, horizon=args.horizon, bin_step=args.bin_step).loc[X.index]
    report = run_walk_forward(
        X,
        y_vol,
        n_splits=args.n_splits,
        horizon=args.horizon,
        embargo=args.embargo,
        seed=args.seed,
        bin_step=args.bin_step,
        num_boost_round=args.num_boost_round,
        y_offset=offset,
    )
    path = write_report(report, args.reports_dir)
    print(f"[walk-forward] report: {path}")
    print(json.dumps({"aggregate": report["aggregate"], "gates": report["gates"]}, indent=2))


if __name__ == "__main__":
    main()
