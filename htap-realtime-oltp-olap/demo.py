#!/usr/bin/env python3
"""
TiDB HTAP Demo: Real-Time OLTP + OLAP Without ETL

Demonstrates TiDB's Hybrid Transactional/Analytical Processing architecture:
  - Writes go to TiKV (row store) — OLTP, sub-ms point reads
  - Analytics queries go to TiFlash (columnar store) — OLAP, real-time aggregations
  - Zero ETL pipeline between them

Usage:
    export TIDB_HOST=<host> TIDB_PORT=4000 TIDB_USER=<user> \\
           TIDB_PASSWORD=<pass> TIDB_DB=htap_demo
    python demo.py

For TiDB Cloud, add: export TIDB_SSL=true
"""

import os
import random
import threading
import time
from decimal import Decimal
from datetime import datetime

import pymysql
from rich.console import Console
from rich.table import Table
from rich.live import Live
from rich.panel import Panel
from rich.text import Text
from rich import box

# ─── Configuration ──────────────────────────────────────────────────────────

TIDB_CONFIG = {
    "host":     os.getenv("TIDB_HOST", "127.0.0.1"),
    "port":     int(os.getenv("TIDB_PORT", "4000")),
    "user":     os.getenv("TIDB_USER", "root"),
    "password": os.getenv("TIDB_PASSWORD", ""),
    "database": os.getenv("TIDB_DB", "htap_demo"),
    "charset":  "utf8mb4",
    "ssl":      {"ssl_verify_cert": False} if os.getenv("TIDB_SSL") else None,
    "autocommit": True,
    "connect_timeout": 10,
}

SYMBOLS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOGL", "META", "BRK.B"]
BASE_PRICES = {
    "AAPL": 189.50, "TSLA": 248.00, "NVDA": 875.20,
    "MSFT": 415.80, "AMZN": 182.30, "GOOGL": 171.50,
    "META": 512.40, "BRK.B": 387.90,
}

WRITE_RATE       = 20      # trades per second
OLAP_INTERVAL    = 3       # seconds between OLAP query runs
OLAP_WINDOW_MINS = 10      # rolling window for analytics
DEMO_DURATION    = 120     # total seconds to run (None = run forever)
TRADER_COUNT     = 100     # simulated traders

# ─── State ───────────────────────────────────────────────────────────────────

console = Console()
_lock   = threading.Lock()

stats = {
    "written":      0,
    "oltp_times":   [],
    "olap_times":   [],
    "last_trade_id": None,
    "last_olap":    [],
    "freshness":    None,
    "tiflash_ready": False,
}

# ─── DB helpers ──────────────────────────────────────────────────────────────

def get_conn():
    cfg = {k: v for k, v in TIDB_CONFIG.items() if v is not None}
    return pymysql.connect(**cfg)


def setup_schema():
    """Create database, table, and enable TiFlash replica."""
    conn = get_conn()
    with conn.cursor() as cur:
        # Table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id         BIGINT AUTO_RANDOM PRIMARY KEY,
                symbol     VARCHAR(10)            NOT NULL,
                side       ENUM('buy','sell')     NOT NULL,
                price      DECIMAL(18,6)          NOT NULL,
                quantity   DECIMAL(18,8)          NOT NULL,
                trader_id  INT                    NOT NULL,
                status     ENUM('pending','filled','cancelled')
                           NOT NULL DEFAULT 'filled',
                created_at TIMESTAMP(3)           NOT NULL
                           DEFAULT CURRENT_TIMESTAMP(3),
                INDEX idx_symbol_ts (symbol, created_at),
                INDEX idx_trader    (trader_id, created_at)
            )
        """)

        # TiFlash columnar replica — this is the HTAP magic
        cur.execute("ALTER TABLE trades SET TIFLASH REPLICA 1")

    conn.commit()
    conn.close()
    console.print("[green]✓ Schema ready — TiFlash replica initializing...[/green]")


def wait_for_tiflash():
    """Poll until TiFlash replica is AVAILABLE=1."""
    conn = get_conn()
    console.print("[yellow]Waiting for TiFlash columnar replica to be available...[/yellow]")
    while True:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT AVAILABLE, PROGRESS
                FROM information_schema.tiflash_replica
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trades'
            """)
            row = cur.fetchone()
            if row and row[0] == 1:
                console.print("[green]✓ TiFlash replica AVAILABLE — OLAP queries will use columnar store[/green]\n")
                with _lock:
                    stats["tiflash_ready"] = True
                break
            progress = row[1] if row else 0.0
            console.print(f"  TiFlash progress: {progress:.0%} — retrying in 3s...")
        time.sleep(3)
    conn.close()


