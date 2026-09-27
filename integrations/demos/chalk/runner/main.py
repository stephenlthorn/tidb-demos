import asyncio
import os
import signal
import time
from datetime import datetime, timezone
from typing import Optional

from lab_runner import Emitter, on_control, summarize, tidb_connect_from_env

from src.chalk_io import build_chalk_client, query_user_features
from src.freshness import freshness_lag_ms
from src.tidb_io import insert_transaction, run_baseline_query, seed_users
from src.workload import next_transaction

SAMPLED_USER_ID = 1
BURST_USER_ID = 2
OTHER_USER_IDS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
ALL_SEED_USER_IDS = [SAMPLED_USER_ID, BURST_USER_ID, *OTHER_USER_IDS]
MERCHANTS = ["coffee-shop", "grocery", "gas-station", "online-retail"]

TICK_SECONDS = 1.0
VELOCITY_BURST_TRANSACTIONS = 60
VELOCITY_BURST_INTERVAL_SECONDS = 1.5
FRAUD_FLIP_TIMEOUT_MS = 30_000
FRAUD_FLIP_POLL_SECONDS = 0.5
BURST_WRITES_DURATION_SECONDS = 20
BURST_WRITES_INTERVAL_SECONDS = 1.0

emitter = Emitter()

chalk_client = None
tidb_conn = None
main_loop: "Optional[asyncio.AbstractEventLoop]" = None

fresh_mode = False
tick_count = 0

write_flow_count = 0
resolver_flow_count = 0
baseline_sql_flow_count = 0
baseline_query_flow_count = 0

chalk_samples: list = []
baseline_samples: list = []

velocity_burst_task: "Optional[asyncio.Task]" = None
burst_writes_task: "Optional[asyncio.Task]" = None


def drain(samples: list) -> list:
    values = list(samples)
    samples.clear()
    return values


def record_write() -> None:
    global write_flow_count
    write_flow_count += 1


def record_chalk_query() -> None:
    global resolver_flow_count
    resolver_flow_count += 1


def record_baseline_query() -> None:
    global baseline_sql_flow_count, baseline_query_flow_count
    baseline_sql_flow_count += 3
    baseline_query_flow_count += 1


async def steady_state_tick() -> None:
    global tick_count, write_flow_count, resolver_flow_count
    global baseline_sql_flow_count, baseline_query_flow_count

    tick_count += 1

    row = next_transaction(
        user_id=SAMPLED_USER_ID,
        tick=tick_count,
        merchant_pool=MERCHANTS,
        amount_cents=1500,
        burst=False,
    )
    write_start_ms = emitter.elapsed_ms()
    insert_transaction(tidb_conn, row)
    record_write()

    now = datetime.now(timezone.utc)

    chalk_start = time.perf_counter()
    chalk_result = query_user_features(chalk_client, SAMPLED_USER_ID, fresh=fresh_mode)
    chalk_samples.append((time.perf_counter() - chalk_start) * 1000.0)
    record_chalk_query()

    baseline_start = time.perf_counter()
    baseline_count = run_baseline_query(tidb_conn, "txn-count-1h", SAMPLED_USER_ID, now)
    baseline_sum = run_baseline_query(tidb_conn, "amount-sum-24h", SAMPLED_USER_ID, now)
    baseline_merchants = run_baseline_query(tidb_conn, "distinct-merchants-24h", SAMPLED_USER_ID, now)
    baseline_samples.append((time.perf_counter() - baseline_start) * 1000.0)
    record_baseline_query()

    parity = (
        chalk_result.txn_count_1h == int(baseline_count)
        and abs(chalk_result.amount_sum_24h - baseline_sum) < 1e-6
        and chalk_result.distinct_merchants_24h == int(baseline_merchants)
    )
    emitter.check(
        "feature-parity",
        "pass" if parity else "fail",
        observed=(
            f"chalk txn_count_1h={chalk_result.txn_count_1h} "
            f"amount_sum_24h={chalk_result.amount_sum_24h} "
            f"distinct_merchants_24h={chalk_result.distinct_merchants_24h} vs "
            f"baseline txn_count_1h={int(baseline_count)} "
            f"amount_sum_24h={baseline_sum} "
            f"distinct_merchants_24h={int(baseline_merchants)}"
        ),
    )

    lag_ms = freshness_lag_ms(write_ts_ms=int(write_start_ms), observed_ts_ms=int(emitter.elapsed_ms()))
    emitter.metric("freshness-lag-ms", lag_ms)

    emitter.metric("tidb-write-rate", write_flow_count / TICK_SECONDS)
    emitter.flow("writes", write_flow_count)
    write_flow_count = 0

    emitter.flow("resolver-sql", resolver_flow_count)
    emitter.flow("online-queries", resolver_flow_count)
    resolver_flow_count = 0

    emitter.flow("baseline-sql", baseline_sql_flow_count)
    emitter.flow("baseline-queries", baseline_query_flow_count)
    baseline_sql_flow_count = 0
    baseline_query_flow_count = 0

    chalk_summary = summarize(drain(chalk_samples))
    if chalk_summary is not None:
        emitter.metric("chalk-query-p50", chalk_summary.p50)
        emitter.metric("chalk-query-p99", chalk_summary.p99)

    baseline_summary = summarize(drain(baseline_samples))
    if baseline_summary is not None:
        emitter.metric("baseline-sql-p99", baseline_summary.p99)

    emitter.metric("cache-hit-rate", 100.0 if chalk_result.cache_hit else 0.0)


