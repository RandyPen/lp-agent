"""Model registry: artifact loading, integrity checks, atomic hot-swap.

A bundle is one ``ml/artifacts/<version>/`` directory (see
``training.export``). Loading validates:

* all four model files present, sha256 matching ``models_meta.json``
  (a corrupted / hand-edited artifact refuses to load);
* the artifact's feature list equals the **current**
  ``features.registry.FEATURE_NAMES`` — an artifact trained against an older
  feature registry is rejected outright instead of silently mis-assembling
  inputs.

``ModelRegistry.swap`` loads the new bundle completely before replacing the
current one under a lock; any failure propagates and the old bundle keeps
serving (the /reload-409 semantics in prediction-service-design.md §4.2).
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb

from features.registry import FEATURE_NAMES
from training.export import MODEL_FILES, sha256_file


@dataclass(frozen=True)
class ModelBundle:
    version: str
    boosters: dict[str, lgb.Booster]
    feature_names: list[str]
    meta: dict
    psi_baseline: dict
    loaded_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


def load_bundle(artifact_dir: Path | str) -> ModelBundle:
    """Load and validate one artifact directory."""
    directory = Path(artifact_dir)
    meta_path = directory / "models_meta.json"
    if not meta_path.is_file():
        raise FileNotFoundError(f"load_bundle: {meta_path} not found")
    meta = json.loads(meta_path.read_text())

    features = meta.get("features")
    if features != FEATURE_NAMES:
        raise ValueError(
            f"load_bundle: artifact {meta.get('version')!r} was trained against a "
            "different feature registry — retrain before serving "
            f"(artifact: {features}, current: {FEATURE_NAMES})"
        )

    boosters: dict[str, lgb.Booster] = {}
    for key in MODEL_FILES:
        path = directory / f"{key}.txt"
        if not path.is_file():
            raise FileNotFoundError(f"load_bundle: missing model file {path}")
        expected = meta["files"].get(f"{key}.txt")
        actual = sha256_file(path)
        if expected != actual:
            raise ValueError(
                f"load_bundle: sha256 mismatch for {path.name} "
                f"(meta {expected}, file {actual}) — artifact corrupted"
            )
        boosters[key] = lgb.Booster(model_file=str(path))

    psi_path = directory / "psi_baseline.json"
    if not psi_path.is_file():
        raise FileNotFoundError(f"load_bundle: {psi_path} not found")
    psi_baseline = json.loads(psi_path.read_text())

    return ModelBundle(
        version=meta["version"],
        boosters=boosters,
        feature_names=list(features),
        meta=meta,
        psi_baseline=psi_baseline,
    )


class ModelRegistry:
    """Holds the live bundle; swaps are all-or-nothing."""

    def __init__(self, bundle: ModelBundle) -> None:
        self._lock = threading.Lock()
        self._bundle = bundle

    @classmethod
    def from_dir(cls, artifact_dir: Path | str) -> "ModelRegistry":
        return cls(load_bundle(artifact_dir))

    def current(self) -> ModelBundle:
        with self._lock:
            return self._bundle

    def swap(self, artifact_dir: Path | str) -> ModelBundle:
        """Load ``artifact_dir`` fully, then atomically replace the current
        bundle. Raises (and keeps the old bundle) on any load failure."""
        bundle = load_bundle(artifact_dir)
        with self._lock:
            self._bundle = bundle
        return bundle
