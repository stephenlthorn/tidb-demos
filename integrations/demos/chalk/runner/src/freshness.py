def freshness_lag_ms(write_ts_ms: int, observed_ts_ms: int) -> int:
    if observed_ts_ms < write_ts_ms:
        raise ValueError("observed_ts_ms must not precede write_ts_ms")
    return observed_ts_ms - write_ts_ms
