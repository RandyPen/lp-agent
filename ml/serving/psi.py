"""Population Stability Index (PSI) drift monitoring against the training
baseline exported in ``psi_baseline.json`` (see ``training.export``).

PSI(expected, actual) = Σ (aᵢ − eᵢ) · ln(aᵢ / eᵢ) over distribution buckets,
with fractions clipped at ``EPS`` so empty buckets do not blow up the log.
Conventional reading: < 0.1 stable, 0.1–0.25 moderate shift, > 0.25 drifted
(the sidecar's fallback threshold, plan §4.2).
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence

import numpy as np

EPS = 1e-6
DEFAULT_WINDOW = 256
DEFAULT_MIN_OBS = 50


def bucket_fractions(values: np.ndarray, edges: Sequence[float]) -> np.ndarray:
    """Fraction of ``values`` per bucket defined by ``edges`` cut points
    (``len(edges) + 1`` buckets; a value equal to an edge falls in the upper
    bucket — the same ``searchsorted(side="right")`` convention used when the
    baseline was exported in ``training.export.compute_psi_baseline``)."""
    values = np.asarray(values, dtype=float)
    if len(values) == 0:
        raise ValueError("bucket_fractions: empty values")
    idx = np.searchsorted(np.asarray(edges, dtype=float), values, side="right")
    counts = np.bincount(idx, minlength=len(edges) + 1).astype(float)
    return counts / counts.sum()


def psi(expected: Sequence[float], actual: Sequence[float]) -> float:
    """PSI between two bucket-fraction vectors of equal length."""
    e = np.clip(np.asarray(expected, dtype=float), EPS, None)
    a = np.clip(np.asarray(actual, dtype=float), EPS, None)
    if e.shape != a.shape:
        raise ValueError(f"psi: bucket count mismatch ({e.shape} vs {a.shape})")
    return float(np.sum((a - e) * np.log(a / e)))


class PsiTracker:
    """Rolling-window PSI over the live feature vectors the models actually
    consume (post default-fill).

    Below ``min_obs`` observations the tracker reports PSI 0.0 — a documented
    warm-up, not a measurement; ``n_obs`` in the summary makes the state
    visible to /health consumers.
    """

    def __init__(
        self,
        baseline: Mapping[str, Mapping],
        feature_names: Sequence[str],
        window: int = DEFAULT_WINDOW,
        min_obs: int = DEFAULT_MIN_OBS,
    ) -> None:
        missing = [n for n in feature_names if n not in baseline]
        if missing:
            raise ValueError(f"PsiTracker: baseline missing features {missing}")
        self._baseline = {n: baseline[n] for n in feature_names}
        self._feature_names = list(feature_names)
        self._buffer: deque[np.ndarray] = deque(maxlen=window)
        self._min_obs = min_obs

    def observe(self, vector: np.ndarray) -> dict:
        """Append one feature vector and return the current PSI summary:
        ``{"max": float, "by_feature": {...}, "breached": [...], "n_obs": int}``
        (``breached`` uses the conventional 0.25 threshold)."""
        vector = np.asarray(vector, dtype=float).reshape(-1)
        if len(vector) != len(self._feature_names):
            raise ValueError(
                f"PsiTracker.observe: expected {len(self._feature_names)} values, got {len(vector)}"
            )
        self._buffer.append(vector)
        return self.summary()

    def summary(self, breach_threshold: float = 0.25) -> dict:
        if len(self._buffer) < self._min_obs:
            return {"max": 0.0, "by_feature": {}, "breached": [], "n_obs": len(self._buffer)}
        matrix = np.stack(self._buffer)
        by_feature: dict[str, float] = {}
        for i, name in enumerate(self._feature_names):
            spec = self._baseline[name]
            actual = bucket_fractions(matrix[:, i], spec["edges"])
            by_feature[name] = psi(spec["expected"], actual)
        max_psi = max(by_feature.values()) if by_feature else 0.0
        return {
            "max": max_psi,
            "by_feature": by_feature,
            "breached": [n for n, v in by_feature.items() if v > breach_threshold],
            "n_obs": len(self._buffer),
        }
