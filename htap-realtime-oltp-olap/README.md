# TiDB HTAP: Real-Time OLTP + OLAP Without ETL

Demonstrates TiDB's Hybrid Transactional/Analytical Processing (HTAP) architecture — writing transactions into TiKV (row store) while simultaneously querying TiFlash (columnar store) for real-time analytics, with **zero ETL lag**.

## Why This Demo Exists

Multiple prospects asked the same question this week:

> *"We use Aurora for OLTP and Redshift for analytics. The ETL pipeline introduces 15–30 minutes of lag and requires a separate cluster. Can TiDB replace both?"*

Intuit's SE team (Henry Venturelli) made an explicit request: **"end-to-end OLTP-to-OLAP demo"** — their Anti-Fraud ODS runs 65,000 QPS with a hybrid pre-aggregation model (<90 days runtime, >180 days pre-aggregated). Croatian Telecom, Peregrine, Candescent, and Writer all hit the same architectural wall.

This demo answers that question with running code.

## What It Shows

| Layer | Technology | Role |
|-------|-----------|------|
| OLTP writes | TiKV (row store, Raft replicated) | Sub-ms point reads/writes |
| OLAP queries | TiFlash (columnar, async replica) | Real-time aggregations |
| One cluster | TiDB compute layer | Routes queries automatically |
| Zero lag | No ETL, no Kafka, no cron jobs | Fresh data instantly queryable |

## Architecture

```
 Application
     │
     ▼
  TiDB (SQL layer)
  ┌──────────────────────────────────────┐
  │  OLTP Query → TiKV (row store)       │
  │  OLAP Query → TiFlash (col store)    │
  │  Sync: async replication, ~seconds   │
  └──────────────────────────────────────┘
```

Vs. the traditional stack:

```
 Application → Aurora (OLTP)
                   │
              ETL/DMS job (15–30 min lag)
                   │
              Redshift / BigQuery (OLAP)
```

## Prerequisites

- Python 3.9+
- TiDB Cloud account (free tier works) **or** local TiDB via `tiup playground`
- MySQL-compatible connection string

```bash
pip install -r requirements.txt
```

## Quick Start

### Option A: TiDB Cloud (Recommended for demos)

1. Create a free [TiDB Cloud Serverless](https://tidbcloud.com) cluster
2. Copy your connection string
3. Run:

```bash
export TIDB_HOST=<your-host>
export TIDB_PORT=4000
export TIDB_USER=<your-user>
export TIDB_PASSWORD=<your-password>
export TIDB_DB=htap_demo

python demo.py
```

### Option B: Local TiDB (tiup)

```bash
tiup playground --tiflash 1
export TIDB_HOST=127.0.0.1
export TIDB_PORT=4000
export TIDB_USER=root
export TIDB_PASSWORD=''
export TIDB_DB=htap_demo

python demo.py
```

## What the Demo Does

1. **Setup** — Creates a `trades` table and enables a TiFlash columnar replica
2. **Ingest** — Spawns a background thread writing 20 trades/second (simulating a trading platform)
3. **OLTP loop** — Every second, does a point-lookup by trade ID (hits TiKV, <5ms)
4. **OLAP loop** — Every 3 seconds, runs a rolling analytics query (hits TiFlash, real-time)
5. **Freshness check** — Counts records visible to OLAP vs total written — should be within seconds

## Sample Output

```
[SETUP] Created trades table
[SETUP] TiFlash replica enabled — columnar store syncing...

[INGEST] Writing 20 trades/sec to TiKV...

[OLTP]  trade_id=1042  AAPL  BUY  150.2500  qty=23.5  latency=1.8ms  (TiKV)
[OLTP]  trade_id=1087  TSLA  SELL 248.1100  qty=10.0  latency=2.1ms  (TiKV)

[OLAP]  symbol=AAPL  trades=312  volume=$4,821,340  avg_price=$152.41  (TiFlash)
[OLAP]  symbol=TSLA  trades=289  volume=$7,193,219  avg_price=$248.90  (TiFlash)
[OLAP]  symbol=NVDA  trades=401  volume=$183,257,810  avg_price=$456.75  (TiFlash)

[FRESHNESS] Total written: 1,840  |  Visible in TiFlash: 1,838  |  Lag: ~2 records (~0.1s)

--- 60s Summary ---
OLTP p99 latency:  3.2ms
OLAP p99 latency:  48ms
Writes/sec:        20.0
Records ingested:  1,200
ETL pipelines:     0
```

## Key Talking Points

**"How is this different from Aurora + Redshift?"**
- Aurora cannot serve OLAP queries without a read replica or ETL to Redshift
- TiFlash is an async columnar replica within the same cluster — no separate system, no ETL job, no lag
- You pay for one cluster, not two

**"How fresh is the OLAP data?"**
- TiFlash replication lag is typically < 1 second under normal write load
- For Intuit's use case (pre-aggregation hybrid), queries < 90 days old hit TiFlash directly

**"Does this work at Intuit scale (65,000 QPS)?"**
- TiDB scales TiKV and TiFlash nodes independently
- More TiFlash nodes → higher OLAP throughput without touching OLTP
- Intuit runs 42 TiDB + 15 TiKV nodes in production

**"What about CockroachDB / YugabyteDB?"**
- Neither has a native columnar store
- They can do distributed OLTP but require external systems (BigQuery, Redshift) for OLAP
- TiDB is the only MySQL-compatible distributed DB with built-in HTAP

## Customization

Edit `demo.py` to adjust:
- `WRITE_RATE` — trades per second
- `OLAP_INTERVAL` — how often to run analytics queries
- `SYMBOLS` — stock tickers to simulate
- `OLAP_WINDOW_MINUTES` — rolling window for analytics

## Related Demos

- `tidb-fraud-detection/` — Uses HTAP for real-time fraud scoring
- `finance-fraud-detection/` — BM25 + vector + graph fraud detection
- `tidb-pov-kit/` — Self-service POC framework
