"""Walk-forward evaluation with purged k-fold + embargo (plan W3 gate).

Overlapping 30-min labels leak across a naive time split: a sample at T and a
sample at T+1 share 29 minutes of future window. Purging removes the
``purge`` (= label horizon) training bars immediately before each test fold;
the embargo removes ``embargo`` bars immediately after it.

Metrics (the falsifiable W3 gates, simulator-independent):

* pinball loss (mean over q10/q50/q90) vs the rule baseline
  (center = 0, width from the EWMA-σ feature scaled to the horizon)
  → gate: model < 0.9 × baseline
* q10–q90 empirical coverage → gate: 76–84 %
* q50 direction accuracy + one-sided binomial test → gate: > 52 %, p < 0.05
* vol model MAE vs EWMA-σ baseline (informational)

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
from scipy import stats

from data.collectors.binance_klines import parse_utc_ms
from data.labels import DEFAULT_BIN_STEP, DEFAULT_HORIZON_BARS
from data.parquet_writer import DEFAULT_DATA_ROOT
from training.train_quantile import (
    DEFAULT_SEED,
    QUANTILES,
    build_training_set,
    load_canonical_frame,
    train_models,
)

DEFAULT_N_SPLITS = 5
DEFAULT_REPORTS_DIR = Path("reports")
Z_90 = float(stats.norm.ppf(0.9))  # 1.2816 — converts σ to the 10/90 quantile band

GATES = {
    "pinball_ratio_max": 0.9,
    "coverage_range": (0.76, 0.84),
    "direction_accuracy_min": 0.52,
    "direction_pvalue_max": 0.05,
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


def pinball_loss(y: np.ndarray, pred: np.ndarray, alpha: float) -> float:
    """Mean quantile (pinball) loss at level ``alpha``."""
    diff = y - pred
    return float(np.mean(np.maximum(alpha * diff, (alpha - 1.0) * diff)))


def baseline_quantiles(
    ewma_sigma_per_bar: np.ndarray,
    horizon: int,
    bin_step: float,
) -> dict[str, np.ndarray]:
    """Rule baseline: center 0, q10/q90 = ∓z₉₀ · σ_horizon in bin units."""
    sigma_bins = ewma_sigma_per_bar * np.sqrt(horizon) / np.log(1.0 + bin_step)
    return {
        "q10": -Z_90 * sigma_bins,
        "q50": np.zeros_like(sigma_bins),
        "q90": Z_90 * sigma_bins,
    }


def empirical_coverage(y: np.ndarray, q10: np.ndarray, q90: np.ndarray) -> float:
    return float(np.mean((y >= q10) & (y <= q90)))


def direction_accuracy(y: np.ndarray, q50: np.ndarray) -> tuple[float, float, int]:
    """Sign-agreement of q50 with the realised offset, plus a one-sided
    binomial test against p=0.5. Zero-direction samples are excluded."""
    mask = (y != 0) & (q50 != 0)
    n = int(mask.sum())
    if n == 0:
        return float("nan"), 1.0, 0
    hits = int((np.sign(y[mask]) == np.sign(q50[mask])).sum())
    test = stats.binomtest(hits, n, p=0.5, alternative="greater")
    return hits / n, float(test.pvalue), n


def run_walk_forward(
    X: pd.DataFrame,
    y_center: pd.Series,
    y_vol: pd.Series,
    n_splits: int = DEFAULT_N_SPLITS,
    horizon: int = DEFAULT_HORIZON_BARS,
    embargo: int = DEFAULT_HORIZON_BARS,
    seed: int = DEFAULT_SEED,
    bin_step: float = DEFAULT_BIN_STEP,
    num_boost_round: int = 200,
    params_override: dict | None = None,
) -> dict:
    """Train/evaluate across purged folds; returns the report dict."""
    yc = y_center.to_numpy(dtype=float)
    yv = y_vol.to_numpy(dtype=float)
    folds = purged_kfold_indices(len(X), n_splits, purge=horizon, embargo=embargo)

    fold_reports: list[dict] = []
    pooled: dict[str, list[np.ndarray]] = {
        "y": [], "q10": [], "q50": [], "q90": [],
        "b10": [], "b50": [], "b90": [],
        "vol_y": [], "vol_pred": [], "vol_base": [],
    }

    for k, (train_idx, test_idx) in enumerate(folds):
        models = train_models(
            X.iloc[train_idx],
            y_center.iloc[train_idx],
            y_vol.iloc[train_idx],
            seed=seed,
            num_boost_round=num_boost_round,
            params_override=params_override,
        )
        X_test = X.iloc[test_idx].to_numpy(dtype=float)
        preds = {key: models[key].predict(X_test) for key in ("q10", "q50", "q90", "vol")}
        base = baseline_quantiles(X.iloc[test_idx]["ewma_sigma"].to_numpy(), horizon, bin_step)

        y_test, yv_test = yc[test_idx], yv[test_idx]
        model_pinball = float(
            np.mean([pinball_loss(y_test, preds[f"q{int(a*100)}"], a) for a in QUANTILES])
        )
        base_pinball = float(
            np.mean([pinball_loss(y_test, base[f"q{int(a*100)}"], a) for a in QUANTILES])
        )
        acc, pval, n_dir = direction_accuracy(y_test, preds["q50"])
        fold_reports.append(
            {
                "fold": k,
                "n_train": len(train_idx),
                "n_test": len(test_idx),
                "pinball_model": model_pinball,
                "pinball_baseline": base_pinball,
                "coverage": empirical_coverage(y_test, preds["q10"], preds["q90"]),
                "direction_accuracy": acc,
                "direction_pvalue": pval,
                "direction_n": n_dir,
            }
        )

        pooled["y"].append(y_test)
        for q in ("q10", "q50", "q90"):
            pooled[q].append(preds[q])
            pooled[f"b{q[1:]}"].append(base[q])
        pooled["vol_y"].append(yv_test)
        pooled["vol_pred"].append(preds["vol"])
        pooled["vol_base"].append(X.iloc[test_idx]["ewma_sigma"].to_numpy())

    y_all = np.concatenate(pooled["y"])
    q = {k: np.concatenate(pooled[k]) for k in ("q10", "q50", "q90", "b10", "b50", "b90")}
    pin_model = float(np.mean([pinball_loss(y_all, q[f"q{int(a*100)}"], a) for a in QUANTILES]))
    pin_base = float(np.mean([pinball_loss(y_all, q[f"b{int(a*100)}"], a) for a in QUANTILES]))
    acc, pval, n_dir = direction_accuracy(y_all, q["q50"])
    coverage = empirical_coverage(y_all, q["q10"], q["q90"])
    vol_y = np.concatenate(pooled["vol_y"])
    vol_mae_model = float(np.mean(np.abs(vol_y - np.concatenate(pooled["vol_pred"]))))
    vol_mae_base = float(np.mean(np.abs(vol_y - np.concatenate(pooled["vol_base"]))))

    pinball_ratio = pin_model / pin_base if pin_base > 0 else float("inf")
    lo, hi = GATES["coverage_range"]
    aggregate = {
        "pinball_model": pin_model,
        "pinball_baseline": pin_base,
        "pinball_ratio": pinball_ratio,
        "coverage_q10_q90": coverage,
        "direction_accuracy": acc,
        "direction_pvalue": pval,
        "direction_n": n_dir,
        "vol_mae_model": vol_mae_model,
        "vol_mae_baseline": vol_mae_base,
    }
    gates = {
        "pinball": pinball_ratio < GATES["pinball_ratio_max"],
        "coverage": lo <= coverage <= hi,
        "direction": bool(
            acc > GATES["direction_accuracy_min"] and pval < GATES["direction_pvalue_max"]
        ),
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
    parser = argparse.ArgumentParser(description="Purged walk-forward evaluation")
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
    X, y_center, y_vol = build_training_set(frame, horizon=args.horizon, bin_step=args.bin_step)
    report = run_walk_forward(
        X,
        y_center,
        y_vol,
        n_splits=args.n_splits,
        horizon=args.horizon,
        embargo=args.embargo,
        seed=args.seed,
        bin_step=args.bin_step,
        num_boost_round=args.num_boost_round,
    )
    path = write_report(report, args.reports_dir)
    print(f"[walk-forward] report: {path}")
    print(json.dumps({"aggregate": report["aggregate"], "gates": report["gates"]}, indent=2))


if __name__ == "__main__":
    main()
