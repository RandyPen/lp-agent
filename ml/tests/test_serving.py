"""Serving: artifact load/swap integrity and the exact /predict HTTP contract.

A tiny LightGBM bundle is trained on synthetic data once per session and
exported through the real ``training.export`` path — no network, no
pre-existing artifacts.
"""

from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from features.registry import FEATURE_NAMES
from serving.app import (
    FUNDING_FFILL_LIMIT,
    OI_FFILL_LIMIT,
    DerivativesHistory,
    MarketSnapshot,
    _psi_exclusions,
    create_app,
    snapshot_to_frame,
)
from serving.registry import ModelRegistry, load_bundle
from training.export import export_artifacts
from training.train_quantile import train_models
from tests.conftest import make_ohlcv, make_training_set

TINY_LGB = {"min_data_in_leaf": 5}

PREDICTION_RESPONSE_KEYS = {
    "centerOffset",
    "centerQ10",
    "centerQ90",
    "widthSigma",
    "pAbove",
    "pBelow",
    "modelVersion",
    "featureCompleteness",
    "psi",
    "fallback",
}


@pytest.fixture(scope="module")
def artifact_root(tmp_path_factory):
    """Two exported artifact versions trained on synthetic data."""
    root = tmp_path_factory.mktemp("artifacts")
    X, y_center, y_vol = make_training_set(n=500)
    for version, seed in (("v1.0.0", 42), ("v1.1.0", 43)):
        models = train_models(
            X, y_center, y_vol, seed=seed, num_boost_round=8, params_override=TINY_LGB
        )
        export_artifacts(
            models,
            root,
            version=version,
            data_window={"start": "synthetic", "end": "synthetic"},
            seed=seed,
            X_train=X,
            bin_step=0.005,
            horizon=30,
        )
    return root


