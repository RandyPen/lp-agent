"""Walk-forward: purge/embargo leakage guarantees, metric math, end-to-end run."""

import numpy as np
import pytest

from training.walk_forward import (
    baseline_quantiles,
    direction_accuracy,
    empirical_coverage,
    pinball_loss,
    purged_kfold_indices,
    run_walk_forward,
)
from tests.conftest import make_training_set

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
    def test_pinball_hand_computed_overprediction(self):
        # y=0, pred=1, α=0.1: diff = −1 → max(−0.1, 0.9) = 0.9
        assert pinball_loss(np.array([0.0]), np.array([1.0]), 0.1) == pytest.approx(0.9)

    def test_pinball_hand_computed_underprediction(self):
        # y=1, pred=0, α=0.9: diff = 1 → max(0.9, −0.1) = 0.9
        assert pinball_loss(np.array([1.0]), np.array([0.0]), 0.9) == pytest.approx(0.9)

    def test_pinball_perfect_prediction_is_zero(self):
        y = np.array([1.0, -2.0, 0.5])
        assert pinball_loss(y, y, 0.5) == 0.0

    def test_pinball_median_is_half_mae(self):
        y, pred = np.array([1.0, 3.0]), np.array([2.0, 2.0])
        assert pinball_loss(y, pred, 0.5) == pytest.approx(0.5 * np.mean(np.abs(y - pred)))

    def test_coverage(self):
        y = np.array([0.0, 1.0, 5.0, -5.0])
        q10 = np.array([-1.0, -1.0, -1.0, -1.0])
        q90 = np.array([1.0, 1.0, 1.0, 1.0])
        assert empirical_coverage(y, q10, q90) == pytest.approx(0.5)

    def test_direction_accuracy_and_binomial_test(self):
        y = np.array([1.0, 2.0, 3.0, -1.0])
        q50 = np.array([0.5, 0.5, 0.5, 0.5])
        acc, pvalue, n = direction_accuracy(y, q50)
        assert (acc, n) == (0.75, 4)
        assert 0.0 < pvalue <= 1.0

    def test_direction_excludes_zero_samples(self):
        y = np.array([0.0, 1.0])
        q50 = np.array([1.0, 1.0])
        acc, _, n = direction_accuracy(y, q50)
        assert (acc, n) == (1.0, 1)

    def test_baseline_band_is_symmetric_and_scales_with_sigma(self):
        sigma = np.array([0.001, 0.002])
        base = baseline_quantiles(sigma, horizon=30, bin_step=0.005)
        assert np.allclose(base["q50"], 0.0)
        assert np.allclose(base["q10"], -base["q90"])
        assert base["q90"][1] == pytest.approx(2 * base["q90"][0])


class TestEndToEnd:
    def test_report_structure_and_gates(self):
        X, y_center, y_vol = make_training_set(n=500)
        report = run_walk_forward(
            X,
            y_center,
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
        for key in (
            "pinball_model",
            "pinball_baseline",
            "pinball_ratio",
            "coverage_q10_q90",
            "direction_accuracy",
            "direction_pvalue",
            "vol_mae_model",
            "vol_mae_baseline",
        ):
            assert key in agg
        assert set(report["gates"]) == {"pinball", "coverage", "direction"}
        assert isinstance(report["gates_passed"], bool)
        assert 0.0 <= agg["coverage_q10_q90"] <= 1.0

    def test_deterministic_given_seed(self):
        X, y_center, y_vol = make_training_set(n=400)
        kwargs = dict(n_splits=3, embargo=10, num_boost_round=5, params_override=TINY_LGB, seed=7)
        r1 = run_walk_forward(X, y_center, y_vol, **kwargs)
        r2 = run_walk_forward(X, y_center, y_vol, **kwargs)
        assert r1["aggregate"] == r2["aggregate"]
