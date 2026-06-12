"""FastAPI inference sidecar (plan W4, contract per plan §3.3/§3.4).

Endpoints
---------
``GET /health``    → ``{status, model_version, loaded_at, psi_summary}``
``POST /predict``  → input ``MarketSnapshot`` (camelCase, same shape as
                     ``src/prediction/types.ts``), output ``PredictionResponse``
                     with exactly these keys: ``centerOffset, centerQ10,
                     centerQ90, widthSigma, pAbove, pBelow, modelVersion,
                     featureCompleteness, psi, fallback``
``POST /reload``   → ``{"artifact_dir": …}``; hot-swap via the model registry,
                     HTTP 409 + old model keeps serving on failure.

Fallback semantics (sidecar side; the TS provider adds ``sidecar_down`` /
``timeout`` on top): ``"missing"`` when featureCompleteness < 0.7, else
``"psi"`` when rolling max feature PSI > 0.25, else ``false``. Even in
fallback the full prediction is returned — the consumer (mlAgent) decides
whether to discard it (degradation authority lives with the consumer).

Feature assembly uses ``features.registry`` directly — the same code that
built the training matrix. Derivatives arrive as point-in-time scalars, so
they are placed on the last grid row only; history-dependent derivative
features stay NaN and default-fill, which ``featureCompleteness`` reflects
honestly instead of broadcasting constants into fake history.

Contract decisions beyond the docs (documented here on purpose):

* ``pAbove``/``pBelow`` are the probabilities that the predicted 30-min
  center lands above/below the current active bin, i.e. outside the
  ``[lowerOffset, upperOffset]`` band (default ±0.5 bin). A caller that wants
  range-break probabilities for a wider position passes the optional
  ``pmRangeContext: {lowerOffset, upperOffset}`` field on the snapshot.
* Quantile crossings (q10 > q50 etc., possible with independently trained
  quantile models) are repaired by sorting the three predictions.
* ``cetus.binStep`` on the snapshot is accepted but not used in computation:
  the models are trained for a fixed bin step recorded in
  ``models_meta.json``; mixing per-request bin steps would silently change
  the unit of the labels.

The server binds 127.0.0.1 only.

Run:

    PREDICTION_ARTIFACT_DIR=artifacts/v1.0.0 uv run python -m serving.app
    # or: uv run python -m serving.app --artifact-dir artifacts/v1.0.0 --port 8765
"""

from __future__ import annotations

import argparse
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from features.registry import build_feature_vector
from serving.psi import PsiTracker
from serving.registry import ModelRegistry

DEFAULT_PORT = 8765
BIND_HOST = "127.0.0.1"  # local sidecar only — never expose externally
WIDTH_DIVISOR = 2.56  # (q90 - q10) / 2.56 ≈ σ for a normal distribution
MIN_WIDTH_SIGMA = 1e-9
PSI_FALLBACK_THRESHOLD = 0.25
COMPLETENESS_FALLBACK_THRESHOLD = 0.7


# --- request / response models (camelCase mirrors src/prediction/types.ts) ---


class OhlcvBar(BaseModel):
    bucketStartMs: int
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None  # TS OhlcvBar carries no volume; optional here


class CetusState(BaseModel):
    activeBin: int
    price: str
    tvlUsd: float
    binStep: float


class BinanceBars(BaseModel):
    sui: list[OhlcvBar]
    btc: list[OhlcvBar]
    eth: list[OhlcvBar]


class DerivativesState(BaseModel):
    funding: float
    oi: float
    liq1m: float


class PmRangeContext(BaseModel):
    lowerOffset: float = -0.5
    upperOffset: float = 0.5


class MarketSnapshot(BaseModel):
    ts: int
    cetus: CetusState
    binance: BinanceBars
    derivatives: DerivativesState
    spread: float
    pmRangeContext: PmRangeContext | None = None


class ReloadRequest(BaseModel):
    artifact_dir: str


# --- snapshot → canonical frame ---


def _bars_frame(bars: list[OhlcvBar], prefix: str, fields: tuple[str, ...]) -> pd.DataFrame:
    if not bars:
        raise ValueError(f"snapshot has no {prefix} bars")
    rows = sorted(bars, key=lambda b: b.bucketStartMs)
    data = {f"{prefix}_{f}": [getattr(b, f) for b in rows] for f in fields}
    index = pd.DatetimeIndex(
        pd.to_datetime([b.bucketStartMs for b in rows], unit="ms", utc=True), name="ts"
    )
    df = pd.DataFrame(data, index=index)
    return df[~df.index.duplicated(keep="last")]


