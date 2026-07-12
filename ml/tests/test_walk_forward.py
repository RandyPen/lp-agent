"""Walk-forward: purge/embargo leakage guarantees, metric math, end-to-end run.

The pinball/coverage/direction/center metrics were removed with the center
head (2026-07, docs/decision-remove-center-prediction.md); the vol MAE ratio
is the gate and σ-band coverage is informational."""

import numpy as np
import pandas as pd
import pytest

from data.labels import future_offset, make_labels
from training.walk_forward import (
    band_coverage,
    purged_kfold_indices,
    run_walk_forward,
    sigma_to_bins,
)
from tests.conftest import make_canonical_frame, make_training_set

TINY_LGB = {"min_data_in_leaf": 5}


class TestPurgedKfold:
    N, SPLITS, PURGE, EMBARGO = 200, 4, 30, 10

    def folds(self):
        return purged_kfold_indices(self.N, self.SPLITS, self.PURGE, self.EMBARGO)

    def test_no_train_index_inside_purge_or_embargo_zone(self):
        for train, test in self.folds():
            t0, t1 = test[0], test[-1] + 1
            forbidden = set(range(max(t0 - self.PURGE, 0), min(t1 + self.EMBARGO, self.N)))
            assert forbidden.isdisjoint(train), "train/test leakage through purge zone"

    def test_train_and_test_never_overlap(self):
        for train, test in self.folds():
            assert set(train).isdisjoint(test)

    def test_test_folds_are_contiguous_and_cover_everything(self):
        all_test = np.concatenate([test for _, test in self.folds()])
        assert sorted(all_test.tolist()) == list(range(self.N))
        for _, test in self.folds():
            assert (np.diff(test) == 1).all()

    def test_rejects_degenerate_inputs(self):
        with pytest.raises(ValueError):
            purged_kfold_indices(10, 1, 0, 0)
        with pytest.raises(ValueError):
            purged_kfold_indices(3, 2, 0, 0)


class TestMetricMath:
    def test_sigma_to_bins_sqrt_horizon_scaling(self):
        sigma = np.array([0.001, 0.002])
        bins30 = sigma_to_bins(sigma, horizon=30, bin_step=0.005)
        bins120 = sigma_to_bins(sigma, horizon=120, bin_step=0.005)
        # √(120/30) = 2 and linear in σ
        assert bins120[0] == pytest.approx(2 * bins30[0])
        assert bins30[1] == pytest.approx(2 * bins30[0])
        # hand value: 0.001·√30/ln(1.005)
        assert bins30[0] == pytest.approx(0.001 * np.sqrt(30) / np.log(1.005))

    def test_band_coverage_hand_computed(self):
        # band = 1.28 · 1.0 · √1 / ln(1.005) ≈ 256.6 bins for σ=1 — use small σ
        # so the band is exactly ±1.28 bins: σ_bins = 1 ⇒ σ = ln(1.005)/√1.
        sigma = np.full(4, np.log(1.005))
        offsets = np.array([0.0, 1.0, 2.0, -3.0])  # |x| ≤ 1.28 → first two inside
        cov = band_coverage(offsets, sigma, horizon=1, bin_step=0.005)
        assert cov == pytest.approx(0.5)


class TestEndToEnd:
    def test_report_structure_and_gates(self):
        X, y_vol = make_training_set(n=500)
        report = run_walk_forward(
            X,
            y_vol,
            n_splits=3,
            horizon=30,
            embargo=10,
            num_boost_round=5,
            params_override=TINY_LGB,
        )
        assert report["n_splits"] == 3
        assert len(report["folds"]) == 3
        agg = report["aggregate"]
        for key in ("vol_mae_model", "vol_mae_baseline", "vol_mae_ratio"):
            assert key in agg
        for fold in report["folds"]:
            assert {"vol_mae_model", "vol_mae_baseline", "vol_mae_ratio"} <= set(fold)
        # 2026-07 revision: vol is THE gate; center/pinball/coverage are gone.
        assert set(report["gates"]) == {"vol"}
        assert isinstance(report["gates_passed"], bool)
        # no σ-band coverage without y_offset
        assert "sigma_band_coverage" not in agg

    def test_sigma_band_coverage_reported_when_offset_supplied(self):
        frame = make_canonical_frame(n=500)
        from features.registry import build_feature_matrix

        X, _ = build_feature_matrix(frame)
        labels = make_labels(frame, horizon=30)
        X = X.loc[labels.index]
        offset = future_offset(frame, horizon=30, bin_step=0.005).loc[X.index]
        report = run_walk_forward(
            X,
            labels["label_vol"],
            n_splits=3,
            horizon=30,
            embargo=10,
            num_boost_round=5,
            params_override=TINY_LGB,
            y_offset=offset,
        )
        cov = report["aggregate"]["sigma_band_coverage"]
        assert set(cov) == {"model", "baseline", "target", "n"}
        assert 0.0 <= cov["model"] <= 1.0
        assert cov["n"] > 0

    def test_y_offset_index_mismatch_raises(self):
        X, y_vol = make_training_set(n=400)
        bad = pd.Series(np.zeros(len(X)))  # RangeIndex ≠ X's DatetimeIndex
        with pytest.raises(ValueError, match="y_offset"):
            run_walk_forward(
                X, y_vol, n_splits=3, embargo=10, num_boost_round=5,
                params_override=TINY_LGB, y_offset=bad,
            )

    def test_deterministic_given_seed(self):
        X, y_vol = make_training_set(n=400)
        kwargs = dict(n_splits=3, embargo=10, num_boost_round=5, params_override=TINY_LGB, seed=7)
        r1 = run_walk_forward(X, y_vol, **kwargs)
        r2 = run_walk_forward(X, y_vol, **kwargs)
        assert r1["aggregate"] == r2["aggregate"]
