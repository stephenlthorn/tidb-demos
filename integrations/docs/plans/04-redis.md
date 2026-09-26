# Plan 04: Redis + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a platform team that already runs Redis as a cache in front of MySQL or Aurora what changes when the system of record is TiDB: measure the stale-read tax of TTL-only cache-aside, replace it with TiCDC-driven invalidation and measure the lag until reads are provably fresh, then ask - and measure - whether some of those reads still need Redis at all.

**Architecture:** One TypeScript runner process drives a workload generator, a staleness sampler, and (in CDC mode) a Kafka consumer that invalidates Redis keys, all against a single demo table in TiDB. A TiCDC changefeed streams row changes from that table to the shared Kafka broker as `canal-json`; the runner's invalidator consumes those messages and deletes the corresponding Redis key. Every row carries its own `version` and `written_at_ms` columns, so the sampler and invalidator compute staleness and invalidation lag from values the demo itself wrote, not from TiDB or TiCDC internals.

**Tech Stack:** TypeScript runner on Node 22 using `@lab/runner-kit`; `redis` (node-redis v4+) for the cache; `kafkajs` for the Kafka consumer; `mysql2` (via `createTidbPool`) for TiDB, using pooled prepared statements (`pool.execute`) on every point-get path so TiDB's prepared plan cache is actually exercised; Docker Compose for a demo-local Redis container on the shared `lab` network; `tiup playground` (via `infra/tidb/playground.sh`) for TiDB + TiCDC.

**Depends on:** Plan 00 (platform). Uses the shared `infra/kafka/docker-compose.yml` broker. No other demo plan is a hard dependency; Kafka topics created here are demo-local and not shared with other Kafka-based demos.

---

## 1. Why this demo

- **The question customers ask:** "We already run Redis in front of MySQL/Aurora as a cache-aside layer, and we fight stale entries and dual-write bugs constantly. If we move to TiDB, do we still need Redis, and how do we stop serving stale data when the database changes underneath the cache?"
- **Pattern:** Platform teams running Redis as a cache in front of MySQL or Aurora, fighting stale cache entries and dual-write bugs.
- **What TiDB proves here:**
  - A TiCDC changefeed can drive cache invalidation directly off row commits, closing the staleness window that TTL-only caching leaves open, without the application performing a second, separate write to invalidate the cache.
  - Because invalidation is driven by what TiDB actually committed (via TiCDC), not by application code's belief about what it wrote, the classic dual-write bug class (cache updated but DB write failed, or vice versa) does not apply to the invalidation path.
  - TiDB's primary-key point-get path (the `Point_Get`/`Batch_Point_Get` plan, exercised through a prepared statement so the prepared plan cache applies) is fast enough that some read paths can drop Redis entirely and read TiDB directly, trading a few milliseconds of latency for zero staleness and one fewer moving part in production.
- **What this demo does not claim:**
  - It does not claim TiDB point-gets are faster than Redis `GET`s. Redis is an in-memory key-value store; it will win on raw single-key latency and ops/s against any disk-backed SQL database, TiDB included, every time. This demo shows *when* that gap is small enough that correctness (no staleness) is worth paying for, and *when* Redis is still the right call (the hot-key storm act).
  - It does not claim CDC-driven invalidation has zero lag. There is a measured pipeline delay (row write -> TiCDC -> Kafka -> invalidator -> Redis `DEL`), and the demo reports that number honestly instead of hiding it.
  - It is not a tutorial on every caching strategy. It compares exactly two invalidation strategies (TTL-only cache-aside vs. CDC-driven invalidation) and one "skip the cache" alternative; it does not cover write-through or refresh-ahead caching.

## 2. What the audience sees

### Flow diagram

```
[Workload Generator] --writes--------> [TiDB] --row changes--> [TiCDC Changefeed] --change events--> [Kafka]
        |     ^                          ^                                                              |
        |     +------ direct reads ------+   (act 3 only, bypasses Redis)                                |
        |                                                                                          change events
   cache reads                                                                                            v
        v                                                                                         [Invalidator]
     [Redis] <----------------------------------------- key invalidations -------------------------------+
        ^
        | version checks
        |
[Staleness Sampler] ------------------------------------- version checks --------------------------------> [TiDB]
```

