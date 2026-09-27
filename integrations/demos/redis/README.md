# Redis Cache Invalidation with TiCDC

## What this proves

Platform teams running Redis as a cache in front of MySQL or Aurora fight two problems: stale
cache entries between a write and the next TTL expiry, and dual-write bugs when application code
has to remember to invalidate the cache itself. This demo measures the first problem directly
(a stale read rate, not a guess), replaces TTL-only invalidation with a TiCDC changefeed that
drives Redis deletes off real TiDB commits, and then asks honestly whether some read paths still
need Redis at all once staleness is solved.

This demo does not claim TiDB beats Redis on raw read latency. Redis is in-memory; TiDB is not.
It shows where the gap is small enough that correctness and a simpler architecture are worth it,
and it includes a hot-key storm act specifically to show where Redis still wins outright.

## Prerequisites

- macOS with Docker Desktop running
- `tiup` installed
- Node 22, `pnpm` installed
- Nothing else - this demo runs entirely on your machine, no cloud account required

## Run

1. From `integrations/`, start TiDB + TiCDC: `./infra/tidb/playground.sh` (leave running; note the
   TiDB/TiCDC version it prints).
2. Start the shared Kafka broker: `docker compose -f infra/kafka/docker-compose.yml up -d`.
3. Start this demo's Redis container: `docker compose -f demos/redis/infra/docker-compose.yml up -d`.
4. Copy `.env.example` to `.env` in `demos/redis/` and adjust `LAB_ENV_TIDB` to the version noted
   in step 1.
5. Create the TiCDC changefeed: `CDC_VERSION=<version> demos/redis/infra/create-changefeed.sh`.
6. From `integrations/`, run `pnpm lab run redis` and open the UI at the printed local URL.
7. Use the on-screen controls to fire a write burst, toggle TTL/CDC invalidation mode, and trigger
   the hot-key storm.

## Record

`pnpm lab run redis --record` records every event to `demos/redis/traces/<timestamp>.json`. A good
recording walks all three phases in order: let `ttl-only` run long enough to show a non-zero stale
read rate, fire a `write-burst`, `toggle-mode` into `cdc` and fire another `write-burst` to show the
stale rate drop to zero and the invalidation lag numbers, then let the demo reach `tidb-direct` and
fire `hot-key-storm` to contrast the two read paths. See section 8 of the implementation plan
(`docs/plans/04-redis.md`) for the exact promotion steps to `traces/featured.json`.

## Teardown

```bash
docker compose -f demos/redis/infra/docker-compose.yml down -v
docker compose -f infra/kafka/docker-compose.yml down -v
demos/redis/infra/drop-changefeed.sh
tiup clean lab
```

Confirm nothing is left running with `docker ps` and `ps aux | grep '[t]iup'`.

## Cost

Fully local; nothing bills. If you point this demo at TiDB Cloud instead of the local playground,
cost follows TiDB Cloud's own published pricing and the request units your own workload consumes -
see the TiDB Cloud pricing page at pingcap.com for current numbers; none are hardcoded here.

## Verified facts used by this demo

See section 4 of `docs/plans/04-redis.md` for the full list with sources. Two facts are still
marked UNVERIFIED there pending a live run against `tiup playground` (this wave built and
typechecked every adapter and the runner without starting any live system, per its work packet):
the exact `EXPLAIN` operator name for the point-get query, and the exact prepared-plan-cache
system variable name and value. Run the manual verification steps in section 4 and Task 8 of the
implementation plan before recording the featured trace, and paste the real observed values here.

This wave also captured and parsed a second, real TiCDC v8.5.8 canal-json message from an
unrelated table (`payments`) to prove the parser (`runner/src/canal.ts`) handles the genuine
protocol shape, not just this demo's own synthetic fixture, and that it extracts the TiDB
extension field's `commitTs` (a TSO) losslessly as a `bigint` - a plain `JSON.parse` of that same
message rounds the TSO to a different number, which is exactly the failure mode this matters for.
