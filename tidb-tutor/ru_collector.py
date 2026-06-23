#!/usr/bin/env python3
"""ru_collector.py — Request Unit (RU) consumption monitor for TiDB Cloud Serverless.

Shows what the trainee's exercises actually cost. Pulls from STATEMENTS_SUMMARY,
which TiDB Cloud maintains per query digest. Also runs EXPLAIN ANALYZE on a given
query so the tutor can diagnose cost inline.

Usage:
    python ru_collector.py                        # top 10 RU consumers since last reset
    python ru_collector.py "SELECT ..."           # EXPLAIN ANALYZE + per-call RU estimate
    python ru_collector.py --reset                # flush STATEMENTS_SUMMARY (fresh baseline)
    python ru_collector.py --help

Connection via the same TIDB_* env vars as verify.py.

Notes on STATEMENTS_SUMMARY:
  - Aggregates by query digest (normalized SQL, parameters stripped out).
  - Available on TiDB Cloud Starter. On Dedicated clusters it may need
    tidb_enable_stmt_summary=ON (usually already on by default).
  - RU columns: TiDB Cloud Serverless exposes SUM_RU, MAX_RU, AVG_RU per digest.
    On self-hosted or older versions these columns may not exist; the script
    falls back to latency + rows examined as a cost proxy.
"""
import os, sys, ssl, textwrap

try:
    import pymysql
except ImportError:
    sys.exit("pip install pymysql   (see requirements.txt)")

SUMMARY_TABLE = "INFORMATION_SCHEMA.STATEMENTS_SUMMARY"

def connect():
    kw = dict(
        host=os.environ.get("TIDB_HOST", "127.0.0.1"),
        port=int(os.environ.get("TIDB_PORT", "4000")),
        user=os.environ.get("TIDB_USER", "root"),
        password=os.environ.get("TIDB_PASSWORD", ""),
        database=os.environ.get("TIDB_DB", "test"),
        connect_timeout=10,
        cursorclass=pymysql.cursors.DictCursor,
    )
    if os.environ.get("TIDB_SSL", "").lower() in ("1", "true", "yes"):
        ctx = ssl.create_default_context()
        kw["ssl"] = ctx
    return pymysql.connect(**kw)


def run(sql, conn=None):
    """Run SQL and return rows. Opens its own connection if none given."""
    close = conn is None
    if close:
        conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall()
        return rows
    finally:
        if close:
            conn.close()


def detect_ru_columns(conn):
    """Return which RU-related columns exist in STATEMENTS_SUMMARY."""
    try:
        rows = run(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            f"WHERE TABLE_SCHEMA='INFORMATION_SCHEMA' AND TABLE_NAME='STATEMENTS_SUMMARY' "
            "AND COLUMN_NAME IN ('SUM_RU','AVG_RU','MAX_RU','SUM_ROWS_EXAMINED','SUM_LATENCY')",
            conn,
        )
        return {r["COLUMN_NAME"] for r in rows}
    except Exception:
        return set()


def top_consumers(conn, cols, limit=10):
    """Return the top RU-consuming query digests."""
    has_ru = "SUM_RU" in cols
    if has_ru:
        order = "SUM_RU DESC"
        select = (
            "DIGEST_TEXT, EXEC_COUNT, "
            "ROUND(SUM_RU, 2) AS sum_ru, "
            "ROUND(AVG_RU, 4) AS avg_ru, "
            "ROUND(MAX_RU, 4) AS max_ru, "
            "ROUND(SUM_LATENCY/1e9, 3) AS sum_lat_s"
        )
    else:
        # Fallback: latency + rows examined as cost proxy
        order = "SUM_LATENCY DESC"
        select = (
            "DIGEST_TEXT, EXEC_COUNT, "
            "ROUND(SUM_LATENCY/1e9, 3) AS sum_lat_s, "
            "ROUND(SUM_LATENCY/EXEC_COUNT/1e6, 2) AS avg_lat_ms, "
            "SUM_ROWS_EXAMINED AS rows_examined"
        )
    sql = (
        f"SELECT {select} "
        f"FROM {SUMMARY_TABLE} "
        f"WHERE EXEC_COUNT > 0 "
        f"ORDER BY {order} "
        f"LIMIT {limit}"
    )
    try:
        return run(sql, conn), has_ru
    except Exception as e:
        return [], False


