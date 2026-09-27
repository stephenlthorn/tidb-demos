from src.freshness import freshness_lag_ms


def test_lag_is_difference_in_milliseconds():
    assert freshness_lag_ms(write_ts_ms=1_000, observed_ts_ms=1_450) == 450


def test_lag_is_zero_when_observed_equals_write():
    assert freshness_lag_ms(write_ts_ms=2_000, observed_ts_ms=2_000) == 0


def test_negative_lag_raises():
    try:
        freshness_lag_ms(write_ts_ms=2_000, observed_ts_ms=1_000)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "observed_ts_ms" in str(exc)
