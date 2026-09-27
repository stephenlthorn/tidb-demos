from datetime import datetime, timezone

from src.baseline_sql import build_baseline_query


def test_txn_count_1h_query_and_params():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    sql, params = build_baseline_query("txn-count-1h", user_id=42, now=now)
    assert "count(*)" in sql.lower()
    assert "transactions" in sql.lower()
    assert params == {"user_id": 42, "window_start": datetime(2026, 1, 1, 11, 0, 0, tzinfo=timezone.utc)}


def test_amount_sum_24h_query_and_params():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    sql, params = build_baseline_query("amount-sum-24h", user_id=7, now=now)
    assert "sum(amount)" in sql.lower()
    assert params["window_start"] == datetime(2025, 12, 31, 12, 0, 0, tzinfo=timezone.utc)


def test_distinct_merchants_24h_query_and_params():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    sql, params = build_baseline_query("distinct-merchants-24h", user_id=7, now=now)
    assert "count(distinct merchant_id)" in sql.lower()
    assert params["window_start"] == datetime(2025, 12, 31, 12, 0, 0, tzinfo=timezone.utc)


def test_unknown_feature_id_raises():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    try:
        build_baseline_query("not-a-real-feature", user_id=1, now=now)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "not-a-real-feature" in str(exc)
