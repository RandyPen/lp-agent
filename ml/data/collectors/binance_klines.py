"""Binance spot klines REST backfill (W1 deliverable).

Backfills 1m / 5m OHLCV history for SUIUSDC (primary), BTCUSDT and ETHUSDT
(cross-asset features) into monthly parquet partitions via
``data.parquet_writer``.

Network calls happen only when run as a CLI (``python -m
data.collectors.binance_klines``) or when ``backfill_klines`` is called
explicitly — importing this module performs no I/O.

Rate limiting: Binance allows 1200 request-weight per minute on spot. We track
the ``x-mbx-used-weight-1m`` response header and sleep to the next minute
boundary when approaching the cap; HTTP 429 honours ``Retry-After``; HTTP 418
(IP ban) is raised immediately.

Example:

    uv run python -m data.collectors.binance_klines \
        --symbol SUIUSDC --symbol BTCUSDT --symbol ETHUSDT \
        --interval 1m --interval 5m \
        --start 2025-06-01 --end 2026-06-01
"""

from __future__ import annotations

import argparse
import time
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pandas as pd

from data.parquet_writer import DEFAULT_DATA_ROOT, write_partitioned

SPOT_BASE_URL = "https://api.binance.com"
DEFAULT_SYMBOLS = ("SUIUSDC", "BTCUSDT", "ETHUSDT")
DEFAULT_INTERVALS = ("1m", "5m")
PAGE_LIMIT = 1000

INTERVAL_MS: dict[str, int] = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
}

KLINE_COLUMNS = (
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
)


def parse_utc_ms(value: str) -> int:
    """Parse an ISO date/datetime (assumed UTC if naive) to epoch milliseconds."""
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


class BinanceRest:
    """Thin rate-limit-aware GET wrapper around one Binance REST host."""

    def __init__(
        self,
        base_url: str,
        weight_soft_limit: int = 1100,
        timeout_s: float = 30.0,
    ) -> None:
        self._client = httpx.Client(base_url=base_url, timeout=timeout_s)
        self._weight_soft_limit = weight_soft_limit

    def get(self, path: str, params: dict) -> list | dict:
        while True:
            resp = self._client.get(path, params=params)
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("retry-after", "5"))
                time.sleep(retry_after)
                continue
            if resp.status_code == 418:
                raise RuntimeError(
                    "Binance returned 418 (IP auto-ban) — stop and back off manually"
                )
            resp.raise_for_status()
            used = int(resp.headers.get("x-mbx-used-weight-1m", "0"))
            if used >= self._weight_soft_limit:
                # Sleep through the remainder of the current minute window.
                time.sleep(60.0 - (time.time() % 60.0) + 0.5)
            return resp.json()

    def close(self) -> None:
        self._client.close()


def rows_to_frame(rows: list[list]) -> pd.DataFrame:
    """Convert raw /api/v3/klines rows to a typed DataFrame (KLINE_COLUMNS)."""
    df = pd.DataFrame(rows).iloc[:, : len(KLINE_COLUMNS)]
    df.columns = list(KLINE_COLUMNS)
    for col in ("open", "high", "low", "close", "volume", "quote_volume", "taker_buy_base", "taker_buy_quote"):
        df[col] = df[col].astype(float)
    for col in ("open_time", "close_time", "trades"):
        df[col] = df[col].astype("int64")
    return df


def fetch_klines(
    rest: BinanceRest,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
) -> Iterator[pd.DataFrame]:
    """Yield paginated kline pages covering [start_ms, end_ms)."""
    if interval not in INTERVAL_MS:
        raise ValueError(f"unsupported interval {interval!r}; known: {sorted(INTERVAL_MS)}")
    step = INTERVAL_MS[interval]
    cursor = start_ms
    while cursor < end_ms:
        rows = rest.get(
            "/api/v3/klines",
            {
                "symbol": symbol,
                "interval": interval,
                "startTime": cursor,
                "endTime": end_ms - 1,
                "limit": PAGE_LIMIT,
            },
        )
        if not rows:
            return
        page = rows_to_frame(rows)
        yield page
        cursor = int(page["open_time"].iloc[-1]) + step


def backfill_klines(
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    out_root: Path | str = DEFAULT_DATA_ROOT,
) -> int:
    """Backfill one symbol/interval into parquet. Returns rows written."""
    rest = BinanceRest(SPOT_BASE_URL)
    total = 0
    try:
        for page in fetch_klines(rest, symbol, interval, start_ms, end_ms):
            write_partitioned(page, out_root, f"binance/klines/{symbol}/{interval}", "open_time")
            total += len(page)
            print(
                f"[{symbol} {interval}] +{len(page)} rows "
                f"(through {pd.Timestamp(page['open_time'].iloc[-1], unit='ms', tz='UTC')})"
            )
    finally:
        rest.close()
    return total


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Backfill Binance spot klines to parquet")
    parser.add_argument(
        "--symbol",
        action="append",
        dest="symbols",
        help=f"repeatable; default: {' '.join(DEFAULT_SYMBOLS)}",
    )
    parser.add_argument(
        "--interval",
        action="append",
        dest="intervals",
        choices=sorted(INTERVAL_MS),
        help=f"repeatable; default: {' '.join(DEFAULT_INTERVALS)}",
    )
    parser.add_argument("--start", required=True, help="ISO date/datetime, UTC (inclusive)")
    parser.add_argument("--end", required=True, help="ISO date/datetime, UTC (exclusive)")
    parser.add_argument("--out-dir", default=str(DEFAULT_DATA_ROOT), help="parquet root")
    args = parser.parse_args(argv)

    symbols = args.symbols or list(DEFAULT_SYMBOLS)
    intervals = args.intervals or list(DEFAULT_INTERVALS)
    start_ms, end_ms = parse_utc_ms(args.start), parse_utc_ms(args.end)
    if end_ms <= start_ms:
        raise SystemExit("--end must be after --start")

    for symbol in symbols:
        for interval in intervals:
            rows = backfill_klines(symbol, interval, start_ms, end_ms, args.out_dir)
            print(f"[{symbol} {interval}] done: {rows} rows")


if __name__ == "__main__":
    main()