# ─── Write thread ─────────────────────────────────────────────────────────────

def ingest_loop():
    """Continuously insert trades into TiKV (OLTP writes)."""
    conn = get_conn()
    sleep_ms = 1.0 / WRITE_RATE
    while True:
        symbol = random.choice(SYMBOLS)
        base   = BASE_PRICES[symbol]
        price  = round(base * random.uniform(0.995, 1.005), 4)
        qty    = round(random.uniform(1.0, 100.0), 4)
        side   = random.choice(["buy", "sell"])
        tid    = random.randint(1, TRADER_COUNT)

        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO trades (symbol, side, price, quantity, trader_id)"
                    " VALUES (%s, %s, %s, %s, %s)",
                    (symbol, side, price, qty, tid)
                )
                last_id = cur.lastrowid
            with _lock:
                stats["written"] += 1
                stats["last_trade_id"] = last_id
        except Exception as e:
            console.print(f"[red]Write error: {e}[/red]")
            try:
                conn.close()
            except Exception:
                pass
            conn = get_conn()

        time.sleep(sleep_ms)


# ─── OLTP query ───────────────────────────────────────────────────────────────

def oltp_query(conn, trade_id):
    """Point lookup by primary key — routed to TiKV."""
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        # Force TiKV (row store) — though TiDB would route here automatically
        # for a PK lookup anyway
        cur.execute("SELECT /*+ READ_FROM_STORAGE(tikv[trades]) */"
                    " id, symbol, side, price, quantity, created_at"
                    " FROM trades WHERE id = %s", (trade_id,))
        row = cur.fetchone()
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return row, elapsed_ms


# ─── OLAP query ───────────────────────────────────────────────────────────────

def olap_query(conn):
    """
    Rolling window analytics — routed to TiFlash (columnar store).
    Same data as the OLTP writes, zero ETL, real-time.
    """
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        # Force TiFlash — in production TiDB routes large scans here automatically
        cur.execute(f"""
            SELECT /*+ READ_FROM_STORAGE(tiflash[trades]) */
                symbol,
                COUNT(*)                        AS trade_count,
                SUM(price * quantity)           AS volume,
                AVG(price)                      AS avg_price,
                MIN(price)                      AS low,
                MAX(price)                      AS high
            FROM trades
            WHERE created_at >= NOW(3) - INTERVAL {OLAP_WINDOW_MINS} MINUTE
            GROUP BY symbol
            ORDER BY volume DESC
        """)
        rows = cur.fetchall()
    elapsed_ms = (time.perf_counter() - t0) * 1000
    return rows, elapsed_ms


def freshness_query(conn):
    """Compare record count: TiKV total vs TiFlash visible."""
    with conn.cursor() as cur:
        cur.execute("SELECT /*+ READ_FROM_STORAGE(tikv[trades]) */ COUNT(*) FROM trades")
        tikv_count = cur.fetchone()[0]
        cur.execute("SELECT /*+ READ_FROM_STORAGE(tiflash[trades]) */ COUNT(*) FROM trades")
        tiflash_count = cur.fetchone()[0]
    return tikv_count, tiflash_count


# ─── Display ─────────────────────────────────────────────────────────────────

