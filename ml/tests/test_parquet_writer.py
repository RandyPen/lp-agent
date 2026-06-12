"""Parquet persistence: monthly partitioning, idempotent upsert, range reads."""

import pandas as pd
import pytest

from data.parquet_writer import month_key, read_partitioned, write_partitioned


def klines(times_ms: list[int], closes: list[float]) -> pd.DataFrame:
    return pd.DataFrame({"open_time": times_ms, "close": closes})


JAN = int(pd.Timestamp("2025-01-15", tz="UTC").timestamp() * 1000)
FEB = int(pd.Timestamp("2025-02-15", tz="UTC").timestamp() * 1000)


class TestPartitioning:
    def test_month_key(self):
        assert month_key(JAN) == "2025-01"
        assert month_key(FEB) == "2025-02"

    def test_writes_one_file_per_month(self, tmp_path):
        paths = write_partitioned(
            klines([JAN, FEB], [1.0, 2.0]), tmp_path, "binance/klines/X/1m", "open_time"
        )
        assert [p.name for p in paths] == ["2025-01.parquet", "2025-02.parquet"]

    def test_roundtrip_and_range_filter(self, tmp_path):
        write_partitioned(klines([JAN, FEB], [1.0, 2.0]), tmp_path, "d", "open_time")
        full = read_partitioned(tmp_path, "d", "open_time")
        assert full["close"].tolist() == [1.0, 2.0]
        jan_only = read_partitioned(tmp_path, "d", "open_time", end_ms=FEB)
        assert jan_only["close"].tolist() == [1.0]

    def test_upsert_dedupes_and_new_rows_win(self, tmp_path):
        write_partitioned(klines([JAN], [1.0]), tmp_path, "d", "open_time")
        write_partitioned(klines([JAN, JAN + 60_000], [9.0, 2.0]), tmp_path, "d", "open_time")
        out = read_partitioned(tmp_path, "d", "open_time")
        assert out["close"].tolist() == [9.0, 2.0]  # re-collected row replaced

    def test_rows_kept_sorted(self, tmp_path):
        write_partitioned(klines([JAN + 60_000, JAN], [2.0, 1.0]), tmp_path, "d", "open_time")
        out = read_partitioned(tmp_path, "d", "open_time")
        assert out["open_time"].is_monotonic_increasing

    def test_missing_dataset_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError, match="run the collector"):
            read_partitioned(tmp_path, "nope", "open_time")

    def test_empty_frame_is_noop(self, tmp_path):
        assert write_partitioned(pd.DataFrame(columns=["open_time"]), tmp_path, "d", "open_time") == []
