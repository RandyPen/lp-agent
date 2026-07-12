"""Artifact export: model files + reproducibility metadata + PSI baseline.

Layout per plan §2.3 (artifacts never enter git — forks train their own):

    <out_dir>/<version>/
        vol.txt                              LightGBM native text format
        models_meta.json                     version, trained_at, data_window,
                                             seed, git_sha, bin_step, horizon,
                                             features, sha256 per model file
        psi_baseline.json                    per-feature decile buckets of the
                                             training distribution (PSI input)

The q10/q50/q90 quantile files were removed 2026-07 along with the center
head (docs/decision-remove-center-prediction.md); artifacts produced under
the old four-file layout fail `serving.registry.load_bundle` by design.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from features.registry import FEATURE_NAMES

PSI_BUCKETS = 10
MODEL_FILES: tuple[str, ...] = ("vol",)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def git_sha(repo_dir: Path | str = ".") -> str:
    """HEAD sha of the enclosing repo; "unknown" (with a warning) when git is
    unavailable — recorded provenance degrades, the export does not abort."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_dir),
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"[export] warning: could not resolve git sha ({exc}); recording 'unknown'")
        return "unknown"


def compute_psi_baseline(X: pd.DataFrame, n_buckets: int = PSI_BUCKETS) -> dict:
    """Decile-bucket baseline of each training feature's distribution.

    Per feature: ``edges`` (inner quantile cut points, deduplicated) and
    ``expected`` (fraction of training rows per bucket, len(edges)+1 buckets).
    A constant feature yields ``edges=[]`` / ``expected=[1.0]`` — PSI is then
    trivially 0 until the live value set changes shape.
    """
    baseline: dict[str, dict] = {}
    quantile_points = np.linspace(0, 1, n_buckets + 1)[1:-1]
    for name in X.columns:
        values = X[name].to_numpy(dtype=float)
        values = values[np.isfinite(values)]
        if len(values) == 0:
            raise ValueError(f"compute_psi_baseline: feature {name!r} has no finite values")
        edges = np.unique(np.quantile(values, quantile_points))
        if len(edges) == 0:
            baseline[name] = {"edges": [], "expected": [1.0]}
            continue
        idx = np.searchsorted(edges, values, side="right")
        counts = np.bincount(idx, minlength=len(edges) + 1).astype(float)
        baseline[name] = {
            "edges": edges.tolist(),
            "expected": (counts / counts.sum()).tolist(),
        }
    return baseline


def export_artifacts(
    models: dict[str, lgb.Booster],
    out_dir: Path | str,
    version: str,
    data_window: dict[str, str],
    seed: int,
    X_train: pd.DataFrame,
    bin_step: float,
    horizon: int,
) -> Path:
    """Write one self-contained, reloadable artifact directory; returns it."""
    missing = [k for k in MODEL_FILES if k not in models]
    if missing:
        raise ValueError(f"export_artifacts: missing models {missing}")
    if list(X_train.columns) != FEATURE_NAMES:
        raise ValueError("export_artifacts: X_train columns must match FEATURE_NAMES")

    target = Path(out_dir) / version
    target.mkdir(parents=True, exist_ok=True)

    file_hashes: dict[str, str] = {}
    for key in MODEL_FILES:
        path = target / f"{key}.txt"
        models[key].save_model(str(path))
        file_hashes[f"{key}.txt"] = sha256_file(path)

    meta = {
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "data_window": data_window,
        "seed": seed,
        "git_sha": git_sha(),
        "bin_step": bin_step,
        "horizon_bars": horizon,
        "features": FEATURE_NAMES,
        "files": file_hashes,
    }
    (target / "models_meta.json").write_text(json.dumps(meta, indent=2) + "\n")

    baseline = compute_psi_baseline(X_train)
    (target / "psi_baseline.json").write_text(json.dumps(baseline, indent=2) + "\n")

    return target