def build_display():
    with _lock:
        written       = stats["written"]
        oltp_times    = stats["oltp_times"][-50:]
        olap_times    = stats["olap_times"][-20:]
        last_trade    = stats["last_trade_id"]
        olap_rows     = stats["last_olap"]
        freshness     = stats["freshness"]
        ready         = stats["tiflash_ready"]

    # Header
    header = Text()
    header.append("TiDB HTAP Demo", style="bold cyan")
    header.append("  —  ", style="dim")
    header.append("Real-Time OLTP + OLAP | Zero ETL", style="bold white")

    # Metrics bar
    oltp_p99 = sorted(oltp_times)[int(len(oltp_times)*0.99)] if len(oltp_times) > 1 else 0
    olap_p99 = sorted(olap_times)[int(len(olap_times)*0.99)] if len(olap_times) > 1 else 0
    oltp_avg = sum(oltp_times)/len(oltp_times) if oltp_times else 0
    olap_avg = sum(olap_times)/len(olap_times) if olap_times else 0

    metrics = (
        f"[bold]Writes:[/bold] {written:,}  "
        f"[bold]Write rate:[/bold] {WRITE_RATE}/s  "
        f"[bold]OLTP avg:[/bold] [green]{oltp_avg:.1f}ms[/green]  "
        f"[bold]OLTP p99:[/bold] [green]{oltp_p99:.1f}ms[/green]  "
        f"[bold]OLAP avg:[/bold] [yellow]{olap_avg:.1f}ms[/yellow]  "
        f"[bold]OLAP p99:[/bold] [yellow]{olap_p99:.1f}ms[/yellow]  "
        f"[bold]ETL pipelines:[/bold] [bold green]0[/bold green]"
    )

    # TiFlash status
    tiflash_status = (
        "[bold green]✓ TiFlash AVAILABLE[/bold green]" if ready
        else "[yellow]⏳ TiFlash initializing...[/yellow]"
    )

    # Freshness panel
    if freshness:
        tikv_c, tf_c = freshness
        lag = tikv_c - tf_c
        freshness_str = (
            f"TiKV (source): [bold]{tikv_c:,}[/bold]  "
            f"TiFlash (OLAP): [bold]{tf_c:,}[/bold]  "
            f"Lag: [bold green]{lag} records[/bold green] (~{lag/WRITE_RATE:.1f}s)"
        )
    else:
        freshness_str = "—"

    # OLAP results table
    tbl = Table(
        title=f"OLAP: Rolling {OLAP_WINDOW_MINS}-min analytics [dim](TiFlash columnar store)[/dim]",
        box=box.SIMPLE_HEAVY,
        header_style="bold cyan",
        show_lines=False,
    )
    tbl.add_column("Symbol",      style="bold white", width=8)
    tbl.add_column("Trades",      justify="right",   width=8)
    tbl.add_column("Volume ($)",  justify="right",   width=16)
    tbl.add_column("Avg Price",   justify="right",   width=10)
    tbl.add_column("Low",         justify="right",   width=10)
    tbl.add_column("High",        justify="right",   width=10)

    for row in (olap_rows or []):
        sym, cnt, vol, avg, low, high = row
        tbl.add_row(
            sym,
            f"{cnt:,}",
            f"${float(vol):,.2f}",
            f"${float(avg):.4f}",
            f"${float(low):.4f}",
            f"${float(high):.4f}",
        )

    from rich.columns import Columns
    from rich.padding import Padding

    layout = Panel(
        Padding("\n".join([
            metrics,
            f"TiFlash: {tiflash_status}  |  Freshness: {freshness_str}",
        ]), pad=(0, 1)),
        title=header,
        border_style="cyan",
    )

    return layout, tbl


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    console.print(Panel(
        "[bold cyan]TiDB HTAP Demo[/bold cyan]\n"
        "Concurrent OLTP (TiKV row store) + OLAP (TiFlash columnar) from one cluster\n"
        "[dim]Based on recurring customer ask: Intuit, Peregrine, Candescent, Croatian Telecom[/dim]",
        border_style="cyan",
    ))

    # Schema setup
    setup_schema()

    # Wait for TiFlash in background (don't block demo start)
    tiflash_thread = threading.Thread(target=wait_for_tiflash, daemon=True)
    tiflash_thread.start()

    # Start ingest thread
    ingest_thread = threading.Thread(target=ingest_loop, daemon=True)
    ingest_thread.start()
    console.print(f"[green]✓ Ingest thread started — writing {WRITE_RATE} trades/sec to TiKV[/green]")

    time.sleep(1)  # Let a few records accumulate

    # Main query loop
    oltp_conn  = get_conn()
    olap_conn  = get_conn()
    start_time = time.time()
    last_olap  = 0

    console.print("\n[bold]Starting OLTP + OLAP query loops. Press Ctrl+C to stop.\n[/bold]")

    try:
        while True:
            now = time.time()
            if DEMO_DURATION and (now - start_time) > DEMO_DURATION:
                break

            # ── OLTP: point lookup (TiKV) ──────────────────────────────────
            with _lock:
                last_id = stats["last_trade_id"]

            if last_id:
                row, ms = oltp_query(oltp_conn, last_id)
                with _lock:
                    stats["oltp_times"].append(ms)
                if row:
                    console.print(
                        f"[dim][OLTP][/dim]  id={row[0]:<8}  "
                        f"{row[1]:<6}  {row[2].upper():<5}  "
                        f"${float(row[3]):>9.4f}  "
                        f"qty={float(row[4]):>7.2f}  "
                        f"[green]{ms:.1f}ms[/green]  "
                        f"[dim](TiKV)[/dim]"
                    )

            # ── OLAP: rolling analytics (TiFlash) ─────────────────────────
            if (now - last_olap) >= OLAP_INTERVAL:
                with _lock:
                    ready = stats["tiflash_ready"]

                if ready:
                    rows, ms = olap_query(olap_conn)
                    freshn    = freshness_query(olap_conn)
                    with _lock:
                        stats["olap_times"].append(ms)
                        stats["last_olap"]  = rows
                        stats["freshness"]  = freshn

                    console.print()
                    tbl = Table(
                        title=f"[bold yellow][OLAP][/bold yellow] "
                              f"Rolling {OLAP_WINDOW_MINS}-min window  "
                              f"[dim](TiFlash, {ms:.0f}ms)[/dim]",
                        box=box.SIMPLE, header_style="bold yellow",
                    )
                    tbl.add_column("Symbol",    style="bold", width=8)
                    tbl.add_column("Trades",    justify="right")
                    tbl.add_column("Volume",    justify="right")
                    tbl.add_column("Avg Price", justify="right")
                    tbl.add_column("Low",       justify="right")
                    tbl.add_column("High",      justify="right")
                    for r in rows:
                        sym, cnt, vol, avg, low, high = r
                        tbl.add_row(
                            sym,
                            f"{cnt:,}",
                            f"${float(vol):,.0f}",
                            f"${float(avg):.4f}",
                            f"${float(low):.4f}",
                            f"${float(high):.4f}",
                        )
                    console.print(tbl)

                    tikv_c, tf_c = freshn
                    lag = tikv_c - tf_c
                    console.print(
                        f"[dim][FRESHNESS][/dim]  TiKV total: [bold]{tikv_c:,}[/bold]  "
                        f"TiFlash visible: [bold]{tf_c:,}[/bold]  "
                        f"Lag: [bold green]{lag} records[/bold green] "
                        f"(~{lag/max(WRITE_RATE,1):.1f}s)"
                    )
                    console.print()

                else:
                    console.print("[dim][OLAP] Waiting for TiFlash replica...[/dim]")

                last_olap = now

            time.sleep(1)

    except KeyboardInterrupt:
        pass
    finally:
        oltp_conn.close()
        olap_conn.close()

    # Summary
    with _lock:
        written    = stats["written"]
        oltp_times = stats["oltp_times"]
        olap_times = stats["olap_times"]

    def p99(lst): return sorted(lst)[int(len(lst)*0.99)] if len(lst) > 1 else 0
    def avg(lst): return sum(lst)/len(lst) if lst else 0

    elapsed = time.time() - start_time
    console.print(Panel(
        f"[bold]Demo Summary[/bold]\n"
        f"Duration:         {elapsed:.0f}s\n"
        f"Records written:  {written:,}\n"
        f"OLTP avg latency: {avg(oltp_times):.1f}ms  p99: {p99(oltp_times):.1f}ms  (TiKV)\n"
        f"OLAP avg latency: {avg(olap_times):.1f}ms  p99: {p99(olap_times):.1f}ms  (TiFlash)\n"
        f"ETL pipelines:    [bold green]0[/bold green]\n",
        border_style="green",
        title="[bold green]Done[/bold green]",
    ))


if __name__ == "__main__":
    main()