def make_snapshot(n_bars: int = 120, seed: int = 7) -> dict:
    """A MarketSnapshot JSON body assembled from synthetic bars, mirroring the
    canonical TS wire shape (src/prediction/types.ts OhlcvBar): bar timestamps
    are sent as ``ts`` and ``volume`` is included."""

    def bars(seed_offset: int, start_price: float) -> list[dict]:
        ohlcv = make_ohlcv(n_bars, seed=seed + seed_offset, start_price=start_price)
        return [
            {
                "ts": int(ts.value // 1_000_000),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            }
            for ts, row in ohlcv.iterrows()
        ]

    return {
        "ts": 1_750_000_000_000,
        "cetus": {"activeBin": 100, "price": "1.0", "tvlUsd": 50_000.0, "binStep": 0.005},
        "binance": {"sui": bars(0, 1.0), "btc": bars(1, 100.0), "eth": bars(2, 10.0)},
        "derivatives": {"funding": 0.0001, "oi": 1_000_000.0, "liq1m": 0.0},
        "spread": 0.001,
    }


class TestArtifactsAndRegistry:
    def test_load_bundle_roundtrip(self, artifact_root):
        bundle = load_bundle(artifact_root / "v1.0.0")
        assert bundle.version == "v1.0.0"
        assert set(bundle.boosters) == {"q10", "q50", "q90", "vol"}
        assert bundle.feature_names == FEATURE_NAMES
        assert set(bundle.psi_baseline) == set(FEATURE_NAMES)
        assert bundle.meta["seed"] == 42

    def test_corrupted_model_file_refuses_to_load(self, artifact_root, tmp_path):
        import shutil

        corrupt = tmp_path / "corrupt"
        shutil.copytree(artifact_root / "v1.0.0", corrupt)
        with open(corrupt / "q50.txt", "a") as fh:
            fh.write("\ntampered\n")
        with pytest.raises(ValueError, match="sha256 mismatch"):
            load_bundle(corrupt)

    def test_feature_registry_mismatch_rejected(self, artifact_root, tmp_path):
        import json
        import shutil

        stale = tmp_path / "stale"
        shutil.copytree(artifact_root / "v1.0.0", stale)
        meta = json.loads((stale / "models_meta.json").read_text())
        meta["features"] = meta["features"][:-1]  # pretend an older registry
        (stale / "models_meta.json").write_text(json.dumps(meta))
        with pytest.raises(ValueError, match="different feature registry"):
            load_bundle(stale)

    def test_swap_is_atomic_on_failure(self, artifact_root, tmp_path):
        registry = ModelRegistry.from_dir(artifact_root / "v1.0.0")
        with pytest.raises(FileNotFoundError):
            registry.swap(tmp_path / "does-not-exist")
        assert registry.current().version == "v1.0.0"
        assert registry.swap(artifact_root / "v1.1.0").version == "v1.1.0"
        assert registry.current().version == "v1.1.0"


class TestPredictContract:
    @pytest.fixture()
    def client(self, artifact_root):
        return TestClient(create_app(artifact_root / "v1.0.0"))

    def test_health_contract(self, client):
        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert body["model_version"] == "v1.0.0"
        assert "loaded_at" in body
        assert set(body["psi_summary"]) == {"max", "breached", "n_obs"}

    def test_predict_returns_exact_response_keys(self, client):
        resp = client.post("/predict", json=make_snapshot())
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == PREDICTION_RESPONSE_KEYS

    def test_predict_values_are_coherent(self, client):
        body = client.post("/predict", json=make_snapshot()).json()
        assert body["centerQ10"] <= body["centerOffset"] <= body["centerQ90"]
        assert body["widthSigma"] > 0
        assert 0.0 <= body["pAbove"] <= 1.0
        assert 0.0 <= body["pBelow"] <= 1.0
        assert body["modelVersion"] == "v1.0.0"
        assert 0.7 <= body["featureCompleteness"] <= 1.0
        assert body["psi"] == 0.0  # warm-up window
        assert body["fallback"] is False

    def test_predict_is_deterministic(self, client):
        snapshot = make_snapshot()
        b1 = client.post("/predict", json=snapshot).json()
        b2 = client.post("/predict", json=snapshot).json()
        for key in ("centerOffset", "centerQ10", "centerQ90", "widthSigma"):
            assert b1[key] == b2[key]

    def test_sparse_snapshot_flags_missing_fallback(self, client):
        body = client.post("/predict", json=make_snapshot(n_bars=8)).json()
        assert body["fallback"] == "missing"
        assert body["featureCompleteness"] < 0.7
        # full prediction is still returned for shadow comparison
        assert body["centerQ10"] <= body["centerOffset"] <= body["centerQ90"]

    def test_reload_swaps_model_and_bad_dir_keeps_serving(self, client, artifact_root):
        resp = client.post("/reload", json={"artifact_dir": str(artifact_root / "v1.1.0")})
        assert resp.status_code == 200
        assert resp.json() == {"model_version": "v1.1.0"}
        assert client.post("/predict", json=make_snapshot()).json()["modelVersion"] == "v1.1.0"

        resp = client.post("/reload", json={"artifact_dir": "/nonexistent/v9.9.9"})
        assert resp.status_code == 409
        # old (v1.1.0) bundle still serves
        assert client.get("/health").json()["model_version"] == "v1.1.0"
        assert client.post("/predict", json=make_snapshot()).json()["modelVersion"] == "v1.1.0"

    def test_ts_bar_timestamps_match_ts_contract(self, client):
        """Regression: TS sends bar timestamps as `ts` (src/prediction/types.ts).

        A pydantic field named `bucketStartMs` without an alias used to 422
        every real /predict call, silently degrading the provider to
        fallback="sidecar_down"."""
        snapshot = make_snapshot()
        assert all("ts" in bar for bar in snapshot["binance"]["sui"])
        resp = client.post("/predict", json=snapshot)
        assert resp.status_code == 200
        assert set(resp.json()) == PREDICTION_RESPONSE_KEYS

    def test_legacy_bucket_start_ms_alias_still_accepted(self, client):
        snapshot = make_snapshot()
        for key in ("sui", "btc", "eth"):
            for bar in snapshot["binance"][key]:
                bar["bucketStartMs"] = bar.pop("ts")
        resp = client.post("/predict", json=snapshot)
        assert resp.status_code == 200
        assert set(resp.json()) == PREDICTION_RESPONSE_KEYS

    def test_empty_bars_rejected_as_422(self, client):
        snapshot = make_snapshot()
        snapshot["binance"]["sui"] = []
        assert client.post("/predict", json=snapshot).status_code == 422


# --- sidecar-side derivative history ---


MIN_MS = 60_000


def _grid(start_ms: int, n: int) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(
        pd.to_datetime([start_ms + i * MIN_MS for i in range(n)], unit="ms", utc=True),
        name="ts",
    )


class TestDerivativesHistory:
    BASE = 1_750_000_000_000 - (1_750_000_000_000 % MIN_MS)

    def test_empty_history_yields_all_nan(self):
        cols = DerivativesHistory().columns(_grid(self.BASE, 10))
        for name in ("funding", "oi", "liq_1m"):
            assert cols[name].isna().all()

    def test_recorded_minutes_land_on_grid(self):
        hist = DerivativesHistory()
        for i in range(5):
            hist.record(self.BASE + i * MIN_MS, 0.0001 * (i + 1), 1e6 + i, float(i))
        cols = hist.columns(_grid(self.BASE, 5))
        assert cols["funding"].tolist() == pytest.approx([0.0001 * (i + 1) for i in range(5)])
        assert cols["oi"].tolist() == pytest.approx([1e6 + i for i in range(5)])
        assert cols["liq_1m"].tolist() == pytest.approx([0.0, 1.0, 2.0, 3.0, 4.0])

    def test_ffill_limits_mirror_training(self):
        # One observation at grid start: funding forward-fills far (limit 485),
        # oi only 5 minutes (training's OI sampling cadence), liq never.
        hist = DerivativesHistory()
        hist.record(self.BASE, 0.0002, 2e6, 7.0)
        cols = hist.columns(_grid(self.BASE, 20))
        assert cols["funding"].notna().all()  # 20 < FUNDING_FFILL_LIMIT
        assert cols["oi"].notna().tolist() == [True] * (OI_FFILL_LIMIT + 1) + [False] * (20 - OI_FFILL_LIMIT - 1)
        assert cols["liq_1m"].notna().tolist() == [True] + [False] * 19

    def test_funding_ffill_limit_is_not_infinite(self):
        hist = DerivativesHistory()
        hist.record(self.BASE, 0.0002, 2e6, 0.0)
        n = FUNDING_FFILL_LIMIT + 3
        cols = hist.columns(_grid(self.BASE, n))
        funding = cols["funding"]
        assert funding.iloc[: FUNDING_FFILL_LIMIT + 1].notna().all()
        assert funding.iloc[FUNDING_FFILL_LIMIT + 1 :].isna().all()

    def test_observation_before_grid_start_propagates_onto_grid(self):
        # ffill happens on a full minute grid spanning history∪grid, so an
        # observation 3 minutes before the window still covers its start.
        hist = DerivativesHistory()
        hist.record(self.BASE - 3 * MIN_MS, 0.0005, 3e6, 0.0)
        cols = hist.columns(_grid(self.BASE, 4))
        assert cols["funding"].notna().all()
        assert cols["oi"].notna().tolist() == [True, True, True, False]

    def test_retention_prunes_old_rows(self):
        hist = DerivativesHistory(retention_minutes=10)
        hist.record(self.BASE, 0.1, 1.0, 0.0)
        hist.record(self.BASE + 11 * MIN_MS, 0.2, 2.0, 0.0)
        cols = hist.columns(_grid(self.BASE, 12))
        # The BASE row was pruned (older than retention) — only the new one is left.
        assert cols["funding"].notna().sum() == 1

    def test_same_minute_overwrites(self):
        hist = DerivativesHistory()
        hist.record(self.BASE, 0.1, 1.0, 0.0)
        hist.record(self.BASE + 30_000, 0.2, 2.0, 0.0)  # same minute, floored
        cols = hist.columns(_grid(self.BASE, 1))
        assert cols["funding"].iloc[0] == pytest.approx(0.2)


class TestPsiExclusions:
    def test_fresh_snapshot_excludes_all_history_features(self):
        # A frame with derivative scalars on the last row only (no history)
        # must exclude every history-dependent derivative feature from PSI —
        # they are defaults-by-construction, not drift.
        snapshot = MarketSnapshot(**make_snapshot())
        frame = snapshot_to_frame(snapshot)
        assert _psi_exclusions(frame) == {"funding_ma_8h", "oi_change_30m", "liq_volume_5m"}

    def test_oi_becomes_real_after_31_minutes_of_history(self):
        snapshot = MarketSnapshot(**make_snapshot())
        frame = snapshot_to_frame(snapshot)
        hist = DerivativesHistory()
        # Record OI for the last 35 grid minutes (increasing so the delta ≠ 0).
        for i, ts in enumerate(frame.index[-35:]):
            hist.record(int(ts.value // 1_000_000), 0.0001, 1e6 + i * 1000, 0.0)
        cols = hist.columns(frame.index)
        for col, series in cols.items():
            frame[col] = frame[col].fillna(series)
        excl = _psi_exclusions(frame)
        assert "oi_change_30m" not in excl
        assert "funding_ma_8h" in excl  # 120-row frame < 480-row MA window
        assert "liq_volume_5m" not in excl  # 35 consecutive liq observations

    def test_nonpositive_oi_stays_excluded(self):
        snapshot = MarketSnapshot(**make_snapshot())
        frame = snapshot_to_frame(snapshot)
        hist = DerivativesHistory()
        for ts in frame.index[-35:]:
            hist.record(int(ts.value // 1_000_000), 0.0001, 0.0, 0.0)
        cols = hist.columns(frame.index)
        for col, series in cols.items():
            frame[col] = frame[col].fillna(series)
        assert "oi_change_30m" in _psi_exclusions(frame)

    def test_full_coverage_excludes_nothing(self):
        n = 480
        grid = _grid(TestDerivativesHistory.BASE, n)
        frame = pd.DataFrame(
            {
                "funding": np.full(n, 0.0001),
                "oi": np.linspace(1e6, 1.1e6, n),
                "liq_1m": np.zeros(n),
            },
            index=grid,
        )
        assert _psi_exclusions(frame) == set()


class TestServingConcurrency:
    def test_concurrent_predict_reload_health(self, artifact_root):
        """Threadpool-hammer the shared-state paths: /predict mutates the PSI
        tracker and derivative history, /reload swaps registry+tracker, and
        /health stacks the tracker window — all must stay consistent under
        the locks (sync endpoints run concurrently in Starlette's threadpool)."""
        client = TestClient(create_app(artifact_root / "v1.0.0"))
        snapshot = make_snapshot()
        results: list[tuple[str, int]] = []

        def hit_predict() -> None:
            for _ in range(6):
                results.append(("predict", client.post("/predict", json=snapshot).status_code))

        def hit_reload() -> None:
            for version in ("v1.1.0", "v1.0.0", "v1.1.0"):
                resp = client.post("/reload", json={"artifact_dir": str(artifact_root / version)})
                results.append(("reload", resp.status_code))

        def hit_health() -> None:
            for _ in range(10):
                results.append(("health", client.get("/health").status_code))

        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = [pool.submit(hit_predict) for _ in range(4)]
            futures.append(pool.submit(hit_reload))
            futures.append(pool.submit(hit_health))
            for f in futures:
                f.result()  # re-raises any thread exception

        assert all(status == 200 for _, status in results), results
        body = client.get("/health").json()
        assert body["status"] == "ok"