async def run_velocity_burst() -> None:
    global velocity_burst_task
    if velocity_burst_task is not None and not velocity_burst_task.done():
        emitter.log("warn", "velocity-burst already running, ignoring control")
        return
    velocity_burst_task = asyncio.current_task()

    emitter.phase("velocity-burst")
    emitter.node("generator", "busy", "velocity burst active")
    burst_start_ms = emitter.elapsed_ms()
    emitter.check("fraud-flip", "pending")

    for i in range(VELOCITY_BURST_TRANSACTIONS):
        row = next_transaction(
            user_id=BURST_USER_ID,
            tick=i,
            merchant_pool=MERCHANTS,
            amount_cents=2500,
            burst=True,
        )
        insert_transaction(tidb_conn, row)
        record_write()
        await asyncio.sleep(VELOCITY_BURST_INTERVAL_SECONDS)

    deadline_ms = emitter.elapsed_ms() + FRAUD_FLIP_TIMEOUT_MS
    flipped = False
    while emitter.elapsed_ms() < deadline_ms:
        result = query_user_features(chalk_client, BURST_USER_ID, fresh=True)
        record_chalk_query()
        if result.velocity_flag:
            flip_seconds = (emitter.elapsed_ms() - burst_start_ms) / 1000.0
            emitter.metric("fraud-flag-flip-s", flip_seconds)
            emitter.check("fraud-flip", "pass", observed=f"flipped after {flip_seconds:.1f}s")
            flipped = True
            break
        await asyncio.sleep(FRAUD_FLIP_POLL_SECONDS)

    if not flipped:
        emitter.check("fraud-flip", "fail", observed="timed out after 30s")

    emitter.node("generator", "healthy", "velocity burst complete")


async def run_burst_writes() -> None:
    global burst_writes_task
    if burst_writes_task is not None and not burst_writes_task.done():
        emitter.log("warn", "burst-writes already running, ignoring control")
        return
    burst_writes_task = asyncio.current_task()

    emitter.log("info", "burst-writes started", "generator")
    deadline_ms = emitter.elapsed_ms() + BURST_WRITES_DURATION_SECONDS * 1000.0
    tick = 0
    while emitter.elapsed_ms() < deadline_ms:
        for user_id in OTHER_USER_IDS:
            row = next_transaction(
                user_id=user_id,
                tick=tick,
                merchant_pool=MERCHANTS,
                amount_cents=800,
                burst=False,
            )
            insert_transaction(tidb_conn, row)
            record_write()
            tick += 1
        await asyncio.sleep(BURST_WRITES_INTERVAL_SECONDS)
    emitter.log("info", "burst-writes finished", "generator")


def schedule_task(coro) -> None:
    if main_loop is None:
        emitter.log("warn", "control received before the event loop was ready")
        return
    future = asyncio.run_coroutine_threadsafe(coro, main_loop)

    def report(done_future: "asyncio.Future") -> None:
        error = done_future.exception()
        if error is not None:
            emitter.log("error", f"control task failed: {error}")

    future.add_done_callback(report)


def handle_control(control_id: str) -> None:
    global fresh_mode
    if control_id == "tighten-staleness":
        fresh_mode = not fresh_mode
        emitter.log("info", "staleness mode toggled", "chalk")
    elif control_id == "velocity-burst":
        schedule_task(run_velocity_burst())
    elif control_id == "burst-writes":
        schedule_task(run_burst_writes())
    else:
        emitter.log("warn", f"unknown control id: {control_id}")


async def tick_loop(stop: "asyncio.Event") -> None:
    while not stop.is_set():
        tick_start = time.perf_counter()
        await steady_state_tick()
        elapsed = time.perf_counter() - tick_start
        remaining = max(0.0, TICK_SECONDS - elapsed)
        try:
            await asyncio.wait_for(stop.wait(), timeout=remaining)
        except asyncio.TimeoutError:
            pass


async def main() -> None:
    global chalk_client, tidb_conn, main_loop

    main_loop = asyncio.get_running_loop()

    for node_id in ("generator", "tidb", "chalk", "baseline", "client"):
        emitter.node(node_id, "starting")

    tidb_conn = tidb_connect_from_env(os.environ)
    emitter.node("tidb", "healthy")

    seed_users(os.environ, ALL_SEED_USER_IDS)
    emitter.phase("seed")
    emitter.log("info", "seeded users and schema", "tidb")

    chalk_client = build_chalk_client(os.environ)
    emitter.node("chalk", "healthy")
    emitter.node("baseline", "healthy")
    emitter.node("client", "healthy")
    emitter.node("generator", "healthy")

    on_control(handle_control)

    emitter.phase("steady-state")

    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        main_loop.add_signal_handler(sig, stop.set)

    await tick_loop(stop)

    emitter.phase("wrapup")
    for node_id in ("generator", "tidb", "chalk", "baseline", "client"):
        emitter.node(node_id, "done")
    emitter.log("info", "runner exiting cleanly", "tidb")


if __name__ == "__main__":
    asyncio.run(main())
