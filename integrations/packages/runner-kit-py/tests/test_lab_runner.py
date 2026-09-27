import io
import json
import time

import pytest

from lab_runner import (
    Emitter,
    SampleWindow,
    on_control,
    parse_control_line,
    percentile,
    summarize,
    tidb_config_from_env,
    timed,
)


def clock_from(times):
    values = iter(times)
    last = times[-1]
    return lambda: next(values, last)


def capture():
    lines = []
    return lines, lines.append


def test_emitter_stamps_elapsed_time():
    lines, write = capture()
    emitter = Emitter(clock=clock_from([1000.0, 1250.0]), write=write)
    emitter.metric("ingest-rate", 42)
    assert json.loads(lines[0]) == {"type": "metric", "id": "ingest-rate", "value": 42, "t": 250.0}


def test_emitter_omits_missing_optionals_and_terminates_lines():
    lines, write = capture()
    emitter = Emitter(clock=clock_from([0.0, 1.0]), write=write)
    emitter.node("tidb", "down")
    assert lines[0].endswith("\n")
    assert "note" not in json.loads(lines[0])


def test_percentile_nearest_rank():
    values = list(range(1, 101))
    assert percentile(values, 50) == 50
    assert percentile(values, 99) == 99
    assert percentile([], 99) is None


def test_summarize():
    summary = summarize(list(range(1, 101)))
    assert (summary.count, summary.p50, summary.p95, summary.p99, summary.max) == (100, 50, 95, 99, 100)
    assert summarize([]) is None


def test_sample_window_drains():
    window = SampleWindow()
    window.add(5.0)
    window.add(7.0)
    assert window.drain() == (5.0, 7.0)
    assert window.drain() == ()


def test_timed_returns_value_and_elapsed_ms():
    value, ms = timed(lambda: "done", clock=clock_from([10.0, 35.0]))
    assert (value, ms) == ("done", 25.0)


def test_parse_control_line():
    assert parse_control_line('{"control":"burst"}') == "burst"
    assert parse_control_line("garbage") is None
    assert parse_control_line('{"control":"Not Kebab"}') is None


def test_on_control_reads_lines():
    received = []
    on_control(received.append, io.StringIO('{"control":"burst"}\nbad\n'))
    time.sleep(0.05)
    assert received == ["burst"]


def test_tidb_config_defaults_and_tls():
    assert tidb_config_from_env({}) == {
        "host": "127.0.0.1",
        "port": 4000,
        "user": "root",
        "password": "",
        "database": "lab",
    }
    tls = tidb_config_from_env({"TIDB_TLS": "true"})
    assert tls["ssl_verify_cert"] is True
    assert tls["ssl_verify_identity"] is True
    assert tls["ssl_ca"] == "/etc/ssl/cert.pem"


def test_tidb_config_rejects_bad_port():
    with pytest.raises(ValueError, match="TIDB_PORT must be a number"):
        tidb_config_from_env({"TIDB_PORT": "four"})