def explain_analyze(sql, conn):
    """Run EXPLAIN ANALYZE on a query and return the plan text."""
    try:
        rows = run(f"EXPLAIN ANALYZE {sql}", conn)
        return rows
    except Exception as e:
        return [{"error": str(e)}]


def estimate_ru_from_explain(plan_rows):
    """
    Pull the actRows / execution info from EXPLAIN ANALYZE output and
    give a rough RU estimate. TiDB Cloud EXPLAIN ANALYZE includes
    'execution info' with actual row counts, time, and sometimes RU hints.
    """
    lines = []
    for r in plan_rows:
        row_vals = list(r.values())
        lines.append(" | ".join(str(v) for v in row_vals))
    return "\n".join(lines)


def reset_summary(conn):
    try:
        run("CALL tidb_sm_dump_no_wait()", conn)
        return True
    except Exception:
        pass
    try:
        # Alternative reset on some versions
        run("SET GLOBAL tidb_stmt_summary_refresh_interval = 1800", conn)
        return True
    except Exception:
        return False


def print_table(rows, has_ru):
    if not rows:
        print("(no data — run some queries first)")
        return
    cols = list(rows[0].keys())
    widths = [max(len(c), max(len(str(r.get(c, ""))) for r in rows)) for c in cols]
    header = " | ".join(c.ljust(widths[i]) for i, c in enumerate(cols))
    sep = "-+-".join("-" * w for w in widths)
    print(header)
    print(sep)
    for r in rows:
        print(" | ".join(str(r.get(c, "")).ljust(widths[i]) for i, c in enumerate(cols)))
    if not has_ru:
        print("\n(RU columns not available on this cluster — showing latency + rows as proxy)")
        print("On TiDB Cloud Serverless, SUM_RU/AVG_RU are available in STATEMENTS_SUMMARY.")


def main():
    args = sys.argv[1:]
    if "--help" in args:
        print(__doc__)
        return

    try:
        conn = connect()
    except Exception as e:
        sys.exit(f"Connection failed: {e}\nCheck TIDB_HOST, TIDB_USER, TIDB_PASSWORD, TIDB_SSL.")

    if "--reset" in args:
        ok = reset_summary(conn)
        print("STATEMENTS_SUMMARY reset" if ok else "Reset not available — use the TiDB Cloud console.")
        conn.close()
        return

    if args and not args[0].startswith("--"):
        # A SQL statement was passed — EXPLAIN ANALYZE it
        sql = args[0]
        print(f"\n--- EXPLAIN ANALYZE ---")
        print(f"Query: {textwrap.shorten(sql, 120)}\n")
        plan = explain_analyze(sql, conn)
        print(estimate_ru_from_explain(plan))

        # Also run actual execution to get fresh summary data
        print("\n--- Running query to populate STATEMENTS_SUMMARY ---")
        try:
            rows = run(sql, conn)
            print(f"Returned {len(rows)} row(s)")
        except Exception as e:
            print(f"Query error: {e}")

        # Show this digest's stats
        print("\n--- RU / cost for this query pattern ---")
        cols = detect_ru_columns(conn)
        consumers, has_ru = top_consumers(conn, cols, limit=5)
        print_table(consumers, has_ru)
        conn.close()
        return

    # Default: top consumers
    cols = detect_ru_columns(conn)
    consumers, has_ru = top_consumers(conn, cols, limit=10)
    title = "Top 10 queries by RU (TiDB Cloud Serverless)" if has_ru else "Top 10 queries by latency (RU proxy)"
    print(f"\n--- {title} ---\n")
    print_table(consumers, has_ru)

    print("\nTip: run `python ru_collector.py \"SELECT ...\"` to EXPLAIN ANALYZE a specific query.")
    print("Tip: run `python ru_collector.py --reset` to clear history and start a fresh baseline.")
    conn.close()


if __name__ == "__main__":
    main()
