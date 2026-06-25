#!/usr/bin/env python3
"""
Write-Scale Benchmark: Single-Writer MySQL vs TiDB Distributed SQL

Runs concurrent INSERT workloads against a single-node MySQL instance and a
TiDB Cloud cluster using identical schema and SQL, then reports throughput and
latency metrics side by side.

Usage:
    python benchmark.py [--tidb-only] [--mysql-only]

All connection details are read from environment variables. See README.md.
"""

import argparse
import csv
import os
import statistics
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import pymysql

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MYSQL_CFG = {
    "host": os.getenv("MYSQL_HOST", "127.0.0.1"),
    "port": int(os.getenv("MYSQL_PORT", "3306")),
    "user": os.getenv("MYSQL_USER", "root"),
    "password": os.getenv("MYSQL_PASSWORD", "demo"),
    "db": os.getenv("MYSQL_DB", "benchmark"),
    "ssl": None,
}

TIDB_CFG = {
    "host": os.getenv("TIDB_HOST", ""),
    "port": int(os.getenv("TIDB_PORT", "4000")),
    "user": os.getenv("TIDB_USER", ""),
    "password": os.getenv("TIDB_PASSWORD", ""),
    "db": os.getenv("TIDB_DB", "benchmark"),
    "ssl": {"ssl_verify_cert": True} if os.getenv("TIDB_SSL", "true").lower() == "true" else None,
}

WORKERS = int(os.getenv("WORKERS", "20"))
DURATION = int(os.getenv("DURATION", "60"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "50"))


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

DDL_MYSQL = """
CREATE TABLE IF NOT EXISTS events_inc (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(36)  NOT NULL,
    event_type VARCHAR(32)  NOT NULL,
    payload    JSON,
    created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
"""

DDL_TIDB_INC = """
CREATE TABLE IF NOT EXISTS events_inc (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(36)  NOT NULL,
    event_type VARCHAR(32)  NOT NULL,
    payload    JSON,
    created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
"""

DDL_TIDB_RAND = """
CREATE TABLE IF NOT EXISTS events_rand (
    id         BIGINT       NOT NULL AUTO_RANDOM PRIMARY KEY,
    session_id VARCHAR(36)  NOT NULL,
    event_type VARCHAR(32)  NOT NULL,
    payload    JSON,
    created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
"""

INSERT_INC = """
INSERT INTO events_inc (session_id, event_type, payload)
VALUES {placeholders}
"""

INSERT_RAND = """
INSERT INTO events_rand (session_id, event_type, payload)
VALUES {placeholders}
"""

SAMPLE_EVENTS = ["click", "view", "purchase", "search", "login", "logout"]


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

@dataclass
class WorkerResult:
    rows_inserted: int = 0
    latencies_ms: list = field(default_factory=list)
    errors: int = 0


def make_connection(cfg: dict) -> pymysql.Connection:
    kwargs = {
        "host": cfg["host"],
        "port": cfg["port"],
        "user": cfg["user"],
        "password": cfg["password"],
        "database": cfg["db"],
        "autocommit": True,
        "connect_timeout": 10,
    }
    if cfg.get("ssl"):
        kwargs["ssl"] = cfg["ssl"]
    return pymysql.connect(**kwargs)


def worker_fn(
    cfg: dict,
    insert_sql_template: str,
    stop_event: threading.Event,
    result: WorkerResult,
    batch_size: int,
):
    """Single writer thread: INSERT in batches until stop_event is set."""
    import uuid, json, random

    try:
        conn = make_connection(cfg)
        cursor = conn.cursor()
    except Exception as e:
        result.errors += 1
        return

    placeholders = ", ".join(["(%s, %s, %s)"] * batch_size)
    sql = insert_sql_template.format(placeholders=placeholders)

    while not stop_event.is_set():
        values = []
        for _ in range(batch_size):
            values.extend([
                str(uuid.uuid4()),
                random.choice(SAMPLE_EVENTS),
                json.dumps({"worker": threading.current_thread().name, "ts": time.time()}),
            ])
        t0 = time.perf_counter()
        try:
            cursor.execute(sql, values)
            elapsed_ms = (time.perf_counter() - t0) * 1000
            result.rows_inserted += batch_size
            result.latencies_ms.append(elapsed_ms)
        except Exception:
            result.errors += 1

    cursor.close()
    conn.close()


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------