Nodes map 1:1 to `manifest.json`: `workload` (client), `tidb` (tidb), `ticdc` (service), `kafka` (queue), `invalidator` (service), `redis` (cache), `sampler` (observability).

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | `ttl-only` | Cache-aside with TTL | Workload writes and reads run against Redis-in-front-of-TiDB with a fixed TTL and no invalidation. The sampler measures the stale read rate directly. | "This is the pattern most platform teams already run: Redis in front of the database with a TTL. Watch the stale read rate. Every row carries a version number, so we don't have to guess - when a write lands, the cache doesn't know until the TTL expires, and every read in that window is provably stale." |
| 2 | `cdc-invalidation` | CDC-driven invalidation | The `toggle-mode` control flips the demo to `cdc` mode. TiCDC streams row changes to Kafka; the invalidator consumes them and deletes the Redis key the instant it sees the change. | "Now a TiCDC changefeed streams every committed row change to Kafka, and an invalidator service deletes the Redis key the moment it sees it. No dual-write code in the application, no TTL guesswork. Watch the stale read rate drop to zero, and watch the invalidation lag - that's the real number, not a marketing number." |
| 3 | `tidb-direct` | Do you still need Redis? | The workload's read path switches to querying TiDB directly by primary key, in parallel with the existing cache-read path, so both are measured under the same load. The `hot-key-storm` control then floods one row id to show where Redis still wins. | "So do you still need Redis? Watch the same read mix go straight to TiDB by primary key. TiDB is slower than an in-memory cache - it's not trying to beat Redis - but it's fast enough that some read paths can drop Redis and its staleness problem entirely. Now watch what happens when we hammer a single hot key: that's exactly where Redis still wins outright." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `write-burst` | Write burst | Fires a fixed number of `UPDATE`s in quick succession against a random subset of demo rows, each bumping that row's `version` and `written_at_ms`, creating a spike the sampler and invalidator must catch up on. |
| `toggle-mode` | Toggle invalidation mode (TTL / CDC) | Flips the shared invalidation-mode state between `ttl` (Redis keys expire only by TTL; the invalidator ignores Kafka) and `cdc` (the invalidator consumes Kafka and deletes the corresponding key on every row change). Emits a `node` event marking the invalidator `idle` or `busy` accordingly. |
| `hot-key-storm` | Hot-key storm | Points the read workload at a single configured row id at a high fixed rate for a fixed duration, so the cache-read and direct-read paths can be compared under the exact read pattern an in-memory cache is built for. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `cdc-zero-stale` | Zero stale reads in CDC mode after lag window | In `cdc` mode, once at least one `invalidation-lag-p99` worth of milliseconds has elapsed since the last `write-burst`, the next full sampling tick's `stale-read-rate` must read exactly `0`. |
| `versions-converge` | Cache and DB versions converge after burst | After a `write-burst` control fires, the sampler re-checks every row it wrote to and finds the cached version equal to the TiDB version for all of them - within one invalidation cycle in `cdc` mode, or within one TTL period in `ttl` mode. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `cache-hit-ratio` | Cache hit ratio | `%` | both | higher | Workload generator counts Redis `GET` hits vs. misses on the cache-read path each tick; ratio = `hits / (hits + misses)` over the last tick, as a percentage. |
| `stale-read-rate` | Stale read rate | `%` | both | lower | Each row carries an integer `version` column bumped on every `UPDATE`. Each tick, the sampler runs `GET row:<id>` against Redis and `SELECT version FROM cache_demo_rows WHERE id = ?` (prepared) against TiDB for the same sample of recently-written row ids, and reports the percentage of sampled rows where the cached version is behind the TiDB version. |
| `invalidation-lag-p50` | Invalidation lag p50 | `ms` | both | lower | Every demo row also carries `written_at_ms` (the workload generator's `Date.now()` at write time). The invalidator reads that value out of the row's `data` in the consumed canal-json message and records `Date.now() - written_at_ms` at the moment it issues the Redis `DEL` for that key. `p50` of the last tick's samples via `@lab/runner-kit`'s `summarize`. |
| `invalidation-lag-p99` | Invalidation lag p99 | `ms` | both | lower | Same samples as `invalidation-lag-p50`; `p99` via `summarize`. |
| `redis-read-p50` | Redis read p50 | `ms` | both | lower | Workload generator times each Redis `GET` on the cache-read path with `@lab/runner-kit`'s `timed()`; `p50` of the last tick's samples. |
| `redis-read-p99` | Redis read p99 | `ms` | both | lower | Same samples as `redis-read-p50`; `p99`. |
| `tidb-read-p50` | TiDB read p50 | `ms` | both | lower | Workload generator times each direct TiDB point-get (`SELECT payload, version, written_at_ms FROM cache_demo_rows WHERE id = ?` via `pool.execute`, a prepared statement) with `timed()`; `p50` of the last tick's samples. |
| `tidb-read-p99` | TiDB read p99 | `ms` | both | lower | Same samples as `tidb-read-p50`; `p99`. |
| `tidb-qps` | TiDB QPS | `req/s` | both | neutral | Count of completed direct-TiDB-read-path queries in the last tick, divided by the tick interval in seconds. Reported as a fact, not scored "better" - the point of act 3 is to show the number, not to imply higher is automatically good. |
| `redis-ops-s` | Redis ops/s | `req/s` | both | neutral | Count of completed Redis `GET`/`DEL` operations (cache-read path plus invalidator deletes) in the last tick, divided by the tick interval in seconds. Reported as a fact for the same reason as `tidb-qps`. |

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| TiCDC's Kafka sink supports the `canal-json`, `open-protocol`, and `avro` protocols; `canal-json` is recommended "in most cases". | https://docs.pingcap.com/tidb/stable/ticdc-sink-to-kafka/ | Verified (WebSearch summary plus a direct fetch of the live rendered page, which contains the literal strings `protocol=canal-json` and `protocol=avro`). |
| A Kafka sink URI has the shape `kafka://<broker1>,<broker2>,.../<topic>?protocol=canal-json&kafka-version=<x>&partition-num=<n>&max-message-bytes=<n>`. | https://docs.pingcap.com/tidb/stable/ticdc-sink-to-kafka/ | Verified - fetched the exact query string from the live doc page: `kafka://127.0.0.1:9092,127.0.0.1:9093,127.0.0.1:9094/topic-name?protocol=canal-json&kafka-version=2.4.0&partition-num=6&max-message-bytes=67108864`. |
| Changefeeds are created with `cdc cli changefeed create --server=<owner-addr> --sink-uri=<uri> --changefeed-id=<id>`. | https://docs.pingcap.com/tidb/stable/ticdc-sink-to-kafka/ (WebSearch) | Verified for the `cdc cli` syntax itself. **UNVERIFIED**: the exact `tiup` invocation to reach that `cdc` binary when TiCDC was started by `tiup playground` (as opposed to a manually deployed TiCDC) - confirm with `tiup ctl:<version> cdc cli changefeed create --help` right after starting `infra/tidb/playground.sh`, using the version tiup prints at startup (Task 12). |
| TiCDC guarantees at-least-once delivery of DML/DDL; duplicates can occur on TiKV/TiCDC failure and retry. `safe-mode` (default `false` since TiCDC v6.1.3) controls whether TiCDC rewrites `INSERT`/`UPDATE` as `REPLACE INTO` downstream to tolerate those duplicates. | https://docs.pingcap.com/tidb/stable/ticdc-faq/ | Verified (WebSearch synthesis directly attributed to this docs page). |
| TiDB has a SQL Prepared Plan Cache covering both the `PREPARE`/`EXECUTE` SQL statements and the `COM_STMT_PREPARE`/`COM_STMT_EXECUTE` binary protocol: the parameterized query is parsed into an AST once, and later executions generate or reuse a plan from the cached AST. | https://docs.pingcap.com/tidb/stable/sql-prepared-plan-cache/ | Verified (WebSearch synthesis directly attributed to this docs page). |
| The exact system variable name and default value for enabling the prepared plan cache, and explicit confirmation that `Point_Get`/`Batch_Point_Get` plans are cached under it. | https://docs.pingcap.com/tidb/stable/sql-prepared-plan-cache/ | **UNVERIFIED** - WebFetch on `docs.pingcap.com` was blocked in this session (domain-verification error) and a `curl` fetch of the rendered page did not surface the variable name in a quick grep. Confirm before Task 8 by running `SHOW VARIABLES LIKE '%plan_cache%'` and `SHOW VARIABLES LIKE '%prepared_plan_cache%'` against the playground, then run a prepared point-get twice and check `SELECT @@last_plan_from_cache`. |
| TiDB's `EXPLAIN` output names a primary-key or unique-key single-row lookup operator `Point_Get`, and an `IN (...)`-list lookup `Batch_Point_Get`. | https://docs.pingcap.com/tidb/stable/explain-overview/ , https://docs.pingcap.com/tidb/stable/latency-breakdown/ | Verified generally (WebSearch results reference "Point get and Batch point get" operators for latency analysis). Exact casing (`Point_Get` vs. `PointGet` vs. other) as it appears in this specific TiDB version's `EXPLAIN` output is **UNVERIFIED** - Task 8's manual step runs `EXPLAIN SELECT payload, version, written_at_ms FROM cache_demo_rows WHERE id = ?` against the local playground and pastes the real operator name into `README.md` before the featured trace is recorded. |
| TiCDC's `canal-json` output implements the open-source Canal project's JSON change-event shape (per-row `data`/`old` column maps, `database`, `table`, `type`, etc.), with an additional TiDB-specific extension field for TiDB-only identifiers. | https://docs.pingcap.com/tidb/stable/ticdc-canal-json/ | Verified generally (WebSearch: "TiCDC appends a TiDB extension field to the Canal-JSON protocol format to include important TiDB-specific identifiers"). |
| The exact JSON key names inside a TiCDC `canal-json` message body (confirming row values live under `data`, and the name of the TiDB extension field). | https://docs.pingcap.com/tidb/stable/ticdc-canal-json/ | **UNVERIFIED** - WebFetch on this page was blocked in this session. Task 6's manual step captures one real message from this demo's own changefeed to `demos/redis/fixtures/sample-canal-json-message.json` and Task 7 (parser) is written and tested against that captured fixture, not an invented one. The parser (`runner/src/canal.ts`) reads only the generic Canal `data`/`table`/`type` fields (the row's own `written_at_ms` column value), not the TiDB extension field, specifically to avoid depending on an unverified field name. |
| Redis is an in-memory data store; single-key `GET`/`SET` latency and throughput on one instance is materially faster than any disk-backed SQL database, TiDB included. | N/A - architectural fact, not a vendor claim | Given as ground truth in the task brief; the demo's `README.md` and `TALK-TRACK.md` state this plainly rather than trying to show TiDB "winning" a latency race it cannot win. |
| `node-redis` (npm package `redis`, v4+) is the actively maintained client with first-class TypeScript types; Redis publishes an official migration guide from `ioredis` to it. | https://redis.io/docs/latest/develop/clients/nodejs/migration/ | Verified (official `redis.io` docs domain). |
| `kafkajs` is a pure-JavaScript Kafka client with no native build step, handling demo-scale throughput comfortably; it is the commonly recommended default over `node-rdkafka` (which wraps librdkafka and needs a native build) unless profiling shows the client itself is the bottleneck. | https://npm-compare.com/kafkajs,node-rdkafka , https://blog.platformatic.dev/why-we-created-another-kafka-client-for-nodejs | Verified as an engineering-choice rationale from community comparisons, not a vendor doc - there is no official "recommended Node Kafka client" page. Called out here as a tooling decision, not a TiDB product capability. |

## 5. Prerequisites, cost, and teardown

- **Accounts and access:** None. This demo runs entirely locally against `tiup playground`. Docker Desktop needs pull access to Docker Hub for the `redis:<tag>` image (Kafka's image is already pulled by any other demo that used `infra/kafka`).
- **Local tools:** macOS, Docker Desktop running, `tiup` installed, Node 22, `pnpm` installed - all assumed present per the platform's own prerequisites (Plan 00).
- **Cost model:** Fully local; nothing bills. `infra/tidb/playground.sh` runs TiDB, PD, TiKV, TiFlash, and TiCDC as local processes under `tiup`, and this demo's own `infra/docker-compose.yml` runs one Redis container plus the shared `infra/kafka/docker-compose.yml` broker as local Docker containers. If a presenter later points this demo at TiDB Cloud instead of the local playground, cost follows TiDB Cloud's own pricing page (see PingCAP's published pricing at pingcap.com) and the formula "compute + storage + request units actually consumed by this demo's write and read workload" - no price or quota is hardcoded anywhere in this plan, the manifest, or the runner.
- **Teardown (exact commands):**
  ```bash
  docker compose -f demos/redis/infra/docker-compose.yml down -v
  docker compose -f infra/kafka/docker-compose.yml down -v
  tiup clean lab
  ```
  Confirm nothing is left running with `docker ps` (expect no `lab-kafka` or demo Redis container) and `ps aux | grep '[t]iup'` (expect no playground process). If a run pointed at TiDB Cloud, also delete or stop that cluster from the TiDB Cloud console and confirm its billing status there - this plan never runs the demo against a cloud cluster by default.

## 6. File structure

```
demos/redis/
  manifest.json                      DemoManifestSchema instance for this demo (nodes, edges, metrics, phases, checks, controls).
  package.json                       "@lab/demo-redis"; depends on @lab/contract, @lab/runner-kit, redis, kafkajs.
  tsconfig.json                      Extends ../../tsconfig.base.json.
  .env.example                       Standard TIDB_* / LAB_ENV_* block plus REDIS_URL, KAFKA_BROKERS, KAFKA_TOPIC, KAFKA_GROUP_ID, and demo-tuning variables.
  README.md                          What it proves, prerequisites, run, record, teardown, cost notes (full content in Task 15).
  TALK-TRACK.md                      Presenter script per phase, 5 discovery questions, 5 objections and honest answers (full content in Task 16).
  infra/
    docker-compose.yml               Demo-local Redis service, joins the shared `lab` Docker network.
    create-changefeed.sh             Creates the TiCDC changefeed from cache_demo_rows to the shared Kafka broker.
    drop-changefeed.sh               Removes the changefeed (teardown helper).
  runner/
    main.ts                          Entry point: wires config, TiDB pool, Redis client, Kafka consumer, emitter, and every() loops together.
    src/
      config.ts                     Reads and validates this demo's own env vars (REDIS_URL, KAFKA_*, tuning knobs) with a small Zod schema.
      keys.ts                       Pure: Redis key naming for a row id.
      staleness.ts                  Pure: stale-row predicate, hit-ratio math, invalidation-lag math.
      canal.ts                      Pure: parses a captured canal-json message into a typed row-change record.
      mode.ts                       Pure: invalidation-mode and control-event state machine (ttl <-> cdc, hot-key-storm window).
      schema.sql.ts                 The demo table DDL and seed-data statements as a typed constant (executed once at startup).
      tidb-repo.ts                  Thin I/O: prepared-statement TiDB reads/writes (point-get, point-update, seed) built on createTidbPool.
      redis-cache.ts                Thin I/O: Redis GET/SET-with-TTL/DEL built on the node-redis client.
      workload.ts                   Thin I/O: the write loop and the two read loops (cache-read path, direct-read path), using every() and timed().
      invalidator.ts                Thin I/O: the kafkajs consumer loop that calls canal.ts + staleness.ts and issues Redis deletes.
      sampler.ts                    Thin I/O: the staleness/convergence sampling loop, using staleness.ts and emitting check/metric events.
    test/
      keys.test.ts                  Tests for keys.ts.
      staleness.test.ts             Tests for staleness.ts.
      canal.test.ts                 Tests for canal.ts, fixture-driven.
      mode.test.ts                  Tests for mode.ts.
  test/
    manifest.test.ts                 Parses manifest.json with DemoManifestSchema.
  fixtures/
    sample-canal-json-message.json   One real captured canal-json message from this demo's own changefeed (captured in Task 6, used by canal.test.ts).
  traces/
    featured.json                    The recording the website plays (committed after capture in section 8).
```

## 7. Tasks

### Task 1: manifest.json

- [ ] RED: create `demos/redis/test/manifest.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { readFileSync } from 'node:fs';
  import { DemoManifestSchema } from '@lab/contract';

  describe('redis demo manifest', () => {
    it('parses against DemoManifestSchema', () => {
      const raw = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
      const result = DemoManifestSchema.safeParse(raw);
      expect(result.success).toBe(true);
    });

    it('is demo id redis, number 4', () => {
      const raw = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
      const manifest = DemoManifestSchema.parse(raw);
      expect(manifest.id).toBe('redis');
      expect(manifest.number).toBe(4);
    });
  });
  ```
  Run: `pnpm --filter @lab/demo-redis test -- manifest` - expected FAIL (`manifest.json` does not exist).
- [ ] GREEN: create `demos/redis/manifest.json`:
  ```json
  {
    "id": "redis",
    "number": 4,
    "title": "Redis Cache Invalidation with TiCDC",
    "tagline": "Stop guessing when your cache is stale - let TiCDC tell you.",
    "integrations": ["Redis", "TiCDC", "Kafka"],
    "pattern": "Platform teams running Redis as a cache in front of MySQL or Aurora, fighting stale cache entries and dual-write bugs.",
    "publish": true,
    "runner": { "command": ["node", "--import", "tsx", "runner/main.ts"] },
    "nodes": [
      { "id": "workload", "label": "Workload Generator", "kind": "client", "x": 8, "y": 50 },
      { "id": "tidb", "label": "TiDB", "kind": "tidb", "x": 50, "y": 20 },
      { "id": "ticdc", "label": "TiCDC Changefeed", "kind": "service", "x": 70, "y": 8 },
      { "id": "kafka", "label": "Kafka", "kind": "queue", "x": 85, "y": 20 },
      { "id": "invalidator", "label": "Invalidator", "kind": "service", "x": 85, "y": 50 },
      { "id": "redis", "label": "Redis", "kind": "cache", "x": 50, "y": 80 },
      { "id": "sampler", "label": "Staleness Sampler", "kind": "observability", "x": 18, "y": 80 }
    ],
    "edges": [
      { "id": "writes", "from": "workload", "to": "tidb", "label": "writes", "unit": "rows/s" },
      { "id": "cache-reads", "from": "workload", "to": "redis", "label": "cache reads", "unit": "req/s" },
      { "id": "direct-reads", "from": "workload", "to": "tidb", "label": "direct reads", "unit": "req/s" },
      { "id": "row-changes", "from": "tidb", "to": "ticdc", "label": "row changes", "unit": "rows/s" },
      { "id": "change-events", "from": "ticdc", "to": "kafka", "label": "change events", "unit": "msgs/s" },
      { "id": "consumed-events", "from": "kafka", "to": "invalidator", "label": "change events", "unit": "msgs/s" },
      { "id": "invalidations", "from": "invalidator", "to": "redis", "label": "key invalidations", "unit": "req/s" },
      { "id": "sampler-tidb", "from": "sampler", "to": "tidb", "label": "version checks", "unit": "req/s" },
      { "id": "sampler-redis", "from": "sampler", "to": "redis", "label": "version checks", "unit": "req/s" }
    ],
    "metrics": [
      { "id": "cache-hit-ratio", "label": "Cache hit ratio", "unit": "%", "display": "both", "better": "higher", "group": "cache", "howMeasured": "Workload generator counts Redis GET hits vs misses on the cache-read path each tick; ratio = hits / (hits + misses) over the last tick, as a percentage." },
      { "id": "stale-read-rate", "label": "Stale read rate", "unit": "%", "display": "both", "better": "lower", "group": "cache", "howMeasured": "Sampler compares each sampled row's cached version (Redis GET) against its TiDB version (prepared point-get) each tick; percentage of sampled rows where the cached version is behind." },
      { "id": "invalidation-lag-p50", "label": "Invalidation lag p50", "unit": "ms", "display": "both", "better": "lower", "group": "lag", "howMeasured": "Invalidator computes Date.now() minus the row's written_at_ms (read from the consumed canal-json message) at the moment it issues the Redis DEL; p50 of the last tick's samples via runner-kit summarize." },
      { "id": "invalidation-lag-p99", "label": "Invalidation lag p99", "unit": "ms", "display": "both", "better": "lower", "group": "lag", "howMeasured": "Same samples as invalidation-lag-p50; p99 via runner-kit summarize." },
      { "id": "redis-read-p50", "label": "Redis read p50", "unit": "ms", "display": "both", "better": "lower", "group": "latency", "howMeasured": "Workload generator times each Redis GET on the cache-read path with runner-kit timed(); p50 of the last tick's samples." },
      { "id": "redis-read-p99", "label": "Redis read p99", "unit": "ms", "display": "both", "better": "lower", "group": "latency", "howMeasured": "Same samples as redis-read-p50; p99." },
      { "id": "tidb-read-p50", "label": "TiDB read p50", "unit": "ms", "display": "both", "better": "lower", "group": "latency", "howMeasured": "Workload generator times each direct TiDB point-get (prepared statement via pool.execute) with runner-kit timed(); p50 of the last tick's samples." },
      { "id": "tidb-read-p99", "label": "TiDB read p99", "unit": "ms", "display": "both", "better": "lower", "group": "latency", "howMeasured": "Same samples as tidb-read-p50; p99." },
      { "id": "tidb-qps", "label": "TiDB QPS", "unit": "req/s", "display": "both", "better": "neutral", "group": "throughput", "howMeasured": "Count of completed direct-TiDB-read-path queries in the last tick, divided by the tick interval in seconds." },
      { "id": "redis-ops-s", "label": "Redis ops/s", "unit": "req/s", "display": "both", "better": "neutral", "group": "throughput", "howMeasured": "Count of completed Redis GET/DEL operations in the last tick, divided by the tick interval in seconds." }
    ],
    "phases": [
      { "id": "ttl-only", "label": "Cache-aside with TTL", "narration": "This is the pattern most platform teams already run: Redis in front of the database with a TTL. Watch the stale read rate. Every row carries a version number, so we don't have to guess - when a write lands, the cache doesn't know until the TTL expires, and every read in that window is provably stale." },
      { "id": "cdc-invalidation", "label": "CDC-driven invalidation", "narration": "Now a TiCDC changefeed streams every committed row change to Kafka, and an invalidator service deletes the Redis key the moment it sees it. No dual-write code in the application, no TTL guesswork. Watch the stale read rate drop to zero, and watch the invalidation lag - that's the real number, not a marketing number." },
      { "id": "tidb-direct", "label": "Do you still need Redis?", "narration": "So do you still need Redis? Watch the same read mix go straight to TiDB by primary key. TiDB is slower than an in-memory cache - it's not trying to beat Redis - but it's fast enough that some read paths can drop Redis and its staleness problem entirely. Now watch what happens when we hammer a single hot key: that's exactly where Redis still wins outright." }
    ],
    "checks": [
      { "id": "cdc-zero-stale", "label": "Zero stale reads in CDC mode", "description": "In cdc mode, once one invalidation-lag-p99 worth of milliseconds has elapsed since the last write-burst, the next full sampling tick's stale-read-rate must read exactly 0." },
      { "id": "versions-converge", "label": "Cache and DB versions converge after burst", "description": "After a write-burst control fires, the sampler finds every sampled row's cached version equal to its TiDB version within one invalidation cycle (cdc mode) or one TTL period (ttl mode)." }
    ],
    "controls": [
      { "id": "write-burst", "label": "Write burst", "description": "Fires a fixed number of UPDATEs in quick succession against a random subset of demo rows, each bumping version and written_at_ms." },
      { "id": "toggle-mode", "label": "Toggle invalidation mode (TTL / CDC)", "description": "Flips the invalidation-mode state between ttl (Redis keys expire only by TTL) and cdc (the invalidator consumes Kafka and deletes keys on every row change)." },
      { "id": "hot-key-storm", "label": "Hot-key storm", "description": "Points the read workload at a single configured row id at a high fixed rate for a fixed duration." }
    ]
  }
  ```
  Run: `pnpm --filter @lab/demo-redis test -- manifest` - expected PASS.
- [ ] Commit: `git add demos/redis/manifest.json demos/redis/test/manifest.test.ts && git commit -m "redis demo: add manifest"`

### Task 2: package.json, tsconfig.json, .env.example

- [ ] Create `demos/redis/package.json`:
  ```json
  {
    "name": "@lab/demo-redis",
    "private": true,
    "type": "module",
    "scripts": {
      "test": "vitest run",
      "typecheck": "tsc -p tsconfig.json"
    },
    "dependencies": {
      "@lab/contract": "workspace:*",
      "@lab/runner-kit": "workspace:*",
      "redis": "^4.7.0",
      "kafkajs": "^2.2.4",
      "mysql2": "^3.11.0",
      "zod": "^4.0.0"
    },
    "devDependencies": {
      "@types/node": "^22.10.0",
      "tsx": "^4.19.0",
      "typescript": "^5.9.0",
      "vitest": "^3.2.0"
    }
  }
  ```
- [ ] Create `demos/redis/tsconfig.json`:
  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "outDir": "dist", "rootDir": "." },
    "include": ["runner", "test"]
  }
  ```
- [ ] Create `demos/redis/.env.example`:
  ```
  TIDB_HOST=127.0.0.1
  TIDB_PORT=4000
  TIDB_USER=root
  TIDB_PASSWORD=
  TIDB_DATABASE=lab
  TIDB_TLS=false
  LAB_ENV_TIDB=tiup playground (local)
  LAB_ENV_NOTES=

  REDIS_URL=redis://127.0.0.1:6379
  KAFKA_BROKERS=127.0.0.1:9092
  KAFKA_TOPIC=redis-demo.cache_rows
  KAFKA_GROUP_ID=redis-demo-invalidator
  REDIS_DEMO_ROW_COUNT=500
  REDIS_DEMO_TTL_SECONDS=5
  REDIS_DEMO_WRITE_RATE_MS=200
  REDIS_DEMO_READ_RATE_MS=50
  REDIS_DEMO_HOT_KEY_ID=1
  REDIS_DEMO_BURST_SIZE=25

  LAB_ENV_COMPONENT_REDIS=redis:7-alpine
  LAB_ENV_COMPONENT_KAFKA=apache/kafka:latest
  ```
  Every non-TiDB component this demo runs (Redis, Kafka) gets its own `LAB_ENV_COMPONENT_<NAME>`
  line so the relay copies its version into the trace's `environment.components`.
- [ ] Run: `pnpm install` from the repo root - expected PASS (workspace links resolve, no missing package errors).
- [ ] Commit: `git add demos/redis/package.json demos/redis/tsconfig.json demos/redis/.env.example && git commit -m "redis demo: scaffold package"`

### Task 3: keys.ts - Redis key naming (pure)

- [ ] RED: create `demos/redis/runner/test/keys.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { redisKeyForRow } from '../src/keys';

  describe('redisKeyForRow', () => {
    it('builds a namespaced key from a row id', () => {
      expect(redisKeyForRow(42)).toBe('row:42');
    });

    it('is stable for the same id', () => {
      expect(redisKeyForRow(7)).toBe(redisKeyForRow(7));
    });
  });
  ```
  Run: `pnpm --filter @lab/demo-redis test -- keys` - expected FAIL (`../src/keys` does not exist).
- [ ] GREEN: create `demos/redis/runner/src/keys.ts`:
  ```ts
  export const redisKeyForRow = (id: number): string => `row:${id}`;
  ```
  Run: `pnpm --filter @lab/demo-redis test -- keys` - expected PASS.
- [ ] Commit: `git add demos/redis/runner/src/keys.ts demos/redis/runner/test/keys.test.ts && git commit -m "redis demo: add key naming"`

### Task 4: staleness.ts - hit ratio, staleness predicate, invalidation lag (pure)

- [ ] RED: create `demos/redis/runner/test/staleness.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { computeHitRatioPercent, isStaleRead, computeInvalidationLagMs } from '../src/staleness';

  describe('computeHitRatioPercent', () => {
    it('returns 100 when there are no misses', () => {
      expect(computeHitRatioPercent({ hits: 10, misses: 0 })).toBe(100);
    });

    it('returns 0 when there are no hits', () => {
      expect(computeHitRatioPercent({ hits: 0, misses: 10 })).toBe(0);
    });

    it('returns 0 when there are no reads at all', () => {
      expect(computeHitRatioPercent({ hits: 0, misses: 0 })).toBe(0);
    });

    it('rounds to two decimal places', () => {
      expect(computeHitRatioPercent({ hits: 1, misses: 2 })).toBeCloseTo(33.33, 2);
    });
  });

  describe('isStaleRead', () => {
    it('is stale when the cached version is behind the TiDB version', () => {
      expect(isStaleRead({ cachedVersion: 3, tidbVersion: 5 })).toBe(true);
    });

    it('is not stale when versions match', () => {
      expect(isStaleRead({ cachedVersion: 5, tidbVersion: 5 })).toBe(false);
    });

    it('is not stale when the cache is somehow ahead', () => {
      expect(isStaleRead({ cachedVersion: 6, tidbVersion: 5 })).toBe(false);
    });
  });

  describe('computeInvalidationLagMs', () => {
    it('is the difference between delete time and write time', () => {
      expect(computeInvalidationLagMs({ deletedAtMs: 1_000, writtenAtMs: 850 })).toBe(150);
    });

    it('floors at zero for clock skew', () => {
      expect(computeInvalidationLagMs({ deletedAtMs: 100, writtenAtMs: 150 })).toBe(0);
    });
  });
  ```
  Run: `pnpm --filter @lab/demo-redis test -- staleness` - expected FAIL (`../src/staleness` does not exist).
- [ ] GREEN: create `demos/redis/runner/src/staleness.ts`:
  ```ts
  export type HitRatioInput = { readonly hits: number; readonly misses: number };
  export const computeHitRatioPercent = ({ hits, misses }: HitRatioInput): number => {
    const total = hits + misses;
    if (total === 0) return 0;
    return Math.round((hits / total) * 10_000) / 100;
  };

  export type StaleReadInput = { readonly cachedVersion: number; readonly tidbVersion: number };
  export const isStaleRead = ({ cachedVersion, tidbVersion }: StaleReadInput): boolean =>
    cachedVersion < tidbVersion;

  export type InvalidationLagInput = { readonly deletedAtMs: number; readonly writtenAtMs: number };
  export const computeInvalidationLagMs = ({ deletedAtMs, writtenAtMs }: InvalidationLagInput): number =>
    Math.max(0, deletedAtMs - writtenAtMs);
  ```
  Run: `pnpm --filter @lab/demo-redis test -- staleness` - expected PASS.
- [ ] Commit: `git add demos/redis/runner/src/staleness.ts demos/redis/runner/test/staleness.test.ts && git commit -m "redis demo: add staleness math"`

### Task 5: mode.ts - invalidation-mode and control state machine (pure)

- [ ] RED: create `demos/redis/runner/test/mode.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { initialDemoState, applyControl } from '../src/mode';

  describe('applyControl', () => {
    it('starts in ttl mode with no hot-key storm active', () => {
      expect(initialDemoState()).toEqual({ invalidationMode: 'ttl', hotKeyStormUntilMs: 0 });
    });

    it('toggle-mode flips ttl to cdc', () => {
      const next = applyControl(initialDemoState(), { id: 'toggle-mode', nowMs: 0 });
      expect(next.invalidationMode).toBe('cdc');
    });

    it('toggle-mode flips cdc back to ttl', () => {
      const cdcState = applyControl(initialDemoState(), { id: 'toggle-mode', nowMs: 0 });
      const next = applyControl(cdcState, { id: 'toggle-mode', nowMs: 0 });
      expect(next.invalidationMode).toBe('ttl');
    });

    it('hot-key-storm sets a future expiry from now', () => {
      const next = applyControl(initialDemoState(), { id: 'hot-key-storm', nowMs: 1_000, hotKeyStormDurationMs: 5_000 });
      expect(next.hotKeyStormUntilMs).toBe(6_000);
    });

    it('write-burst does not change mode or storm state', () => {
      const next = applyControl(initialDemoState(), { id: 'write-burst', nowMs: 1_000 });
      expect(next).toEqual(initialDemoState());
    });
  });
  ```
  Run: `pnpm --filter @lab/demo-redis test -- mode` - expected FAIL (`../src/mode` does not exist).
- [ ] GREEN: create `demos/redis/runner/src/mode.ts`:
  ```ts
  export type InvalidationMode = 'ttl' | 'cdc';

  export type DemoState = {
    readonly invalidationMode: InvalidationMode;
    readonly hotKeyStormUntilMs: number;
  };

  export const initialDemoState = (): DemoState => ({ invalidationMode: 'ttl', hotKeyStormUntilMs: 0 });

  export type ControlInput =
    | { readonly id: 'toggle-mode'; readonly nowMs: number }
    | { readonly id: 'hot-key-storm'; readonly nowMs: number; readonly hotKeyStormDurationMs: number }
    | { readonly id: 'write-burst'; readonly nowMs: number };

  const flip = (mode: InvalidationMode): InvalidationMode => (mode === 'ttl' ? 'cdc' : 'ttl');

  export const applyControl = (state: DemoState, control: ControlInput): DemoState => {
    if (control.id === 'toggle-mode') {
      return { ...state, invalidationMode: flip(state.invalidationMode) };
    }
    if (control.id === 'hot-key-storm') {
      return { ...state, hotKeyStormUntilMs: control.nowMs + control.hotKeyStormDurationMs };
    }
    return state;
  };

  export const isHotKeyStormActive = (state: DemoState, nowMs: number): boolean =>
    nowMs < state.hotKeyStormUntilMs;
  ```
  Run: `pnpm --filter @lab/demo-redis test -- mode` - expected PASS.
- [ ] Commit: `git add demos/redis/runner/src/mode.ts demos/redis/runner/test/mode.test.ts && git commit -m "redis demo: add invalidation-mode state machine"`

### Task 6: capture one real canal-json message (manual, unblocks Task 7)

This is a thin I/O / infra step, not TDD - it produces the fixture Task 7's parser is tested against, so `canal.ts` is never written against invented field names.

- [ ] Start local TiDB + TiCDC: `./infra/tidb/playground.sh` (from repo root `integrations/`), leave running. Note the TiDB version it prints as `LAB_ENV_TIDB` for later.
- [ ] Start the shared Kafka broker: `docker compose -f infra/kafka/docker-compose.yml up -d` - expected output includes `lab-kafka` healthy.
- [ ] Create the demo database and table by hand for this capture (the runner creates it automatically once Task 9 exists, but Task 6 runs before that):
  ```bash
  mysql -h 127.0.0.1 -P 4000 -u root -e "
    CREATE DATABASE IF NOT EXISTS lab;
    CREATE TABLE IF NOT EXISTS lab.cache_demo_rows (
      id BIGINT PRIMARY KEY,
      payload VARCHAR(255) NOT NULL,
      version BIGINT NOT NULL,
      written_at_ms BIGINT NOT NULL
    );
    INSERT INTO lab.cache_demo_rows (id, payload, version, written_at_ms) VALUES (1, 'seed', 1, 0);
  "
  ```
  Expected: no error, `mysql` exits 0.
- [ ] Create `demos/redis/infra/create-changefeed.sh` (also the real teardown/setup script used later by the README):
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  CDC_VERSION="${CDC_VERSION:?set to the TiCDC version tiup playground printed at startup}"
  tiup "ctl:${CDC_VERSION}" cdc cli changefeed create \
    --server="http://127.0.0.1:8300" \
    --sink-uri="kafka://127.0.0.1:9092/redis-demo.cache_rows?protocol=canal-json&kafka-version=3.6.0" \
    --changefeed-id="redis-demo" \
    --config /dev/stdin <<'CONF'
  [filter]
  rules = ["lab.cache_demo_rows"]
  CONF
  ```
  Run: `chmod +x demos/redis/infra/create-changefeed.sh && CDC_VERSION=<version-from-playground-output> demos/redis/infra/create-changefeed.sh` - expected output includes `Create changefeed successfully!`. **UNVERIFIED**: confirm the `tiup "ctl:${CDC_VERSION}" cdc cli ...` invocation is correct for a `tiup playground`-launched TiCDC (see section 4); if it fails, run `tiup ctl:<version> cdc cli changefeed create --help` and adjust this script before continuing.
- [ ] Cause one change and capture the resulting message:
  ```bash
  mysql -h 127.0.0.1 -P 4000 -u root -e "UPDATE lab.cache_demo_rows SET payload='v2', version=2, written_at_ms=$(($(date +%s%N)/1000000)) WHERE id=1;"
  docker run --rm --network lab edenhill/kcat:1.7.1 -b kafka:29092 -t redis-demo.cache_rows -C -c 1 -o beginning > demos/redis/fixtures/sample-canal-json-message.json
  cat demos/redis/fixtures/sample-canal-json-message.json
  ```
  Expected: one line of JSON is written to the fixture file and printed; it contains a `data` array with `payload`, `version`, and `written_at_ms` string values matching what was just written.
- [ ] Read the captured file and note the exact top-level field names (`database`, `table`, `type`, `data`, and whether an extension object such as `_tidb` is present) - update section 4's UNVERIFIED row for this fact with what was actually observed, and use these exact names in Task 7.
- [ ] Commit: `git add demos/redis/infra/create-changefeed.sh demos/redis/fixtures/sample-canal-json-message.json && git commit -m "redis demo: capture real canal-json fixture"`

### Task 7: canal.ts - parse a canal-json message (pure, fixture-driven)

- [ ] RED: create `demos/redis/runner/test/canal.test.ts`, loading the captured fixture from Task 6 (field names below use the generic Canal shape confirmed in Task 6; adjust field access to match what was actually captured):
  ```ts
  import { describe, expect, it } from 'vitest';
  import { readFileSync } from 'node:fs';
  import { parseCanalJsonMessage } from '../src/canal';

  describe('parseCanalJsonMessage', () => {
    it('extracts the row id, table, and written_at_ms from a captured message', () => {
      const raw = readFileSync(new URL('../../fixtures/sample-canal-json-message.json', import.meta.url), 'utf8');
      const result = parseCanalJsonMessage(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.change.table).toBe('cache_demo_rows');
        expect(result.change.rowId).toBe(1);
        expect(typeof result.change.writtenAtMs).toBe('number');
      }
    });

    it('reports an error for a line that is not JSON', () => {
      const result = parseCanalJsonMessage('not json');
      expect(result.ok).toBe(false);
    });

    it('reports an error for a message missing a data array', () => {
      const result = parseCanalJsonMessage(JSON.stringify({ database: 'lab', table: 'cache_demo_rows', type: 'INSERT' }));
      expect(result.ok).toBe(false);
    });
  });
  ```
  Run: `pnpm --filter @lab/demo-redis test -- canal` - expected FAIL (`../src/canal` does not exist).
- [ ] GREEN: create `demos/redis/runner/src/canal.ts` (adjust the field paths to whatever Task 6 actually captured before trusting this in production; shown here against the generic Canal `data` array shape):
  ```ts
  export type RowChange = {
    readonly table: string;
    readonly rowId: number;
    readonly writtenAtMs: number;
  };

  export type ParsedCanalMessage =
    | { readonly ok: true; readonly change: RowChange }
    | { readonly ok: false; readonly error: string };

  const parseJson = (raw: string): unknown | undefined => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

  export const parseCanalJsonMessage = (raw: string): ParsedCanalMessage => {
    const parsed = parseJson(raw);
    if (!isRecord(parsed)) return { ok: false, error: 'not JSON' };
    const table = parsed.table;
    const data = parsed.data;
    if (typeof table !== 'string') return { ok: false, error: 'missing table' };
    if (!Array.isArray(data) || data.length === 0 || !isRecord(data[0])) {
      return { ok: false, error: 'missing data' };
    }
    const row = data[0];
    const rowId = Number(row.id);
    const writtenAtMs = Number(row.written_at_ms);
    if (!Number.isFinite(rowId) || !Number.isFinite(writtenAtMs)) {
      return { ok: false, error: 'missing row id or written_at_ms' };
    }
    return { ok: true, change: { table, rowId, writtenAtMs } };
  };
  ```
  Run: `pnpm --filter @lab/demo-redis test -- canal` - expected PASS.
- [ ] Commit: `git add demos/redis/runner/src/canal.ts demos/redis/runner/test/canal.test.ts && git commit -m "redis demo: add canal-json parser"`

### Task 8: tidb-repo.ts - TiDB I/O adapter (thin, manual live-run)

- [ ] Create `demos/redis/runner/src/schema.sql.ts`:
  ```ts
  export const createTableSql = `
    CREATE TABLE IF NOT EXISTS cache_demo_rows (
      id BIGINT PRIMARY KEY,
      payload VARCHAR(255) NOT NULL,
      version BIGINT NOT NULL,
      written_at_ms BIGINT NOT NULL
    )
  `;
  ```
- [ ] Create `demos/redis/runner/src/tidb-repo.ts`:
  ```ts
  import type { Pool, RowDataPacket } from 'mysql2/promise';
  import { createTableSql } from './schema.sql';

  export type CacheRow = {
    readonly id: number;
    readonly payload: string;
    readonly version: number;
    readonly writtenAtMs: number;
  };

  export const initSchema = async (pool: Pool): Promise<void> => {
    await pool.query(createTableSql);
  };

  export const seedRows = async (pool: Pool, rowCount: number): Promise<void> => {
    const values = Array.from({ length: rowCount }, (_, index) => [index + 1, 'seed', 1, Date.now()]);
    await pool.query('INSERT IGNORE INTO cache_demo_rows (id, payload, version, written_at_ms) VALUES ?', [values]);
  };

  type CacheRowRecord = RowDataPacket & {
    readonly id: number;
    readonly payload: string;
    readonly version: number;
    readonly writtenAtMs: number;
  };

  export const readRowById = async (pool: Pool, id: number): Promise<CacheRow | undefined> => {
    const [rows] = await pool.execute<CacheRowRecord[]>(
      'SELECT id, payload, version, written_at_ms AS writtenAtMs FROM cache_demo_rows WHERE id = ?',
      [id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { id: row.id, payload: row.payload, version: row.version, writtenAtMs: row.writtenAtMs };
  };

  export const writeRowById = async (pool: Pool, id: number, payload: string, writtenAtMs: number): Promise<void> => {
    await pool.execute(
      'UPDATE cache_demo_rows SET payload = ?, version = version + 1, written_at_ms = ? WHERE id = ?',
      [payload, writtenAtMs, id],
    );
  };
  ```
- [ ] Manual live-run: with `infra/tidb/playground.sh` running and `.env` copied from `.env.example`, run:
  ```bash
  node --import tsx -e "
    import { createTidbPool } from '@lab/runner-kit';
    import { initSchema, seedRows, readRowById, writeRowById } from './demos/redis/runner/src/tidb-repo.ts';
    const pool = createTidbPool(process.env);
    await initSchema(pool);
    await seedRows(pool, 5);
    await writeRowById(pool, 1, 'updated', Date.now());
    console.log(await readRowById(pool, 1));
    await pool.end();
  "
  ```
  Expected output: an object with `id: 1, payload: 'updated', version: 2, writtenAtMs: <recent ms>`.
- [ ] Manual verification of Point_Get + prepared plan cache (resolves the two UNVERIFIED rows in section 4): run `EXPLAIN SELECT id, payload, version, written_at_ms FROM cache_demo_rows WHERE id = 1;` via the TiDB CLI and confirm the plan's top operator name; run the `readRowById` call twice in the same connection and check `SHOW VARIABLES LIKE '%plan_cache%'` plus `SELECT @@last_plan_from_cache` after the second call. Paste both real outputs into `README.md`'s verified-facts section once written (Task 15).
- [ ] Commit: `git add demos/redis/runner/src/schema.sql.ts demos/redis/runner/src/tidb-repo.ts && git commit -m "redis demo: add TiDB repo adapter"`

### Task 9: redis-cache.ts - Redis I/O adapter (thin, manual live-run)

- [ ] Create `demos/redis/infra/docker-compose.yml`:
  ```yaml
  services:
    redis:
      image: redis:7-alpine
      container_name: lab-redis-demo
      ports:
        - "6379:6379"
      command: ["redis-server", "--save", ""]
  networks:
    default:
      name: lab
  ```
- [ ] Create `demos/redis/runner/src/redis-cache.ts`:
  ```ts
  import { createClient } from 'redis';

  export type RedisClient = ReturnType<typeof createClient>;

  export const createDemoRedisClient = (url: string): RedisClient => createClient({ url });

  export const getCachedPayload = async (client: RedisClient, key: string): Promise<string | undefined> => {
    const value = await client.get(key);
    return value ?? undefined;
  };

  export const setCachedPayload = async (
    client: RedisClient,
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> => {
    await client.set(key, value, { EX: ttlSeconds });
  };

  export const deleteCachedPayload = async (client: RedisClient, key: string): Promise<void> => {
    await client.del(key);
  };
  ```
- [ ] Manual live-run: `docker compose -f demos/redis/infra/docker-compose.yml up -d`, then:
  ```bash
  node --import tsx -e "
    import { createDemoRedisClient, setCachedPayload, getCachedPayload, deleteCachedPayload } from './demos/redis/runner/src/redis-cache.ts';
    const client = createDemoRedisClient('redis://127.0.0.1:6379');
    await client.connect();
    await setCachedPayload(client, 'row:1', JSON.stringify({ version: 1 }), 5);
    console.log(await getCachedPayload(client, 'row:1'));
    await deleteCachedPayload(client, 'row:1');
    console.log(await getCachedPayload(client, 'row:1'));
    await client.quit();
  "
  ```
  Expected output: the JSON string, then `undefined`.
- [ ] Commit: `git add demos/redis/infra/docker-compose.yml demos/redis/runner/src/redis-cache.ts && git commit -m "redis demo: add Redis cache adapter"`

### Task 10: config.ts - demo env parsing (pure-ish, TDD)

- [ ] RED: create `demos/redis/runner/test/config.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { loadDemoConfig } from '../src/config';

  const baseEnv = {
    REDIS_URL: 'redis://127.0.0.1:6379',
    KAFKA_BROKERS: '127.0.0.1:9092',
    KAFKA_TOPIC: 'redis-demo.cache_rows',
    KAFKA_GROUP_ID: 'redis-demo-invalidator',
    REDIS_DEMO_ROW_COUNT: '500',
    REDIS_DEMO_TTL_SECONDS: '5',
    REDIS_DEMO_WRITE_RATE_MS: '200',
    REDIS_DEMO_READ_RATE_MS: '50',
    REDIS_DEMO_HOT_KEY_ID: '1',
    REDIS_DEMO_BURST_SIZE: '25',
  };

  describe('loadDemoConfig', () => {
    it('parses a complete env into typed config', () => {
      const config = loadDemoConfig(baseEnv);
      expect(config.rowCount).toBe(500);
      expect(config.ttlSeconds).toBe(5);
      expect(config.hotKeyId).toBe(1);
    });

    it('throws when a required variable is missing', () => {
      const { REDIS_URL, ...rest } = baseEnv;
      expect(() => loadDemoConfig(rest)).toThrow();
    });
  });
  ```
  Run: `pnpm --filter @lab/demo-redis test -- config` - expected FAIL.
- [ ] GREEN: create `demos/redis/runner/src/config.ts`:
  ```ts
  import { z } from 'zod';

  const EnvSchema = z.object({
    REDIS_URL: z.string().min(1),
    KAFKA_BROKERS: z.string().min(1),
    KAFKA_TOPIC: z.string().min(1),
    KAFKA_GROUP_ID: z.string().min(1),
    REDIS_DEMO_ROW_COUNT: z.coerce.number().int().positive(),
    REDIS_DEMO_TTL_SECONDS: z.coerce.number().int().positive(),
    REDIS_DEMO_WRITE_RATE_MS: z.coerce.number().int().positive(),
    REDIS_DEMO_READ_RATE_MS: z.coerce.number().int().positive(),
    REDIS_DEMO_HOT_KEY_ID: z.coerce.number().int().positive(),
    REDIS_DEMO_BURST_SIZE: z.coerce.number().int().positive(),
  });

  export type DemoConfig = {
    readonly redisUrl: string;
    readonly kafkaBrokers: readonly string[];
    readonly kafkaTopic: string;
    readonly kafkaGroupId: string;
    readonly rowCount: number;
    readonly ttlSeconds: number;
    readonly writeRateMs: number;
    readonly readRateMs: number;
    readonly hotKeyId: number;
    readonly burstSize: number;
  };

  export const loadDemoConfig = (env: Record<string, string | undefined>): DemoConfig => {
    const parsed = EnvSchema.parse(env);
    return {
      redisUrl: parsed.REDIS_URL,
      kafkaBrokers: parsed.KAFKA_BROKERS.split(','),
      kafkaTopic: parsed.KAFKA_TOPIC,
      kafkaGroupId: parsed.KAFKA_GROUP_ID,
      rowCount: parsed.REDIS_DEMO_ROW_COUNT,
      ttlSeconds: parsed.REDIS_DEMO_TTL_SECONDS,
      writeRateMs: parsed.REDIS_DEMO_WRITE_RATE_MS,
      readRateMs: parsed.REDIS_DEMO_READ_RATE_MS,
      hotKeyId: parsed.REDIS_DEMO_HOT_KEY_ID,
      burstSize: parsed.REDIS_DEMO_BURST_SIZE,
    };
  };
  ```
  Run: `pnpm --filter @lab/demo-redis test -- config` - expected PASS.
- [ ] Commit: `git add demos/redis/runner/src/config.ts demos/redis/runner/test/config.test.ts && git commit -m "redis demo: add config loader"`

### Task 11: workload.ts - write and read loops (thin I/O, manual live-run)

- [ ] Create `demos/redis/runner/src/workload.ts`:
  ```ts
  import type { Pool } from 'mysql2/promise';
  import type { Emitter, SampleWindow } from '@lab/runner-kit';
  import { timed } from '@lab/runner-kit';
  import type { RedisClient } from './redis-cache';
  import { getCachedPayload, setCachedPayload } from './redis-cache';
  import { readRowById, writeRowById } from './tidb-repo';
  import { redisKeyForRow } from './keys';
  import type { DemoState } from './mode';
  import { isHotKeyStormActive } from './mode';

  export type WorkloadDeps = {
    readonly pool: Pool;
    readonly redis: RedisClient;
    readonly emitter: Emitter;
    readonly rowCount: number;
    readonly ttlSeconds: number;
    readonly hotKeyId: number;
    readonly getState: () => DemoState;
    readonly cacheReadLatencies: SampleWindow;
    readonly tidbReadLatencies: SampleWindow;
    readonly cacheHits: { count: number };
    readonly cacheMisses: { count: number };
    readonly tidbReadCount: { count: number };
    readonly redisOpCount: { count: number };
  };

  const randomRowId = (rowCount: number, hotKeyId: number, storming: boolean): number =>
    storming ? hotKeyId : Math.floor(Math.random() * rowCount) + 1;

  export const runWriteTick = async (deps: WorkloadDeps): Promise<void> => {
    const id = randomRowId(deps.rowCount, deps.hotKeyId, false);
    await writeRowById(deps.pool, id, `payload-${Date.now()}`, Date.now());
    deps.emitter.flow('writes', 1);
  };

  export const runCacheReadTick = async (deps: WorkloadDeps): Promise<void> => {
    const storming = isHotKeyStormActive(deps.getState(), Date.now());
    const id = randomRowId(deps.rowCount, deps.hotKeyId, storming);
    const key = redisKeyForRow(id);
    const { value: cached, ms } = await timed(() => getCachedPayload(deps.redis, key));
    deps.cacheReadLatencies.add(ms);
    deps.redisOpCount.count += 1;
    if (cached === undefined) {
      deps.cacheMisses.count += 1;
      const row = await readRowById(deps.pool, id);
      if (row) {
        await setCachedPayload(deps.redis, key, JSON.stringify(row), deps.ttlSeconds);
        deps.redisOpCount.count += 1;
      }
    } else {
      deps.cacheHits.count += 1;
    }
    deps.emitter.flow('cache-reads', 1);
  };

  export const runDirectReadTick = async (deps: WorkloadDeps): Promise<void> => {
    const storming = isHotKeyStormActive(deps.getState(), Date.now());
    const id = randomRowId(deps.rowCount, deps.hotKeyId, storming);
    const { ms } = await timed(() => readRowById(deps.pool, id));
    deps.tidbReadLatencies.add(ms);
    deps.tidbReadCount.count += 1;
    deps.emitter.flow('direct-reads', 1);
  };
  ```
- [ ] Manual live-run: with TiDB, Redis, and `.env` in place, run a short driver script that calls `runWriteTick`/`runCacheReadTick` five times each in a loop and logs `cacheHits`/`cacheMisses` - expected: mostly misses on the first pass per row, then hits once each row's key is warm (before its TTL expires).
- [ ] Commit: `git add demos/redis/runner/src/workload.ts && git commit -m "redis demo: add workload generator"`

### Task 12: sampler.ts and invalidator.ts - staleness sampling and CDC invalidation (thin I/O, manual live-run)

- [ ] Create `demos/redis/runner/src/sampler.ts`:
  ```ts
  import { z } from 'zod';
  import type { Pool } from 'mysql2/promise';
  import type { Emitter } from '@lab/runner-kit';
  import type { RedisClient } from './redis-cache';
  import { getCachedPayload } from './redis-cache';
  import { readRowById } from './tidb-repo';
  import { redisKeyForRow } from './keys';
  import { isStaleRead } from './staleness';

  export type SampledRow = { readonly id: number };

  const CachedPayloadSchema = z.object({ version: z.number() });

  export const sampleStaleness = async (
    pool: Pool,
    redis: RedisClient,
    emitter: Emitter,
    sampleIds: readonly number[],
  ): Promise<number> => {
    let staleCount = 0;
    for (const id of sampleIds) {
      const cachedRaw = await getCachedPayload(redis, redisKeyForRow(id));
      const tidbRow = await readRowById(pool, id);
      emitter.flow('sampler-tidb', 1);
      emitter.flow('sampler-redis', 1);
      if (cachedRaw === undefined || tidbRow === undefined) continue;
      const cachedPayload = CachedPayloadSchema.safeParse(JSON.parse(cachedRaw));
      if (!cachedPayload.success) continue;
      if (isStaleRead({ cachedVersion: cachedPayload.data.version, tidbVersion: tidbRow.version })) staleCount += 1;
    }
    return sampleIds.length === 0 ? 0 : Math.round((staleCount / sampleIds.length) * 10_000) / 100;
  };
  ```
- [ ] Create `demos/redis/runner/src/invalidator.ts`:
  ```ts
  import { Kafka } from 'kafkajs';
  import type { Emitter, SampleWindow } from '@lab/runner-kit';
  import type { RedisClient } from './redis-cache';
  import { deleteCachedPayload } from './redis-cache';
  import { redisKeyForRow } from './keys';
  import { parseCanalJsonMessage } from './canal';
  import { computeInvalidationLagMs } from './staleness';
  import type { DemoState } from './mode';

  export type InvalidatorDeps = {
    readonly kafkaBrokers: readonly string[];
    readonly topic: string;
    readonly groupId: string;
    readonly redis: RedisClient;
    readonly emitter: Emitter;
    readonly lagSamples: SampleWindow;
    readonly getState: () => DemoState;
  };

  export const runInvalidator = async (deps: InvalidatorDeps): Promise<() => Promise<void>> => {
    const kafka = new Kafka({ brokers: [...deps.kafkaBrokers] });
    const consumer = kafka.consumer({ groupId: deps.groupId });
    await consumer.connect();
    await consumer.subscribe({ topic: deps.topic, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        deps.emitter.flow('consumed-events', 1);
        if (deps.getState().invalidationMode !== 'cdc') return;
        const raw = message.value?.toString('utf8');
        if (!raw) return;
        const parsed = parseCanalJsonMessage(raw);
        if (!parsed.ok) {
          deps.emitter.log('warn', `unparseable canal-json message: ${parsed.error}`);
          return;
        }
        await deleteCachedPayload(deps.redis, redisKeyForRow(parsed.change.rowId));
        deps.emitter.flow('invalidations', 1);
        deps.lagSamples.add(computeInvalidationLagMs({ deletedAtMs: Date.now(), writtenAtMs: parsed.change.writtenAtMs }));
      },
    });
    return () => consumer.disconnect();
  };
  ```
- [ ] Manual live-run: with the changefeed from Task 6 active and the invalidator started against it, run one `writeRowById` call in `cdc` mode and confirm (via added temporary logging) that a Redis `DEL` for that row's key follows within a few hundred milliseconds. Expected: the row's `redis-cache.ts` `getCachedPayload` returns `undefined` immediately after the delete.
- [ ] Commit: `git add demos/redis/runner/src/sampler.ts demos/redis/runner/src/invalidator.ts && git commit -m "redis demo: add sampler and CDC invalidator"`

### Task 13: main.ts - wire everything together (thin I/O, manual live-run)

- [ ] Create `demos/redis/runner/main.ts`:
  ```ts
  import { createEmitter, createTidbPool, createSampleWindow, every, onControl, summarize } from '@lab/runner-kit';
  import { loadDemoConfig } from './src/config';
  import { initSchema, seedRows } from './src/tidb-repo';
  import { createDemoRedisClient } from './src/redis-cache';
  import { runInvalidator } from './src/invalidator';
  import { sampleStaleness } from './src/sampler';
  import { runWriteTick, runCacheReadTick, runDirectReadTick } from './src/workload';
  import { initialDemoState, applyControl } from './src/mode';

  const main = async (): Promise<void> => {
    const config = loadDemoConfig(process.env);
    const emitter = createEmitter();
    const pool = createTidbPool(process.env);
    const redis = createDemoRedisClient(config.redisUrl);
    await redis.connect();

    emitter.node('tidb', 'starting');
    await initSchema(pool);
    await seedRows(pool, config.rowCount);
    emitter.node('tidb', 'healthy');
    emitter.node('redis', 'healthy');

    let state = initialDemoState();
    const getState = () => state;

    onControl((id) => {
      const nowMs = emitter.elapsedMs();
      if (id === 'toggle-mode') {
        state = applyControl(state, { id: 'toggle-mode', nowMs });
        emitter.node('invalidator', state.invalidationMode === 'cdc' ? 'busy' : 'idle');
        emitter.phase(state.invalidationMode === 'cdc' ? 'cdc-invalidation' : 'ttl-only');
      }
      if (id === 'hot-key-storm') {
        state = applyControl(state, { id: 'hot-key-storm', nowMs, hotKeyStormDurationMs: 10_000 });
        emitter.phase('tidb-direct');
      }
      if (id === 'write-burst') {
        Array.from({ length: config.burstSize }).forEach(() => {
          void runWriteTick({ ...workloadDeps, getState });
        });
      }
    });

    const cacheReadLatencies = createSampleWindow();
    const tidbReadLatencies = createSampleWindow();
    const lagSamples = createSampleWindow();
    const cacheHits = { count: 0 };
    const cacheMisses = { count: 0 };
    const tidbReadCount = { count: 0 };
    const redisOpCount = { count: 0 };

    const workloadDeps = {
      pool,
      redis,
      emitter,
      rowCount: config.rowCount,
      ttlSeconds: config.ttlSeconds,
      hotKeyId: config.hotKeyId,
      getState,
      cacheReadLatencies,
      tidbReadLatencies,
      cacheHits,
      cacheMisses,
      tidbReadCount,
      redisOpCount,
    };

    const stopInvalidator = await runInvalidator({
      kafkaBrokers: config.kafkaBrokers,
      topic: config.kafkaTopic,
      groupId: config.kafkaGroupId,
      redis,
      emitter,
      lagSamples,
      getState,
    });

    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());

    emitter.phase('ttl-only');

    await Promise.all([
      every({ intervalMs: config.writeRateMs, signal: controller.signal, task: () => runWriteTick(workloadDeps) }),
      every({ intervalMs: config.readRateMs, signal: controller.signal, task: () => runCacheReadTick(workloadDeps) }),
      every({ intervalMs: config.readRateMs, signal: controller.signal, task: () => runDirectReadTick(workloadDeps) }),
      every({
        intervalMs: 1_000,
        signal: controller.signal,
        task: async () => {
          const sampleIds = Array.from({ length: 20 }, () => Math.floor(Math.random() * config.rowCount) + 1);
          const staleRate = await sampleStaleness(pool, redis, emitter, sampleIds);
          emitter.metric('stale-read-rate', staleRate);
          emitter.metric('cache-hit-ratio', cacheHits.count + cacheMisses.count === 0 ? 0 : Math.round((cacheHits.count / (cacheHits.count + cacheMisses.count)) * 10_000) / 100);
          emitter.metric('tidb-qps', tidbReadCount.count);
          emitter.metric('redis-ops-s', redisOpCount.count);
          const cacheSummary = summarize(cacheReadLatencies.drain());
          if (cacheSummary) {
            emitter.metric('redis-read-p50', cacheSummary.p50);
            emitter.metric('redis-read-p99', cacheSummary.p99);
          }
          const tidbSummary = summarize(tidbReadLatencies.drain());
          if (tidbSummary) {
            emitter.metric('tidb-read-p50', tidbSummary.p50);
            emitter.metric('tidb-read-p99', tidbSummary.p99);
          }
          const lagSummary = summarize(lagSamples.drain());
          if (lagSummary) {
            emitter.metric('invalidation-lag-p50', lagSummary.p50);
            emitter.metric('invalidation-lag-p99', lagSummary.p99);
          }
          tidbReadCount.count = 0;
          redisOpCount.count = 0;
          cacheHits.count = 0;
          cacheMisses.count = 0;
        },
      }),
    ]);

    await stopInvalidator();
    await redis.quit();
    await pool.end();
  };

  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
  ```
- [ ] Manual live-run: `pnpm lab run redis` from `integrations/` with TiDB, Redis, and Kafka running - expected: `GET /health` returns `{"ok":true,"demo":"redis"}`, and `GET /events` streams `node`, `phase`, `flow`, and `metric` events within the first few seconds.
- [ ] Commit: `git add demos/redis/runner/main.ts && git commit -m "redis demo: wire up runner main"`

### Task 14: validate the manifest and event references end to end

- [ ] Run: `pnpm lab validate redis` - expected PASS (no unknown node/edge/metric/phase/check/control ids referenced by any event the runner emits during a short manual run).
- [ ] If it fails, fix the mismatched id in `manifest.json` or the emitting call site, then re-run until it passes.
- [ ] Commit any fixes: `git commit -am "redis demo: fix manifest/event id mismatches"` (only if changes were needed).

### Task 15: README.md

- [ ] Create `demos/redis/README.md`:
  ```markdown
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
  tiup clean lab
  ```

  Confirm nothing is left running with `docker ps` and `ps aux | grep '[t]iup'`.

  ## Cost

  Fully local; nothing bills. If you point this demo at TiDB Cloud instead of the local playground,
  cost follows TiDB Cloud's own published pricing and the request units your own workload consumes -
  see PingCAP's pricing page for current numbers; none are hardcoded here.

  ## Verified facts used by this demo

  See section 4 of `docs/plans/04-redis.md` for the full list with sources. Two facts were confirmed
  live during Task 8 and are recorded here: the `EXPLAIN` operator name observed for the point-get
  query was `<paste the real operator name from Task 8 here>`, and the prepared plan cache variable
  and its value were `<paste the real variable name and value from Task 8 here>`.
  ```
- [ ] Commit: `git add demos/redis/README.md && git commit -m "redis demo: add README"`

### Task 16: TALK-TRACK.md

- [ ] Create `demos/redis/TALK-TRACK.md`:
  ```markdown
  # Talk track: Redis Cache Invalidation with TiCDC

  ## Phase 1 - Cache-aside with TTL

  "This is the pattern most of you already run: Redis in front of the database, TTL-based
  expiry, cache-aside reads. Every row in this demo carries a version number, so instead of me
  telling you the cache is stale, a sampler is checking it every second and reporting the real
  percentage. Watch that number - it's not zero, and it can't be zero, because nothing tells the
  cache a write happened until the TTL runs out."

  ## Phase 2 - CDC-driven invalidation

  "Now I'm turning on a TiCDC changefeed. Every committed row change streams to Kafka as it
  happens, and a small invalidator service deletes the corresponding Redis key the moment it sees
  it. No second write in the application code, no TTL tuning. Watch the stale read rate - and watch
  the invalidation lag number next to it, because that's the honest cost of this approach: it's not
  instant, it's this many milliseconds, measured live."

  ## Phase 3 - Do you still need Redis?

  "Here's the question I actually get asked: if TiCDC keeps the cache correct, do you still need
  the cache? I'm going to run the identical read pattern straight against TiDB by primary key,
  side by side with the cached path. TiDB is not going to win a latency race against an in-memory
  store - it's not built to - but look at how close it is. For a lot of read paths, that gap is
  worth paying to delete an entire cache layer and its failure modes. Now watch what happens when
  I hammer one single key over and over." *(fire hot-key-storm)* "That's where Redis is still the
  right tool. This isn't about replacing Redis everywhere - it's about knowing which reads still
  need it."

  ## Discovery questions

  1. Where in your read path do you currently accept staleness, and who decided how long that
     window could be?
  2. How many places in your codebase write to both the cache and the database today, and what
     happens when one of those writes fails and the other succeeds?
  3. Do you know your actual stale read rate right now, or is "the TTL is short enough" the honest
     answer?
  4. Which of your cached endpoints are read-heavy on a small number of hot keys versus a wide,
     even spread of keys?
  5. If invalidation lag were a number on a dashboard instead of an assumption, what would you want
     it to be, and what would you do differently if it were higher than that?

  ## Objections and honest answers

  1. **"CDC adds a Kafka broker and an invalidator service - that's more infrastructure, not
     less."** True. This trades application-level dual-write complexity (spread across every
     service that writes) for one centralized, testable invalidation path. If you don't already
     run Kafka, weigh that against the number of places you'd otherwise have to remember to
     invalidate a cache correctly.
  2. **"Redis is still faster - why would I ever read TiDB directly?"** It is, and this demo
     shows that gap on screen rather than hiding it. The pitch in phase 3 isn't "TiDB is faster,"
     it's "for some read paths, the latency difference is smaller than the cost of a second system
     you have to keep consistent."
  3. **"What about the invalidation lag window - can't I still serve a stale read during it?"**
     Yes. This demo measures that window (`invalidation-lag-p50`/`p99`) instead of pretending it's
     zero. If your correctness requirement is stricter than that window, this pattern alone isn't
     enough - you'd need read-your-writes routing on top of it.
  4. **"TiCDC only guarantees at-least-once delivery - won't I get duplicate invalidations?"**
     Yes, duplicates can happen on failure and retry. That's fine here: the invalidator's action is
     a `DEL`, which is naturally idempotent - deleting an already-deleted key is a no-op, so
     at-least-once delivery is exactly the guarantee this pattern needs.
  5. **"This is a toy table with one row size - what happens at real scale?"** This demo is
     intentionally small so the whole pipeline is visible in a few minutes. It measures real
     lag and real staleness on real infrastructure, but it does not claim to have load-tested this
     pattern at production row counts or write rates; that's a follow-up exercise with your own
     schema and workload.
  ```
- [ ] Commit: `git add demos/redis/TALK-TRACK.md && git commit -m "redis demo: add talk track"`

## 8. Recording the featured trace

- [ ] Ensure `LAB_ENV_TIDB` in `.env` holds the exact version string `tiup playground` printed at
      startup, and set `LAB_ENV_NOTES` to something like "single-node local playground, demo-local
      Redis + shared Kafka broker, no cloud resources".
- [ ] Start TiDB/TiCDC, Kafka, Redis, and create the changefeed as in the README's Run section.
- [ ] Run `pnpm lab run redis --record` and drive the demo in order:
  1. Let `ttl-only` run for at least 60 seconds so `stale-read-rate` shows a clearly non-zero value.
  2. Press `write-burst`, wait a few seconds for the sampler to catch the spike.
  3. Press `toggle-mode` to enter `cdc`. Press `write-burst` again and let it run until
     `stale-read-rate` reads `0` and `invalidation-lag-p50`/`p99` have stable values.
  4. Wait for the `tidb-direct` phase (or trigger it manually if the runner gates it on elapsed
     time) and let `redis-read-p50/p99` and `tidb-read-p50/p99` both populate.
  5. Press `hot-key-storm` and let it run its full duration so the contrast is visible on the chart.
  6. Stop the runner with Ctrl-C so the trace file is finalized.
- [ ] Inspect the resulting `demos/redis/traces/<timestamp>.json`: confirm `durationMs` covers all
      three phases and that `checks` for both `cdc-zero-stale` and `versions-converge` show `pass`.
- [ ] Promote it: `cp demos/redis/traces/<timestamp>.json demos/redis/traces/featured.json`.
- [ ] Run `pnpm lab validate redis` - expected PASS, including `eventReferenceErrors` returning no
      errors for every event in `featured.json`.
- [ ] Run `pnpm lab check-public` - expected PASS (no denylisted terms, no internal URLs, anywhere
      under `demos/redis/`).
- [ ] Commit: `git add demos/redis/traces/featured.json && git commit -m "redis demo: record featured trace"`

## 9. Risks and gotchas

- **`tiup ctl:<version> cdc cli` invocation may not match a `tiup playground`-launched TiCDC.**
  Section 4 and Task 6 flag this as unverified. If the documented `cdc cli changefeed create`
  syntax doesn't work against the version tiup prints, run `tiup ctl:<version> cdc cli
  changefeed create --help` and fix `create-changefeed.sh` before anything downstream depends on
  it - this blocks Tasks 6, 7, and 12.
- **Canal-json field names may differ from the generic Canal shape assumed in `canal.ts`.** Task 6
  captures a real message before Task 7 writes the parser specifically to avoid this; if the
  captured shape differs (for example, row values nested differently, or an extension object
  wrapping `data`), update `canal.ts` and its test fixture together, not just the fixture.
  Because `written_at_ms` lives in the row's own column data rather than a TiDB-specific
  extension field, this risk is contained to the generic Canal `data`/`table` shape, not to any
  TiDB-only protocol detail.
- **TiCDC's at-least-once delivery means the invalidator may see the same change event twice.**
  This is handled by design - `DEL` is idempotent - but if a future revision changes the
  invalidator to a cache *refresh* instead of a delete (as the demo brief allows as an
  alternative), that refresh must also be made idempotent (e.g. only write if the incoming
  `written_at_ms` is newer than what's cached), or duplicate events can put a stale value back
  after a newer one.
- **Prepared statements and connection reuse.** `mysql2`'s `pool.execute()` only engages the
  server-side prepare/plan-cache path when the same connection reuses the prepared statement;
  under heavy pool churn this may not hold as cleanly as a single persistent connection would.
  Task 8's manual verification step exists specifically to catch this before trusting the
  `tidb-read-p50/p99` numbers as "prepared plan cache" numbers in the talk track.
- **Redis TTL vs. sampler timing.** If `REDIS_DEMO_TTL_SECONDS` is set too low relative to the
  sampler's one-second tick, `ttl-only` mode may show an artificially low stale read rate simply
  because most keys expire before they're re-sampled, not because they were actually re-read
  fresh. Keep the TTL comfortably longer than the sampling tick (the `.env.example` default of 5
  seconds against a 1-second tick is intentional) so the staleness window is actually visible.
- **Docker networking on macOS.** The demo's own Redis container and the shared Kafka container
  must both join the `lab` network (already declared in both compose files) so the invalidator,
  running as a host Node process, can reach Kafka at `localhost:9092` while TiCDC (also a host
  process) publishes to the same address - do not accidentally point TiCDC's sink-uri at
  `kafka:29092` (the in-network hostname), which only containers can resolve.
- **Hot-key storm interacting with the sampler.** While the storm is active, the sampler's random
  sample of row ids may not include the hot key at all (it samples 20 random ids out of the full
  row count), so `stale-read-rate` during the storm mostly reflects the non-hot-key population.
  This is intentional - the storm's point is to compare `redis-read-p50/p99` against
  `tidb-read-p50/p99` under contention, not to stress the staleness check - but call this out in
  the live narration so the audience doesn't misread a flat staleness line during the storm.

## 10. Subagent work packets

### Packet 04-P1: Verify: TiCDC changefeed, canal-json shape, prepared plan cache
- Tasks: 6, 8 (verification steps only)
- Depends on: 00-P10   Shared runtime: tidb-playground
- Files owned: `integrations/demos/redis/infra/create-changefeed.sh`, `integrations/demos/redis/fixtures/sample-canal-json-message.json`, `integrations/docs/plans/04-redis.md` (section 4 rows only)
- Model: sonnet   Effort: M
- Gate (coordinator runs these, all must pass):
  - `./infra/tidb/playground.sh` (background) -> prints a TiDB version string
  - `docker compose -f infra/kafka/docker-compose.yml up -d` -> `lab-kafka` healthy
  - `CDC_VERSION=<printed version> demos/redis/infra/create-changefeed.sh` -> includes `Create changefeed successfully!`
  - `mysql -h 127.0.0.1 -P 4000 -u root -e "EXPLAIN SELECT id, payload, version, written_at_ms FROM cache_demo_rows WHERE id = 1;"` -> prints the real point-get operator name
  - `mysql -h 127.0.0.1 -P 4000 -u root -e "SHOW VARIABLES LIKE '%plan_cache%';"` -> prints the real prepared-plan-cache variable and value
  - `cat demos/redis/fixtures/sample-canal-json-message.json` -> one line of valid JSON with a `data` array
- Done when: all three UNVERIFIED rows in section 4 are updated with the real observed values and flipped to VERIFIED (or a recorded workaround), and the fixture file exists for Packet 04-P5 to consume.

### Packet 04-P2: keys.ts - Redis key naming
- Tasks: 3
- Depends on: 00-P10   Shared runtime: none
- Files owned: `integrations/demos/redis/runner/src/keys.ts`, `integrations/demos/redis/runner/test/keys.test.ts`
- Model: sonnet   Effort: S
- Gate (coordinator runs these, all must pass):
  - `pnpm --filter @lab/demo-redis test -- keys` -> PASS
- Done when: `redisKeyForRow` is implemented and its tests pass.

### Packet 04-P3: staleness.ts - hit ratio, staleness predicate, invalidation lag
- Tasks: 4
- Depends on: 00-P10   Shared runtime: none
- Files owned: `integrations/demos/redis/runner/src/staleness.ts`, `integrations/demos/redis/runner/test/staleness.test.ts`
- Model: sonnet   Effort: S
- Gate (coordinator runs these, all must pass):
  - `pnpm --filter @lab/demo-redis test -- staleness` -> PASS
- Done when: `computeHitRatioPercent`, `isStaleRead`, `computeInvalidationLagMs` are implemented and their tests pass.

### Packet 04-P4: mode.ts - invalidation-mode and control state machine
- Tasks: 5
- Depends on: 00-P10   Shared runtime: none
- Files owned: `integrations/demos/redis/runner/src/mode.ts`, `integrations/demos/redis/runner/test/mode.test.ts`
- Model: sonnet   Effort: S
- Gate (coordinator runs these, all must pass):
  - `pnpm --filter @lab/demo-redis test -- mode` -> PASS
- Done when: `initialDemoState`, `applyControl`, `isHotKeyStormActive` are implemented and their tests pass.

### Packet 04-P5: canal.ts - parse a canal-json message
- Tasks: 7
- Depends on: 04-P1 (needs the captured fixture)   Shared runtime: none
- Files owned: `integrations/demos/redis/runner/src/canal.ts`, `integrations/demos/redis/runner/test/canal.test.ts`
- Model: sonnet   Effort: S
- Gate (coordinator runs these, all must pass):
  - `pnpm --filter @lab/demo-redis test -- canal` -> PASS
- Done when: `parseCanalJsonMessage` matches the real captured fixture's field names and its tests pass.

### Packet 04-P6: config.ts - demo env parsing
- Tasks: 10
- Depends on: 00-P10   Shared runtime: none
- Files owned: `integrations/demos/redis/runner/src/config.ts`, `integrations/demos/redis/runner/test/config.test.ts`
- Model: sonnet   Effort: S
- Gate (coordinator runs these, all must pass):
  - `pnpm --filter @lab/demo-redis test -- config` -> PASS
- Done when: `loadDemoConfig` is implemented and its tests pass.

### Packet 04-P7: manifest, package scaffold
- Tasks: 1, 2
- Depends on: 00-P10   Shared runtime: none
- Files owned: `integrations/demos/redis/manifest.json`, `integrations/demos/redis/test/manifest.test.ts`, `integrations/demos/redis/package.json`, `integrations/demos/redis/tsconfig.json`, `integrations/demos/redis/.env.example`
- Model: sonnet   Effort: S
- Gate (coordinator runs these, all must pass):
  - `pnpm --filter @lab/demo-redis test -- manifest` -> PASS
  - `pnpm install` (from repo root) -> PASS, no missing workspace package errors
- Done when: `manifest.json` parses against `DemoManifestSchema` as demo id `redis`, number `4`, and the package scaffold resolves `@lab/contract` / `@lab/runner-kit` via `workspace:*`.

### Packet 04-P8: tidb-repo.ts - TiDB I/O adapter
- Tasks: 8 (adapter code only; verification already done by 04-P1)
- Depends on: 04-P1, 04-P7   Shared runtime: tidb-playground
- Files owned: `integrations/demos/redis/runner/src/schema.sql.ts`, `integrations/demos/redis/runner/src/tidb-repo.ts`
- Model: sonnet   Effort: M
- Gate (coordinator runs these, all must pass):
  - Manual live-run script from Task 8 -> prints `{ id: 1, payload: 'updated', version: 2, writtenAtMs: <recent ms> }`
- Done when: `initSchema`, `seedRows`, `readRowById`, `writeRowById` work against a live playground with no type assertions.

### Packet 04-P9: redis-cache.ts - Redis I/O adapter
- Tasks: 9
- Depends on: 04-P7   Shared runtime: none
- Files owned: `integrations/demos/redis/infra/docker-compose.yml`, `integrations/demos/redis/runner/src/redis-cache.ts`
- Model: sonnet   Effort: S
- Gate (coordinator runs these, all must pass):
  - `docker compose -f demos/redis/infra/docker-compose.yml up -d` -> `lab-redis-demo` running
  - Manual live-run script from Task 9 -> prints the cached JSON string, then `undefined`
- Done when: `createDemoRedisClient`, `getCachedPayload`, `setCachedPayload`, `deleteCachedPayload` work against the demo-local Redis container.

### Packet 04-P10: workload.ts - write and read loops
- Tasks: 11
- Depends on: 04-P2, 04-P4, 04-P6, 04-P8, 04-P9   Shared runtime: tidb-playground
- Files owned: `integrations/demos/redis/runner/src/workload.ts`
- Model: sonnet   Effort: M
- Gate (coordinator runs these, all must pass):
  - Manual live-run driver from Task 11 -> mostly misses on the first pass per row, then hits once each row's key is warm
- Done when: `runWriteTick`, `runCacheReadTick`, `runDirectReadTick` are implemented and exercised live against TiDB and Redis.

### Packet 04-P11: sampler.ts and invalidator.ts - staleness sampling and CDC invalidation
- Tasks: 12
- Depends on: 04-P1, 04-P5, 04-P9   Shared runtime: kafka
- Files owned: `integrations/demos/redis/runner/src/sampler.ts`, `integrations/demos/redis/runner/src/invalidator.ts`
- Model: sonnet   Effort: M
- Gate (coordinator runs these, all must pass):
  - Manual live-run from Task 12 (changefeed active, invalidator started, one write in `cdc` mode) -> `getCachedPayload` returns `undefined` immediately after the delete
- Done when: `sampleStaleness` and `runInvalidator` are implemented and a real Kafka change event drives a Redis `DEL` within a few hundred milliseconds.

### Packet 04-P12: main.ts - wire everything together and validate
- Tasks: 13, 14
- Depends on: 04-P7, 04-P8, 04-P9, 04-P10, 04-P11   Shared runtime: tidb-playground
- Files owned: `integrations/demos/redis/runner/main.ts`
- Model: sonnet   Effort: M
- Gate (coordinator runs these, all must pass):
  - `pnpm lab run redis` (from `integrations/`, with TiDB, Redis, Kafka running) -> `GET /health` returns `{"ok":true,"demo":"redis"}`
  - `pnpm lab validate redis` -> PASS, no unknown node/edge/metric/phase/check/control ids
- Done when: the runner wires config, TiDB pool, Redis client, Kafka consumer, emitter, and the `every()` loops together, and `pnpm lab validate redis` passes. If an id mismatch is found, the fix lands in `integrations/demos/redis/manifest.json` (owned by 04-P7) as a follow-up, not in this packet's files.

### Packet 04-P13: README.md and TALK-TRACK.md
- Tasks: 15, 16
- Depends on: 04-P1   Shared runtime: none
- Files owned: `integrations/demos/redis/README.md`, `integrations/demos/redis/TALK-TRACK.md`
- Model: sonnet   Effort: S
- Gate (coordinator runs these, all must pass):
  - `pnpm lab check-public` -> PASS (no denylisted terms, no internal URLs, anywhere under `integrations/demos/redis/`)
- Done when: both files exist with the real verified-facts values from 04-P1 pasted into README's "Verified facts used by this demo" section (no placeholder brackets remain).

### Packet 04-P14: Record the featured trace
- Tasks: section 8 (recording steps)
- Depends on: 04-P12, 04-P13   Shared runtime: tidb-playground, kafka
- Files owned: `integrations/demos/redis/traces/featured.json`
- Model: sonnet   Effort: M
- Gate (coordinator runs these, all must pass):
  - `pnpm lab run redis --record` driven through all three phases -> trace file written under `integrations/demos/redis/traces/`
  - `pnpm lab validate redis` -> PASS, including `eventReferenceErrors` returning no errors for every event in `featured.json`
  - `pnpm lab check-public` -> PASS
  - Teardown: `docker compose -f demos/redis/infra/docker-compose.yml down -v && docker compose -f infra/kafka/docker-compose.yml down -v && tiup clean lab`
- Done when: `integrations/demos/redis/traces/featured.json` covers all three phases, both checks (`cdc-zero-stale`, `versions-converge`) show `pass`, and teardown is confirmed with `docker ps` and `ps aux | grep '[t]iup'` showing nothing left running.
