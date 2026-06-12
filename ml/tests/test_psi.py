"""PSI math against hand-computed values, plus tracker warm-up / breach logic."""

import math

import numpy as np
import pytest

from serving.psi import PsiTracker, bucket_fractions, psi


class TestPsiMath:
    def test_identical_distributions_are_zero(self):
        assert psi([0.25, 0.25, 0.5], [0.25, 0.25, 0.5]) == pytest.approx(0.0)

    def test_hand_computed_two_buckets(self):
        # (0.9−0.5)·ln(0.9/0.5) + (0.1−0.5)·ln(0.1/0.5)
        expected = 0.4 * math.log(0.9 / 0.5) + (-0.4) * math.log(0.1 / 0.5)
        assert psi([0.5, 0.5], [0.9, 0.1]) == pytest.approx(expected)

    def test_symmetry(self):
        assert psi([0.7, 0.3], [0.3, 0.7]) == pytest.approx(psi([0.3, 0.7], [0.7, 0.3]))

    def test_empty_bucket_is_clipped_not_infinite(self):
        value = psi([0.5, 0.5], [1.0, 0.0])
        assert np.isfinite(value) and value > 0

    def test_bucket_count_mismatch_raises(self):
        with pytest.raises(ValueError):
            psi([0.5, 0.5], [1.0])


class TestBucketFractions:
    def test_simple_split(self):
        fracs = bucket_fractions(np.array([-1.0, -0.5, 0.5, 1.0]), edges=[0.0])
        assert fracs.tolist() == [0.5, 0.5]

    def test_edge_value_falls_in_upper_bucket(self):
        # searchsorted(side="right"): value == edge goes to the upper bucket —
        # must match the convention used when exporting the baseline.
        fracs = bucket_fractions(np.array([0.0]), edges=[0.0])
        assert fracs.tolist() == [0.0, 1.0]

    def test_empty_values_raise(self):
        with pytest.raises(ValueError):
            bucket_fractions(np.array([]), edges=[0.0])


class TestPsiTracker:
    BASELINE = {
        "f1": {"edges": [0.0], "expected": [0.5, 0.5]},
        "f2": {"edges": [0.0], "expected": [0.5, 0.5]},
    }

    def test_warmup_reports_zero(self):
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"], min_obs=10)
        summary = tracker.observe(np.array([1.0, -1.0]))
        assert summary == {"max": 0.0, "by_feature": {}, "breached": [], "n_obs": 1}

    def test_matching_distribution_stays_low(self):
        rng = np.random.default_rng(7)
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"], min_obs=10)
        summary = {}
        for _ in range(100):
            summary = tracker.observe(rng.normal(0.0, 1.0, 2))
        assert summary["max"] < 0.25
        assert summary["breached"] == []

    def test_shifted_distribution_breaches(self):
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"], min_obs=10)
        summary = {}
        for _ in range(50):
            summary = tracker.observe(np.array([5.0, 0.0]))  # f1 always above edge
        assert summary["max"] > 0.25
        assert "f1" in summary["breached"]

    def test_missing_baseline_feature_rejected(self):
        with pytest.raises(ValueError, match="missing features"):
            PsiTracker({"f1": self.BASELINE["f1"]}, ["f1", "f2"])

    def test_wrong_vector_length_rejected(self):
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"])
        with pytest.raises(ValueError, match="expected 2 values"):
            tracker.observe(np.array([1.0]))