@dataclass
class BenchmarkResult:
    label: str
    total_rows: int
    duration_s: float
    latencies_ms: list
    errors: int

    @property
    def avg_tps(self) -> float:
        return self.total_rows / self.duration_s if self.duration_s > 0 else 0

    @property
    def p99_ms(self) -> float:
        if not self.latencies_ms:
            return 0.0
        sorted_l = sorted(self.latencies_ms)
        idx = int(len(sorted_l) * 0.99)
        return sorted_l[min(idx, len(sorted_l) - 1)]

    @property
    def p50_ms(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return statistics.median(self.latencies_ms)


def run_benchmark(
    label: str,
    cfg: dict,
    insert_sql_template: str,
    n_workers: int,
    duration_s: int,
    batch_size: int,
) -> Optional[BenchmarkResult]:
    """Spin up n_workers threads against cfg, collect results."""
    print(f"\n  Starting: {label}  ({n_workers} workers, {duration_s}s) ...", flush=True)

    results = [WorkerResult() for _ in range(n_workers)]
    stop_event = threading.Event()
    threads = []

    for i, res in enumerate(results):
        t = threading.Thread(
            target=worker_fn,
            args=(cfg, insert_sql_template, stop_event, res, batch_size),
            name=f"w{i}",
            daemon=True,
        )
        threads.append(t)

    t_start = time.perf_counter()
    for t in threads:
        t.start()

    # Progress dots
    deadline = t_start + duration_s
    while time.perf_counter() < deadline:
        time.sleep(5)
        elapsed = time.perf_counter() - t_start
        total_so_far = sum(r.rows_inserted for r in results)
        print(f"    {elapsed:.0f}s  |  {total_so_far:,} rows inserted", flush=True)

    stop_event.set()
    for t in threads:
        t.join(timeout=5)

    actual_duration = time.perf_counter() - t_start
    all_latencies = []
    total_rows = 0
    total_errors = 0
    for r in results:
        total_rows += r.rows_inserted
        total_errors += r.errors
        all_latencies.extend(r.latencies_ms)

    return BenchmarkResult(
        label=label,
        total_rows=total_rows,
        duration_s=actual_duration,
        latencies_ms=all_latencies,
        errors=total_errors,
    )


# ---------------------------------------------------------------------------
# Setup helpers
# ---------------------------------------------------------------------------

def setup_schema(cfg: dict, ddls: list[str], label: str):
    print(f"  Setting up schema on {label}...", flush=True)
    conn = make_connection(cfg)
    cursor = conn.cursor()
    for ddl in ddls:
        cursor.execute(ddl)
    conn.commit()
    cursor.close()
    conn.close()


def truncate_tables(cfg: dict, tables: list[str]):
    conn = make_connection(cfg)
    cursor = conn.cursor()
    cursor.execute("SET FOREIGN_KEY_CHECKS=0")
    for tbl in tables:
        try:
            cursor.execute(f"TRUNCATE TABLE {tbl}")
        except Exception:
            pass
    cursor.execute("SET FOREIGN_KEY_CHECKS=1")
    conn.commit()
    cursor.close()
    conn.close()


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def print_results(results: list[BenchmarkResult], workers: int, duration: int, batch: int):
    print("\n" + "=" * 70)
    print(" WRITE-SCALE BENCHMARK RESULTS")
    print("=" * 70)
    print(f" Workers: {workers}  |  Duration: {duration}s  |  Batch size: {batch} rows\n")

    header = f"{'Target':<30}  {'Total Rows':>12}  {'Avg TPS':>10}  {'P50 ms':>8}  {'P99 ms':>8}  {'Errors':>7}"
    print(header)
    print("-" * len(header))
    for r in results:
        print(
            f"{r.label:<30}  {r.total_rows:>12,}  {r.avg_tps:>10,.0f}  "
            f"{r.p50_ms:>8.1f}  {r.p99_ms:>8.1f}  {r.errors:>7}"
        )
    print("=" * 70)


def save_csv(results: list[BenchmarkResult], workers: int, duration: int):
    filename = f"results_{workers}workers_{duration}s.csv"
    with open(filename, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["target", "total_rows", "avg_tps", "p50_ms", "p99_ms", "errors"])
        for r in results:
            writer.writerow([r.label, r.total_rows, f"{r.avg_tps:.0f}", f"{r.p50_ms:.1f}", f"{r.p99_ms:.1f}", r.errors])
    print(f"\n  Results saved to: {filename}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Write-scale benchmark: MySQL vs TiDB")
    parser.add_argument("--tidb-only", action="store_true", help="Skip MySQL target")
    parser.add_argument("--mysql-only", action="store_true", help="Skip TiDB target")
    args = parser.parse_args()

    run_mysql = not args.tidb_only
    run_tidb = not args.mysql_only

    if run_tidb and not TIDB_CFG["host"]:
        print("ERROR: TIDB_HOST is not set. See README.md for configuration.")
        return

    print("\n" + "=" * 70)
    print(" WRITE-SCALE BENCHMARK")
    print(f" Workers={WORKERS}  Duration={DURATION}s  BatchSize={BATCH_SIZE}")
    print("=" * 70)

    bench_results = []

    # --- MySQL (single-writer) ---
    if run_mysql:
        try:
            setup_schema(MYSQL_CFG, [DDL_MYSQL], "MySQL (single-writer)")
            truncate_tables(MYSQL_CFG, ["events_inc"])
            r = run_benchmark(
                "MySQL (single-writer)",
                MYSQL_CFG,
                INSERT_INC,
                WORKERS,
                DURATION,
                BATCH_SIZE,
            )
            if r:
                bench_results.append(r)
        except Exception as e:
            print(f"  MySQL skipped: {e}")

    # --- TiDB AUTO_INCREMENT ---
    if run_tidb:
        try:
            setup_schema(TIDB_CFG, [DDL_TIDB_INC, DDL_TIDB_RAND], "TiDB")
            truncate_tables(TIDB_CFG, ["events_inc", "events_rand"])

            r_inc = run_benchmark(
                "TiDB (AUTO_INCREMENT pk)",
                TIDB_CFG,
                INSERT_INC,
                WORKERS,
                DURATION,
                BATCH_SIZE,
            )
            if r_inc:
                bench_results.append(r_inc)

            # Brief pause between runs
            time.sleep(3)

            r_rand = run_benchmark(
                "TiDB (AUTO_RANDOM pk)",
                TIDB_CFG,
                INSERT_RAND,
                WORKERS,
                DURATION,
                BATCH_SIZE,
            )
            if r_rand:
                bench_results.append(r_rand)
        except Exception as e:
            print(f"  TiDB run failed: {e}")

    if bench_results:
        print_results(bench_results, WORKERS, DURATION, BATCH_SIZE)
        save_csv(bench_results, WORKERS, DURATION)
    else:
        print("\nNo results collected.")


if __name__ == "__main__":
    main()
