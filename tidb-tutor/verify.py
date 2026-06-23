#!/usr/bin/env python3
"""verify.py — the tutor's eyes on the trainee's live TiDB Cloud cluster.

Claude Code uses this to CHECK the trainee's work. It never writes the lesson SQL for them.

Usage:
    python verify.py --ping                 # connectivity + version
    python verify.py "SELECT ..."           # run one read query, print rows
    python verify.py -f checks/q.sql        # run SQL from a file

Connection comes from env vars:
    TIDB_HOST TIDB_PORT TIDB_USER TIDB_PASSWORD TIDB_DB TIDB_SSL=true
"""
import os, sys, ssl

try:
    import pymysql
except ImportError:
    sys.exit("pip install pymysql   (see requirements)")


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


def run(sql):
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()
        return rows


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)

    if args[0] == "--ping":
        try:
            rows = run("SELECT VERSION() AS v, NOW() AS t")
            print("OK  version=%s  time=%s" % (rows[0]["v"], rows[0]["t"]))
        except Exception as e:
            sys.exit("PING FAILED: %s" % e)
        return

    if args[0] == "-f":
        sql = open(args[1]).read()
    else:
        sql = args[0]

    try:
        rows = run(sql)
    except Exception as e:
        sys.exit("QUERY ERROR: %s" % e)

    if not rows:
        print("(0 rows)")
        return
    cols = list(rows[0].keys())
    print(" | ".join(cols))
    print("-" * 60)
    for r in rows[:50]:
        print(" | ".join(str(r[c]) for c in cols))
    if len(rows) > 50:
        print("... (%d rows total)" % len(rows))


if __name__ == "__main__":
    main()
