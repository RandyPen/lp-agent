"""Binance USDⓈ-M derivatives backfill: funding rate + open interest (W1).

Datasets written (monthly parquet partitions, see ``data.parquet_writer``):

    binance/funding/<SYMBOL>   columns: ts, funding_rate
    binance/oi/<SYMBOL>        columns: ts, open_interest, open_interest_value

Notes / limitations (documented, not silently worked around):

* **Funding** (``/fapi/v1/fundingRate``) settles every 8h and has full history.
* **Open interest** (``/futures/data/openInterestHist``) — Binance only serves
  roughly the trailing 30 days. Backfill what is available; the live agent
  accumulates the rest going forward.
* **Liquidations** — Binance removed the REST endpoint for historical force
  orders (``/fapi/v1/allForceOrders``) in 2021. There is **no backfill path**;
  liquidations are captured live by the TS agent via
  ``wss://fstream.binance.com/ws/!forceOrder@arr`` (docs/data-sources.md).
  ``collect_liquidations`` raises ``NotImplementedError`` to make that explicit.

Importing this module performs no network I/O.

Example:

    uv run python -m data.collectors.binance_derivatives \
        --kind funding --symbol SUIUSDT --start 2025-06-01 --end 2026-06-01
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from data.collectors.binance_klines import BinanceRest, parse_utc_ms
from data.parquet_writer import DEFAULT_DATA_ROOT, write_partitioned

FUTURES_BASE_URL = "https://fapi.binance.com"
DEFAULT_FUTURES_SYMBOL = "SUIUSDT"
FUNDING_PAGE_LIMIT = 1000
OI_PAGE_LIMIT = 500


def fetch_funding(
    rest: BinanceRest,
    symbol: str,
    start_ms: int,
    end_ms: int,
) -> pd.DataFrame:
    """Paginate /fapi/v1/fundingRate over [start_ms, end_ms)."""
    frames: list[pd.DataFrame] = []
    cursor = start_ms
    while cursor < end_ms:
        rows = rest.get(
            "/fapi/v1/fundingRate",
            {
                "symbol": symbol,
                "startTime": cursor,
                "endTime": end_ms - 1,
                "limit": FUNDING_PAGE_LIMIT,
            },
        )
        if not rows:
            break
        df = pd.DataFrame(rows)
        frames.append(
            pd.DataFrame(
                {
                    "ts": df["fundingTime"].astype("int64"),
                    "funding_rate": df["fundingRate"].astype(float),
                }
            )
        )
        cursor = int(df["fundingTime"].iloc[-1]) + 1
        if len(rows) < FUNDING_PAGE_LIMIT:
            break
    if not frames:
        return pd.DataFrame(columns=["ts", "funding_rate"])
    return pd.concat(frames, ignore_index=True)


def fetch_open_interest_hist(
    rest: BinanceRest,
    symbol: str,
    start_ms: int,
    end_ms: int,
    period: str = "5m",
) -> pd.DataFrame:
    """Paginate /futures/data/openInterestHist (Binance keeps ~30 days only)."""
    frames: list[pd.DataFrame] = []
    cursor = start_ms
    while cursor < end_ms:
        rows = rest.get(
            "/futures/data/openInterestHist",
            {
                "symbol": symbol,
                "period": period,
                "startTime": cursor,
                "endTime": end_ms - 1,
                "limit": OI_PAGE_LIMIT,
            },
        )
        if not rows:
            break
        df = pd.DataFrame(rows)
        frames.append(
            pd.DataFrame(
                {
                    "ts": df["timestamp"].astype("int64"),
                    "open_interest": df["sumOpenInterest"].astype(float),
                    "open_interest_value": df["sumOpenInterestValue"].astype(float),
                }
            )
        )
        cursor = int(df["timestamp"].iloc[-1]) + 1
        if len(rows) < OI_PAGE_LIMIT:
            break
    if not frames:
        return pd.DataFrame(columns=["ts", "open_interest", "open_interest_value"])
    return pd.concat(frames, ignore_index=True)


def collect_liquidations(*_args: object, **_kwargs: object) -> None:
    """Historical liquidations cannot be backfilled — see module docstring."""
    raise NotImplementedError(
        "Binance removed the REST endpoint for historical liquidations "
        "(/fapi/v1/allForceOrders). Capture them live via the forceOrder "
        "WebSocket stream in the TS agent (docs/data-sources.md); there is "
        "no REST backfill path."
    )


def backfill_derivatives(
    kind: str,
    symbol: str,
    start_ms: int,
    end_ms: int,
    out_root: Path | str = DEFAULT_DATA_ROOT,
    period: str = "5m",
) -> int:
    """Backfill one derivatives dataset into parquet. Returns rows written."""
    rest = BinanceRest(FUTURES_BASE_URL)
    try:
        if kind == "funding":
            df = fetch_funding(rest, symbol, start_ms, end_ms)
            subdir = f"binance/funding/{symbol}"
        elif kind == "oi":
            df = fetch_open_interest_hist(rest, symbol, start_ms, end_ms, period)
            subdir = f"binance/oi/{symbol}"
        elif kind == "liquidations":
            collect_liquidations()
            raise AssertionError("unreachable")
        else:
            raise ValueError(f"unknown derivatives kind {kind!r}")
    finally:
        rest.close()

    write_partitioned(df, out_root, subdir, "ts")
    return len(df)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Backfill Binance derivatives to parquet")
    parser.add_argument("--kind", required=True, choices=("funding", "oi", "liquidations"))
    parser.add_argument("--symbol", default=DEFAULT_FUTURES_SYMBOL)
    parser.add_argument("--period", default="5m", help="open-interest sampling period")
    parser.add_argument("--start", required=True, help="ISO date/datetime, UTC (inclusive)")
    parser.add_argument("--end", required=True, help="ISO date/datetime, UTC (exclusive)")
    parser.add_argument("--out-dir", default=str(DEFAULT_DATA_ROOT), help="parquet root")
    args = parser.parse_args(argv)

    rows = backfill_derivatives(
        args.kind,
        args.symbol,
        parse_utc_ms(args.start),
        parse_utc_ms(args.end),
        args.out_dir,
        args.period,
    )
    print(f"[{args.symbol} {args.kind}] done: {rows} rows")


if __name__ == "__main__":
    main()
