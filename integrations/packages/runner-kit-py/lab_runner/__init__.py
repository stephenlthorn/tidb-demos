from __future__ import annotations

import json
import re
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence, TextIO

import pymysql

Clock = Callable[[], float]
Writer = Callable[[str], None]

_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _monotonic_ms() -> float:
    return time.monotonic() * 1000.0


def _stdout_write(line: str) -> None:
    sys.stdout.write(line)
    sys.stdout.flush()


class Emitter:
    def __init__(self, clock: Optional[Clock] = None, write: Optional[Writer] = None) -> None:
        self._clock = clock or _monotonic_ms
        self._write = write or _stdout_write
        self._start = self._clock()
        self._lock = threading.Lock()

    def elapsed_ms(self) -> float:
        return self._clock() - self._start

    def _emit(self, body: Mapping[str, object]) -> None:
        payload = {key: value for key, value in body.items() if value is not None}
        with self._lock:
            self._write(json.dumps({**payload, "t": self.elapsed_ms()}) + "\n")

    def metric(self, id: str, value: float) -> None:
        self._emit({"type": "metric", "id": id, "value": value})

    def flow(self, edge: str, count: int) -> None:
        self._emit({"type": "flow", "edge": edge, "count": count})

    def node(self, node: str, status: str, note: Optional[str] = None) -> None:
        self._emit({"type": "node", "node": node, "status": status, "note": note})

    def phase(self, phase: str) -> None:
        self._emit({"type": "phase", "phase": phase})

    def check(self, id: str, status: str, observed: Optional[str] = None) -> None:
        self._emit({"type": "check", "id": id, "status": status, "observed": observed})

    def log(self, level: str, msg: str, node: Optional[str] = None) -> None:
        self._emit({"type": "log", "level": level, "msg": msg, "node": node})


@dataclass(frozen=True)
class LatencySummary:
    count: int
    p50: float
    p95: float
    p99: float
    max: float


def _nearest_rank(sorted_values: Sequence[float], p: float) -> float:
    rank = -(-p * len(sorted_values) // 100)
    index = min(max(int(rank) - 1, 0), len(sorted_values) - 1)
    return sorted_values[index]


def percentile(values: Sequence[float], p: float) -> Optional[float]:
    if not values:
        return None
    return _nearest_rank(sorted(values), p)


def summarize(values: Sequence[float]) -> Optional[LatencySummary]:
    if not values:
        return None
    ordered = sorted(values)
    return LatencySummary(
        count=len(ordered),
        p50=_nearest_rank(ordered, 50),
        p95=_nearest_rank(ordered, 95),
        p99=_nearest_rank(ordered, 99),
        max=ordered[-1],
    )


class SampleWindow:
    def __init__(self) -> None:
        self._values: list = []
        self._lock = threading.Lock()

    def add(self, value: float) -> None:
        with self._lock:
            self._values.append(value)

    def drain(self) -> tuple:
        with self._lock:
            drained = tuple(self._values)
            self._values.clear()
            return drained


def timed(task: Callable[[], object], clock: Optional[Clock] = None) -> tuple:
    now = clock or _monotonic_ms
    start = now()
    value = task()
    return value, now() - start


def parse_control_line(line: str) -> Optional[str]:
    text = line.strip()
    if not text:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    control = payload.get("control") if isinstance(payload, dict) else None
    if isinstance(control, str) and _SLUG.match(control):
        return control
    return None


def on_control(handler: Callable[[str], None], stream: Optional[TextIO] = None) -> threading.Thread:
    source = stream or sys.stdin

    def read() -> None:
        for line in source:
            control = parse_control_line(line)
            if control is not None:
                handler(control)

    thread = threading.Thread(target=read, daemon=True)
    thread.start()
    return thread


def _port(value: Optional[str]) -> int:
    text = value or "4000"
    if not text.isdigit():
        raise ValueError("TIDB_PORT must be a number")
    return int(text)


def tidb_config_from_env(env: Mapping[str, str]) -> dict:
    base = {
        "host": env.get("TIDB_HOST", "127.0.0.1"),
        "port": _port(env.get("TIDB_PORT")),
        "user": env.get("TIDB_USER", "root"),
        "password": env.get("TIDB_PASSWORD", ""),
        "database": env.get("TIDB_DATABASE", "lab"),
    }
    if env.get("TIDB_TLS") != "true":
        return base
    return {
        **base,
        "ssl_verify_cert": True,
        "ssl_verify_identity": True,
        "ssl_ca": env.get("TIDB_CA_PATH", "/etc/ssl/cert.pem"),
    }


def tidb_connect_from_env(env: Optional[Mapping[str, str]] = None) -> pymysql.connections.Connection:
    import os

    return pymysql.connect(**tidb_config_from_env(env if env is not None else os.environ), autocommit=True)
