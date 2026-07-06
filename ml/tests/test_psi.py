"""PSI math against hand-computed values, plus tracker warm-up / breach /
exclusion logic and thread-safety."""

import math
import threading
from concurrent.futures import ThreadPoolExecutor

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
        assert summary == {
            "max": 0.0,
            "by_feature": {},
            "breached": [],
            "excluded": [],
            "n_obs": 1,
        }

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

    def test_observe_does_not_mutate_caller_vector(self):
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"], min_obs=1)
        vec = np.array([1.0, -1.0])
        tracker.observe(vec, exclude={"f1"})
        assert vec.tolist() == [1.0, -1.0]


class TestPsiTrackerExclusion:
    BASELINE = {
        "f1": {"edges": [0.0], "expected": [0.5, 0.5]},
        "f2": {"edges": [0.0], "expected": [0.5, 0.5]},
    }

    def test_excluded_constant_feature_never_breaches(self):
        # f1 is a warm-up default constant (5.0 would breach hard if scored);
        # excluding it per-observation must keep it out of max/breached.
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"], min_obs=10)
        rng = np.random.default_rng(3)
        summary = {}
        for _ in range(50):
            summary = tracker.observe(
                np.array([5.0, rng.normal(0.0, 1.0)]), exclude={"f1"}
            )
        assert "f1" not in summary["by_feature"]
        assert summary["excluded"] == ["f1"]
        assert summary["breached"] == []
        assert summary["max"] < 0.25

    def test_feature_scored_once_enough_real_observations_exist(self):
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"], min_obs=10)
        rng = np.random.default_rng(5)
        # 20 excluded (warm-up) observations, then 10 real ones for f1.
        for _ in range(20):
            summary = tracker.observe(
                np.array([0.0, rng.normal(0.0, 1.0)]), exclude={"f1"}
            )
            assert "f1" in summary["excluded"] or summary["n_obs"] < 10
        for _ in range(10):
            summary = tracker.observe(rng.normal(0.0, 1.0, 2))
        assert "f1" in summary["by_feature"]
        assert summary["excluded"] == []

    def test_excluded_breaching_values_do_not_count_later(self):
        # The placeholders from the warm-up phase must not pollute f1's PSI
        # once real values arrive. 30 excluded observations carry 50.0 (all
        # above the edge — would breach hard if scored); the 10 real values
        # alternate ±1 (exact 0.5/0.5 split → PSI exactly ~0). If the
        # excluded 50.0s leaked into the window, PSI would be ≈0.7+.
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"], min_obs=10, window=64)
        for i in range(30):
            sign = 1.0 if i % 2 == 0 else -1.0
            tracker.observe(np.array([50.0, sign]), exclude={"f1"})
        summary = {}
        for i in range(10):
            sign = 1.0 if i % 2 == 0 else -1.0
            summary = tracker.observe(np.array([sign, sign]))
        assert summary["by_feature"]["f1"] == pytest.approx(0.0)
        assert "f1" not in summary["breached"]

    def test_unknown_excluded_feature_raises(self):
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"])
        with pytest.raises(ValueError, match="unknown excluded features"):
            tracker.observe(np.array([1.0, 2.0]), exclude={"nope"})


class TestPsiTrackerThreadSafety:
    BASELINE = {
        "f1": {"edges": [0.0], "expected": [0.5, 0.5]},
        "f2": {"edges": [0.0], "expected": [0.5, 0.5]},
    }

    def test_concurrent_observe_and_summary(self):
        """Hammer observe from a thread pool while summary runs concurrently.

        Without the internal lock this races: ``summary`` does
        ``np.stack(deque)`` (iterates the buffer) while ``observe`` appends —
        CPython raises "deque mutated during iteration" / produces
        inconsistent stacks. With the lock every call must succeed and the
        final observation count must be exact."""
        tracker = PsiTracker(self.BASELINE, ["f1", "f2"], min_obs=5, window=4096)
        n_threads, per_thread = 8, 200
        rng = np.random.default_rng(42)
        vectors = rng.normal(0.0, 1.0, (n_threads, per_thread, 2))
        errors: list[Exception] = []
        start = threading.Barrier(n_threads + 1)

        def observer(tid: int) -> None:
            start.wait()
            for i in range(per_thread):
                try:
                    tracker.observe(vectors[tid, i])
                except Exception as exc:  # pragma: no cover - fails the test
                    errors.append(exc)

        def summarizer() -> None:
            start.wait()
            for _ in range(400):
                try:
                    tracker.summary()
                except Exception as exc:  # pragma: no cover - fails the test
                    errors.append(exc)

        with ThreadPoolExecutor(max_workers=n_threads + 1) as pool:
            futures = [pool.submit(observer, t) for t in range(n_threads)]
            futures.append(pool.submit(summarizer))
            for f in futures:
                f.result()

        assert errors == []
        final = tracker.summary()
        assert final["n_obs"] == n_threads * per_thread
        assert np.isfinite(final["max"])