def snapshot_to_frame(snapshot: MarketSnapshot) -> pd.DataFrame:
    """Assemble the canonical 1-min frame from a MarketSnapshot.

    The SUI bar grid is the spine; BTC/ETH closes are joined on matching
    timestamps. Derivative scalars are set on the last row only (see module
    docstring for why no constant broadcasting)."""
    sui = _bars_frame(snapshot.binance.sui, "sui", ("open", "high", "low", "close"))
    btc = _bars_frame(snapshot.binance.btc, "btc", ("close",))
    eth = _bars_frame(snapshot.binance.eth, "eth", ("close",))

    frame = sui.join(btc, how="left").join(eth, how="left")
    for col, value in (
        ("funding", snapshot.derivatives.funding),
        ("oi", snapshot.derivatives.oi),
        ("liq_1m", snapshot.derivatives.liq1m),
    ):
        series = pd.Series(np.nan, index=frame.index, dtype=float)
        series.iloc[-1] = value
        frame[col] = series
    return frame


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


# --- app factory ---


def create_app(
    artifact_dir: Path | str,
    psi_threshold: float = PSI_FALLBACK_THRESHOLD,
    completeness_threshold: float = COMPLETENESS_FALLBACK_THRESHOLD,
) -> FastAPI:
    app = FastAPI(title="LiquidityManager prediction sidecar")
    registry = ModelRegistry.from_dir(artifact_dir)

    def make_tracker() -> PsiTracker:
        bundle = registry.current()
        return PsiTracker(bundle.psi_baseline, bundle.feature_names)

    state = {"registry": registry, "tracker": make_tracker()}

    @app.get("/health")
    def health() -> dict:
        bundle = state["registry"].current()
        summary = state["tracker"].summary()
        return {
            "status": "ok",
            "model_version": bundle.version,
            "loaded_at": bundle.loaded_at,
            "psi_summary": {
                "max": summary["max"],
                "breached": summary["breached"],
                "n_obs": summary["n_obs"],
            },
        }

    @app.post("/predict")
    def predict(snapshot: MarketSnapshot) -> dict:
        bundle = state["registry"].current()
        try:
            frame = snapshot_to_frame(snapshot)
            x, completeness = build_feature_vector(frame)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        raw = [float(bundle.boosters[k].predict(x)[0]) for k in ("q10", "q50", "q90")]
        q10, q50, q90 = sorted(raw)  # repair quantile crossings (documented)
        width_sigma = max((q90 - q10) / WIDTH_DIVISOR, MIN_WIDTH_SIGMA)

        ctx = snapshot.pmRangeContext or PmRangeContext()
        p_above = 1.0 - _norm_cdf((ctx.upperOffset - q50) / width_sigma)
        p_below = _norm_cdf((ctx.lowerOffset - q50) / width_sigma)

        psi_summary = state["tracker"].observe(x[0])
        psi_max = float(psi_summary["max"])

        fallback: bool | str = False
        if completeness < completeness_threshold:
            fallback = "missing"
        elif psi_max > psi_threshold:
            fallback = "psi"

        return {
            "centerOffset": q50,
            "centerQ10": q10,
            "centerQ90": q90,
            "widthSigma": width_sigma,
            "pAbove": p_above,
            "pBelow": p_below,
            "modelVersion": bundle.version,
            "featureCompleteness": completeness,
            "psi": psi_max,
            "fallback": fallback,
        }

    @app.post("/reload")
    def reload(body: ReloadRequest) -> dict:
        try:
            bundle = state["registry"].swap(body.artifact_dir)
        except Exception as exc:
            # Old bundle keeps serving — a failed reload must never take the
            # previous model offline (prediction-service-design.md §4.2).
            raise HTTPException(status_code=409, detail=f"reload failed: {exc}") from exc
        state["tracker"] = make_tracker()
        return {"model_version": bundle.version}

    return app


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="Prediction sidecar (127.0.0.1 only)")
    parser.add_argument(
        "--artifact-dir",
        default=os.environ.get("PREDICTION_ARTIFACT_DIR"),
        help="artifact directory, e.g. artifacts/v1.0.0 (env PREDICTION_ARTIFACT_DIR)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PREDICTION_SIDECAR_PORT", DEFAULT_PORT)),
        help=f"listen port (env PREDICTION_SIDECAR_PORT, default {DEFAULT_PORT})",
    )
    args = parser.parse_args(argv)
    if not args.artifact_dir:
        raise SystemExit("--artifact-dir (or PREDICTION_ARTIFACT_DIR) is required")

    uvicorn.run(create_app(args.artifact_dir), host=BIND_HOST, port=args.port)


if __name__ == "__main__":
    main()
