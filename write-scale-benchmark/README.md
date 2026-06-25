# Write-Scale Benchmark: Single-Writer MySQL vs TiDB Distributed SQL

This demo benchmarks concurrent write throughput against a single-node MySQL instance (simulating Aurora's single-writer architecture) and a TiDB Cloud cluster, using an identical schema and workload. It demonstrates how write-heavy workloads saturate a single writer and how TiDB scales horizontally across multiple TiKV nodes.

## What It Shows

- **Single-writer bottleneck**: As concurrent writers increase, throughput on a single-node MySQL peaks then degrades due to InnoDB lock contention and connection saturation.
- **Horizontal write scaling**: TiDB distributes writes across TiKV nodes; throughput increases with concurrency up to cluster limits.
- **Auto-increment vs auto_random**: Sequential primary keys cause write hotspots in distributed systems. The benchmark compares `AUTO_INCREMENT` (hotspot risk) and `AUTO_RANDOM` (distributed) primary key strategies on TiDB.
- **Zero code change**: Both targets use the same PyMySQL driver and identical SQL — demonstrating MySQL protocol compatibility.

## Architecture

```
benchmark.py
  └── WorkerPool (N concurrent threads)
        ├── MySQL target  →  single-node MySQL (local Docker or RDS-style endpoint)
        └── TiDB target   →  TiDB Cloud Serverless or Dedicated
              ├── Table A: AUTO_INCREMENT pk  (hotspot demo)
              └── Table B: AUTO_RANDOM pk     (distributed writes)
```

Each worker runs a tight INSERT loop for a configurable duration, recording per-second TPS and P99 latency. Results are printed as a summary table and optionally saved as CSV for charting.

## Prerequisites

```bash
pip install -r requirements.txt
```

Requires Python 3.9+. For the MySQL target, either run a local MySQL 8 container:

```bash
docker run -d --name mysql-single \
  -e MYSQL_ROOT_PASSWORD=demo \
  -e MYSQL_DATABASE=benchmark \
  -p 3306:3306 mysql:8.0
```

or point `MYSQL_HOST` at any single-node MySQL/Aurora endpoint.

## Configuration

All connection details are passed via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MYSQL_HOST` | `127.0.0.1` | Single-writer MySQL host |
| `MYSQL_PORT` | `3306` | MySQL port |
| `MYSQL_USER` | `root` | MySQL user |
| `MYSQL_PASSWORD` | `demo` | MySQL password |
| `MYSQL_DB` | `benchmark` | MySQL database |
| `TIDB_HOST` | *(required)* | TiDB Cloud host |
| `TIDB_PORT` | `4000` | TiDB port |
| `TIDB_USER` | *(required)* | TiDB user |
| `TIDB_PASSWORD` | *(required)* | TiDB password |
| `TIDB_DB` | `benchmark` | TiDB database |
| `TIDB_SSL` | `true` | Use TLS (required for TiDB Cloud) |
| `WORKERS` | `20` | Number of concurrent writer threads |
| `DURATION` | `60` | Benchmark duration in seconds |
| `BATCH_SIZE` | `50` | Rows per INSERT statement |

## Running

```bash
# Set TiDB Cloud credentials
export TIDB_HOST="gateway01.us-west-2.prod.aws.tidbcloud.com"
export TIDB_USER="your_user"
export TIDB_PASSWORD="your_password"

# Run the benchmark
python benchmark.py
```

To run only against TiDB (skip MySQL):

```bash
python benchmark.py --tidb-only
```

To run only against MySQL:

```bash
python benchmark.py --mysql-only
```

## Sample Output

```
============================================================
 WRITE-SCALE BENCHMARK RESULTS
============================================================
Workers: 20  |  Duration: 60s  |  Batch size: 50 rows

Target                  Total Rows    Avg TPS    P99 Latency
----------------------  ----------  ---------  -------------
MySQL (single-writer)      312,450      5,207         183 ms
TiDB (AUTO_INCREMENT)      489,200      8,153          97 ms
TiDB (AUTO_RANDOM)         721,850     12,030          61 ms
============================================================
Results saved to: results_20workers_60s.csv
```

## Key Takeaways

1. **TiDB AUTO_RANDOM outperforms AUTO_INCREMENT** because writes are spread evenly across regions rather than funneled to the last-insert hotspot region.
2. **Single-node MySQL throughput plateaus** under concurrent load; adding more writers yields diminishing returns and rising latency.
3. **Zero application change required**: the same `INSERT` SQL and PyMySQL connection code runs on both targets.

## Scaling the Test

Increase `WORKERS` to simulate higher concurrency. On a TiDB Dedicated cluster with 3+ TiKV nodes, throughput scales near-linearly up to ~100 concurrent writers before network I/O becomes the bottleneck. On a single-node MySQL, latency typically spikes sharply above 30–40 concurrent writers.
