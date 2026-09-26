# Plan 03: Debezium + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a data platform team that has already standardized on Debezium and Kafka Connect that TiDB fits both sides of that standard: as a JDBC sink target for an existing Debezium source connector, and as a Debezium-format CDC source in its own right, read by the same consumer code.

**Architecture:** Act A runs a Debezium PostgreSQL source connector against a local Postgres, through Kafka Connect, into a JDBC sink connector that writes to TiDB - a live replication path into TiDB using tooling the audience already runs. Act B creates a TiCDC changefeed with `protocol=debezium`, and the same downstream consumer that reads Act A's topic also reads this one, because both are JSON-encoded Debezium-shaped events. Act C makes a live schema change on the Postgres source and observes how the sink and the consumer each react.

**Tech Stack:** Kafka Connect (`quay.io/debezium/connect` image) running the Debezium PostgreSQL source connector and a JDBC sink connector, Postgres (`wal_level=logical`), Node 22 + TypeScript strict for the runner (heartbeat writer, Kafka Connect REST client, shared consumer, metrics), `@confluentinc/kafka-javascript` for the consumer (rationale in Plan 02, section 4; reused here without re-derivation).

**Depends on:** Plan 00 (platform: contract, runner-kit, relay, shared `infra/kafka/docker-compose.yml`, `infra/tidb/playground.sh`). This plan is buildable directly from Plan 00; it does not require Plan 02 to be implemented first. It reuses the *shared Kafka infrastructure* Plan 02 also uses (`infra/kafka/docker-compose.yml`, the `lab` Docker network), not any of Plan 02's runner code - all runner logic in this plan is self-contained under `demos/debezium/`.

---

## 1. Why this demo

- **The question customers ask:** "We've already standardized our CDC tooling on Debezium and Kafka Connect. If we move to TiDB, do we have to throw that away?"
- **Pattern:** data platform teams that have already standardized on Debezium and Kafka Connect.
- **What TiDB proves here:**
  - An existing Debezium PostgreSQL source connector can replicate live into TiDB through a stock JDBC sink connector, no custom sink code.
  - TiDB itself can emit Debezium-shaped events through TiCDC, so a team's existing Debezium consumer code needs no rewrite to also consume changes from TiDB.
  - A live schema change on the source (`ALTER TABLE ... ADD COLUMN`) propagates through the pipeline, and this demo shows exactly what happens at the sink and the consumer when it does, including where it does not automatically evolve.
- **What this demo does not claim:** TiCDC's Debezium protocol output is not byte-for-byte identical to real Debezium output (it adds `CommitTs`/`ClusterID` fields and reports `"connector": "TiCDC"`, not `"mysql"` or `"postgresql"`); this demo's consumer is written to tolerate that, it does not claim a stock Debezium connector-framework consumer works unmodified. This is not a full logical-migration cutover guide (no dual-write/cutover-point tooling is shown).

## 2. What the audience sees

### Flow diagram

```
Act A (migration path):
[postgres] --wal_level=logical--> [debezium-pg-source] --msgs/s--> [(pg-changes)] --msgs/s--> [jdbc-sink] --rows/s--> [tidb]

Act B (TiDB as source):
[tidb] --rows/s--> [ticdc-debezium] --msgs/s--> [(tidb-changes-dbz)] --msgs/s--> [consumer]

Both (pg-changes) and (tidb-changes-dbz) are read by the same [consumer] node.
```

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | warm-up | Warming up | Kafka Connect, Postgres, and TiDB come up; both connectors are created and reach `RUNNING`. | "This is the Debezium and Kafka Connect stack most data platform teams already run. We're not changing anything about it - we're changing what's on each end." |
| 2 | act-a-replication | Act A: live replication into TiDB | Rows written to Postgres flow through the Debezium source connector and the JDBC sink connector into TiDB, with a heartbeat-based replication lag measurement. | "Postgres is the source of truth today. Every row that lands there is in TiDB within milliseconds, through the same JDBC sink connector you'd point at any relational target." |
| 3 | act-b-tidb-as-source | Act B: TiDB as a Debezium source | The TiCDC changefeed with `protocol=debezium` starts publishing TiDB's own changes, and the same consumer process reads them. | "Now flip it: TiDB is the source. TiCDC speaks Debezium's message format, so the exact same consumer code reads changes from TiDB." |
| 4 | act-c-schema-change | Act C: schema change | `ALTER TABLE accounts ADD COLUMN risk_tier VARCHAR(16)` runs against Postgres; the demo shows the JDBC sink connector reacting (schema evolution) and times the propagation. | "We add a column live, on the source. Watch how long it takes to show up as a real column in TiDB, and watch the consumer's parse rate while the schema is changing underneath it." |
| 5 | wrap-up | Wrap-up | Load tapers off; checks are shown. | "One consumer, two topics, two very different origins - Postgres and TiDB - both spoken in Debezium's own format." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `insert-burst` | Insert burst on Postgres | Inserts 200 rows into the Postgres `accounts` table over a few seconds, to make Act A's replication lag visible. |
| `start-ticdc-debezium` | Start TiCDC Debezium changefeed | Creates the `debezium-tidb-source` changefeed via the TiCDC OpenAPI v2 if it does not already exist, moving the demo into Act B. |
| `add-column` | Add column on Postgres | Runs the `ALTER TABLE accounts ADD COLUMN risk_tier VARCHAR(16)` statement against Postgres, moving the demo into Act C. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `postgres-rows-equal-tidb-rows-act-a` | Postgres row count equals TiDB row count (Act A) | `pass` when `SELECT COUNT(*) FROM accounts` on Postgres equals `SELECT COUNT(*) FROM accounts` on TiDB, sampled once inserts are idle. |
| `consumer-parses-both-topics` | Consumer parses both topics without error | `pass` when the shared consumer's cumulative parse-failure count is zero across both `pg-changes` and `tidb-changes-dbz` for the run so far. |
| `schema-change-propagated` | Schema change propagated to the sink | `pass` when `risk_tier` appears in `DESCRIBE accounts` on TiDB, with `observed` set to the measured propagation time. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `connect-task-status-source` | Source connector task status | count | tile | higher | `GET /connectors/postgres-source/status` on the Kafka Connect REST API; emitted as `1` when every task's `state` is `RUNNING`, else `0`. |
| `connect-task-status-sink` | Sink connector task status | count | tile | higher | Same computation against `GET /connectors/tidb-sink/status`. |
| `records-per-sec-source` | Source connector records/s | rows/s | both | higher | Difference in the source connector's Postgres WAL LSN-derived row count between ticks (rows inserted into `accounts` since the previous tick, read from the runner's own insert counter, cross-checked against Kafka Connect's own per-connector metrics if exposed by the JMX/REST metrics endpoint in use), divided by tick seconds. |
| `records-per-sec-sink` | Sink connector records/s | rows/s | both | higher | Rows affected by the JDBC sink connector into TiDB per tick, measured as the delta in `SELECT COUNT(*) FROM accounts` on TiDB between ticks, divided by tick seconds. |
| `replication-lag-ms` | Replication lag (heartbeat) | ms | both | lower | A heartbeat row is upserted into a dedicated `heartbeat` table on Postgres once per second with the source's commit time; lag is `(time the row is observed in TiDB) - (heartbeat's source commit time)`, read back from TiDB. |
| `consumer-parse-success-rate` | Consumer parse success rate | % | tile | higher | `(messages successfully parsed as Debezium-shaped JSON) / (total messages consumed)` over the run so far, across both topics. |
| `schema-change-propagation-ms` | Schema change propagation time | ms | tile | lower | Wall-clock time from the `add-column` control being pressed to `risk_tier` first appearing in `INFORMATION_SCHEMA.COLUMNS` on TiDB, polled once per tick. |

`group` conventions used in the manifest: `status` for the two connector-status metrics, `throughput` for the two records/s metrics, `lag` for replication-lag-ms and schema-change-propagation-ms, `correctness` for consumer-parse-success-rate.

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| Debezium's PostgreSQL connector requires `wal_level=logical` on the source Postgres, plus enough `max_wal_senders` and `max_replication_slots` for the replication slot it creates. | [Debezium connector for PostgreSQL](https://debezium.io/documentation/reference/stable/connectors/postgresql.html) | Verified |
| The Debezium JDBC sink connector consumes native Debezium change events directly (no `ExtractNewRecordState` SMT needed), and supports `insert.mode=upsert` for idempotent writes, `delete.enabled=true` (requires `primary.key.fields` set to something other than `none`) for delete/tombstone handling, and `schema.evolution=basic` for automatically adding new columns at the sink when the source schema changes. | [Debezium connector for JDBC](https://debezium.io/documentation/reference/stable/connectors/jdbc.html) | Verified |
| The Confluent/Apache Kafka Connect JDBC Sink connector (a separate project from Debezium's own JDBC sink) needs the `ExtractNewRecordState` SMT to flatten Debezium's envelope, and needs `delete.enabled=true` explicitly to turn tombstones into deletes. This plan uses Debezium's own JDBC sink connector instead, specifically to avoid that extra SMT configuration. | [JDBC Sink Connector for Confluent Platform](https://docs.confluent.io/kafka-connectors/jdbc/current/sink-connector/overview.html) | Verified |
| Whether Debezium's JDBC sink connector's `dialect` auto-detection or an explicit MySQL-compatible dialect setting works correctly against TiDB (rather than real MySQL or Postgres) is not confirmed by the pages fetched for this plan. | n/a | **UNVERIFIED** - before Task 6, connect the JDBC sink connector to the running TiDB playground with `connection.url=jdbc:mysql://127.0.0.1:4000/lab` and confirm `CREATE TABLE`/upsert/delete SQL the connector generates is accepted by TiDB without dialect errors; record the exact `dialect.name` value (if set) that worked. |
| TiCDC has supported sending Kafka messages in Debezium format since TiDB/TiCDC v8.0.0, but the classic TiCDC architecture only supports DML (Row Changed) events and ignores DDL and WATERMARK events entirely. The new TiCDC architecture (from v8.5.4-release.1, enabled with `newarch=true`) additionally supports DDL and WATERMARK events in Debezium format. | [TiCDC Debezium Protocol](https://docs.pingcap.com/tidb/stable/ticdc-debezium/) | Verified |
| TiCDC's Debezium output adds two fields not in standard Debezium messages, `CommitTs` and `ClusterID`, and reports `"connector": "TiCDC"` rather than a real database connector name; schema information can be dropped with `debezium-disable-schema=true`. | [TiCDC Debezium Protocol](https://docs.pingcap.com/tidb/stable/ticdc-debezium/) | Verified |
| Whether the exact tiup-playground-installed TiCDC version defaults to the classic or the new architecture (and therefore whether Act C's DDL propagates through the TiCDC-Debezium topic at all without `newarch=true`) is not confirmed by the pages fetched for this plan. | n/a | **UNVERIFIED** - before Task 9, run `cdc version` against the playground's TiCDC binary and check whether `newarch` is available/needed as a changefeed or server config; if DDL events are not supported without it, Act C's narration must say so explicitly rather than imply DDL flows through both topics identically. |
| TiDB Cloud Dedicated's Debezium output format (for its own Kafka changefeed sink) requires cluster version v8.1.0 or later. | [Sink to Apache Kafka (TiDB Cloud)](https://docs.pingcap.com/tidbcloud/changefeed-sink-to-apache-kafka/) | Verified |
| The Kafka Connect REST API exposes `GET /connectors/{name}/status` (connector + per-task state: `RUNNING`, `PAUSED`, `FAILED`, `UNASSIGNED`) and `GET /connectors/{name}/tasks`, and Kafka Connect's REST endpoint defaults to port 8083. | [Kafka Connect REST Interface](https://docs.confluent.io/platform/current/connect/references/restapi.html), [Kafka Connect 101: the REST API](https://developer.confluent.io/courses/kafka-connect/rest-api/) | Verified (documented on Confluent's docs, which describe the same Kafka Connect REST API shipped in Apache Kafka; exact response field names for this specific Kafka Connect version are **UNVERIFIED** against Apache Kafka's own reference until Task 4's manual step is run) |
| The official Debezium Kafka Connect worker image, preloaded with all Debezium connectors, moved from Docker Hub to `quay.io/debezium/connect`. | [Debezium blog: new images available only on Quay.io](https://debezium.io/blog/2023/04/25/container-images-quayio/), [Debezium blog: moving container images to quay.io](https://debezium.io/blog/2024/09/18/quay-io-reminder/) | Verified |
| The Debezium JDBC sink connector is not bundled in the base `quay.io/debezium/connect` image by default; it must be added to the Connect worker's plugin path. | [Debezium connector for JDBC](https://debezium.io/documentation/reference/stable/connectors/jdbc.html) | **UNVERIFIED** - confirm the exact plugin artifact/version to mount and whether the current `quay.io/debezium/connect` tag already bundles it, by checking the image's `/kafka/connect` plugin directory listing at build time (`docker run --rm quay.io/debezium/connect:<tag> ls /kafka/connect`). |

## 5. Prerequisites, cost, and teardown

- Accounts and access: none for the local variant (everything runs in Docker/tiup). A TiDB Cloud Dedicated cluster (v8.1.0+ for the Debezium sink format) is only needed if replaying Act B against TiDB Cloud instead of the local playground.
- Local tools: Docker Desktop, tiup, Node 22, pnpm, `mysql` and `psql` CLI clients for manual verification.
- Cost model: local variant costs nothing beyond compute. No hardcoded prices; if pointed at TiDB Cloud Dedicated, node time and (for Act B) TiCDC RCUs bill as described in Plan 02, section 5.
- Teardown:
  - `curl -X DELETE http://127.0.0.1:8083/connectors/postgres-source` and `curl -X DELETE http://127.0.0.1:8083/connectors/tidb-sink` (removes both Kafka Connect connectors).
  - `cdc cli changefeed remove --changefeed-id=debezium-tidb-source --server=http://127.0.0.1:8300` (removes the TiCDC changefeed created in Act B).
  - `docker compose -f demos/debezium/infra/docker-compose.yml down -v` (removes Kafka Connect and Postgres containers and volumes).
  - `docker compose -f infra/kafka/docker-compose.yml down -v` (removes the shared Kafka broker, if not still needed by another running demo).
  - `tiup clean lab` (removes the local TiDB playground's data directory).

## 6. File structure

```
demos/debezium/
  manifest.json                 DemoManifestSchema instance for this demo
  package.json                  "@lab/demo-debezium", depends on @lab/contract + @lab/runner-kit (workspace:*) + @confluentinc/kafka-javascript + pg
  tsconfig.json                 extends ../../tsconfig.base.json
  README.md                     what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md                 presenter script per phase, discovery questions, objections and answers
  .env.example                  standard TIDB_*/LAB_ENV_* block plus POSTGRES_*, KAFKA_CONNECT_API, TICDC_API
  infra/
    docker-compose.yml          demo-local compose: Postgres (wal_level=logical) + Kafka Connect (quay.io/debezium/connect, JDBC sink plugin mounted), joins the shared `lab` network from infra/kafka/docker-compose.yml
    connect-plugins/            local directory mounted into the Connect container for the Debezium JDBC sink connector jar(s)
  runner/
    main.ts                     entry point: wires connector lifecycle, heartbeat writer, shared consumer, phases, controls
    src/
      debeziumEnvelope.ts         pure: parseDebeziumEnvelope (works for both real Debezium and TiCDC's Debezium output)
      heartbeat.ts                 pure: buildHeartbeatUpsertSql, computeHeartbeatLagMs
      connectStatus.ts              pure: summarizeConnectorStatus (RUNNING/PAUSED/FAILED -> 1/0)
      parseRate.ts                   pure: createParseRateTracker (success/total counters -> percentage)
      schemaPropagation.ts            pure: computeSchemaPropagationMs
      connectApi.ts                    thin I/O: fetch wrappers over the Kafka Connect REST API (create/status/delete connector)
      ticdcApi.ts                      thin I/O: fetch wrappers over the TiCDC OpenAPI v2 (reused pattern from Plan 02, written fresh here since this plan is self-contained)
      postgresClient.ts                 thin I/O: pg Pool wrapper for inserts, heartbeats, and the ALTER TABLE statement
      kafkaConsumer.ts                   thin I/O: shared consumer over @confluentinc/kafka-javascript for both topics
    test/
      debeziumEnvelope.test.ts
      heartbeat.test.ts
      connectStatus.test.ts
      parseRate.test.ts
      schemaPropagation.test.ts
  test/
    manifest.test.ts             parses manifest.json with DemoManifestSchema
  traces/
    featured.json                the recording the website plays (committed after capture)
```

## 7. Tasks

### Task 1: Scaffold the demo package and a failing manifest test

- [ ] Create `demos/debezium/package.json`:

```json
{
  "name": "@lab/demo-debezium",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "@confluentinc/kafka-javascript": "^1.0.0",
    "pg": "^8.12.0",
    "mysql2": "^3.11.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "typescript": "^5.5.0",
    "@types/pg": "^8.11.0"
  },
  "scripts": {
    "test": "vitest run",
    "start": "tsx runner/main.ts"
  }
}
```

- [ ] Create `demos/debezium/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["runner", "test"]
}
```

- [ ] Write the failing test `demos/debezium/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('debezium demo manifest', () => {
  it('parses as a valid DemoManifest', () => {
    const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8');
    const result = DemoManifestSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test` - expected FAIL (`manifest.json` does not exist).

- [ ] Create `demos/debezium/manifest.json`:

```json
{
  "id": "debezium",
  "number": 3,
  "title": "Debezium: Postgres in, TiDB out, one consumer",
  "tagline": "A stock Debezium and Kafka Connect stack replicates into TiDB, and TiDB speaks the same Debezium format back out.",
  "integrations": ["Debezium", "Kafka Connect", "TiCDC", "PostgreSQL"],
  "pattern": "data platform teams that have already standardized on Debezium and Kafka Connect",
  "publish": true,
  "runner": { "command": ["tsx", "runner/main.ts"], "cwd": "." },
  "nodes": [
    { "id": "postgres", "label": "PostgreSQL", "kind": "source", "x": 5, "y": 20 },
    { "id": "debezium-pg-source", "label": "Debezium PG source", "kind": "service", "x": 20, "y": 20 },
    { "id": "pg-changes-topic", "label": "pg-changes topic", "kind": "queue", "x": 35, "y": 20 },
    { "id": "jdbc-sink", "label": "JDBC sink", "kind": "service", "x": 48, "y": 20 },
    { "id": "tidb", "label": "TiDB", "kind": "tidb", "x": 55, "y": 50 },
    { "id": "ticdc-debezium", "label": "TiCDC (debezium)", "kind": "service", "x": 68, "y": 65 },
    { "id": "tidb-changes-topic", "label": "tidb-changes-dbz topic", "kind": "queue", "x": 82, "y": 65 },
    { "id": "consumer", "label": "Shared consumer", "kind": "sink", "x": 95, "y": 42 }
  ],
  "edges": [
    { "id": "capture-pg", "from": "postgres", "to": "debezium-pg-source", "label": "WAL changes captured", "unit": "rows/s" },
    { "id": "publish-pg", "from": "debezium-pg-source", "to": "pg-changes-topic", "label": "changes published", "unit": "msgs/s" },
    { "id": "consume-pg-sink", "from": "pg-changes-topic", "to": "jdbc-sink", "label": "changes consumed", "unit": "msgs/s" },
    { "id": "write-tidb", "from": "jdbc-sink", "to": "tidb", "label": "rows written", "unit": "rows/s" },
    { "id": "capture-tidb", "from": "tidb", "to": "ticdc-debezium", "label": "rows captured", "unit": "rows/s" },
    { "id": "publish-tidb", "from": "ticdc-debezium", "to": "tidb-changes-topic", "label": "changes published", "unit": "msgs/s" },
    { "id": "consume-pg-topic", "from": "pg-changes-topic", "to": "consumer", "label": "changes consumed", "unit": "msgs/s" },
    { "id": "consume-tidb-topic", "from": "tidb-changes-topic", "to": "consumer", "label": "changes consumed", "unit": "msgs/s" }
  ],
  "metrics": [
    { "id": "connect-task-status-source", "label": "Source connector task status", "unit": "count", "display": "tile", "better": "higher", "group": "status", "howMeasured": "GET /connectors/postgres-source/status on the Kafka Connect REST API; 1 when every task is RUNNING, else 0." },
    { "id": "connect-task-status-sink", "label": "Sink connector task status", "unit": "count", "display": "tile", "better": "higher", "group": "status", "howMeasured": "GET /connectors/tidb-sink/status on the Kafka Connect REST API; 1 when every task is RUNNING, else 0." },
    { "id": "records-per-sec-source", "label": "Source connector records/s", "unit": "rows/s", "display": "both", "better": "higher", "group": "throughput", "howMeasured": "Rows inserted into Postgres accounts since the previous tick, divided by tick seconds." },
    { "id": "records-per-sec-sink", "label": "Sink connector records/s", "unit": "rows/s", "display": "both", "better": "higher", "group": "throughput", "howMeasured": "Delta in SELECT COUNT(*) FROM accounts on TiDB between ticks, divided by tick seconds." },
    { "id": "replication-lag-ms", "label": "Replication lag (heartbeat)", "unit": "ms", "display": "both", "better": "lower", "group": "lag", "howMeasured": "Time the heartbeat row is observed in TiDB minus the heartbeat row's source commit time, both read directly, no modeling." },
    { "id": "consumer-parse-success-rate", "label": "Consumer parse success rate", "unit": "%", "display": "tile", "better": "higher", "group": "correctness", "howMeasured": "Successfully parsed Debezium-shaped messages divided by total messages consumed, across both topics, cumulative for the run." },
    { "id": "schema-change-propagation-ms", "label": "Schema change propagation time", "unit": "ms", "display": "tile", "better": "lower", "group": "lag", "howMeasured": "Wall-clock time from the add-column control to risk_tier first appearing in INFORMATION_SCHEMA.COLUMNS on TiDB, polled once per tick." }
  ],
  "phases": [
    { "id": "warm-up", "label": "Warming up", "narration": "This is the Debezium and Kafka Connect stack most data platform teams already run. We're not changing anything about it - we're changing what's on each end." },
    { "id": "act-a-replication", "label": "Act A: live replication into TiDB", "narration": "Postgres is the source of truth today. Every row that lands there is in TiDB within milliseconds, through the same JDBC sink connector you'd point at any relational target." },
    { "id": "act-b-tidb-as-source", "label": "Act B: TiDB as a Debezium source", "narration": "Now flip it: TiDB is the source. TiCDC speaks Debezium's message format, so the exact same consumer code reads changes from TiDB." },
    { "id": "act-c-schema-change", "label": "Act C: schema change", "narration": "We add a column live, on the source. Watch how long it takes to show up as a real column in TiDB, and watch the consumer's parse rate while the schema is changing underneath it." },
    { "id": "wrap-up", "label": "Wrap-up", "narration": "One consumer, two topics, two very different origins - Postgres and TiDB - both spoken in Debezium's own format." }
  ],
  "checks": [
    { "id": "postgres-rows-equal-tidb-rows-act-a", "label": "Postgres row count equals TiDB row count", "description": "SELECT COUNT(*) FROM accounts matches on both sides once inserts are idle." },
    { "id": "consumer-parses-both-topics", "label": "Consumer parses both topics without error", "description": "Cumulative parse-failure count is zero across pg-changes and tidb-changes-dbz." },
    { "id": "schema-change-propagated", "label": "Schema change propagated to the sink", "description": "risk_tier appears in DESCRIBE accounts on TiDB, with the measured propagation time as observed." }
  ],
  "controls": [
    { "id": "insert-burst", "label": "Insert burst on Postgres", "description": "Inserts 200 rows into the Postgres accounts table over a few seconds." },
    { "id": "start-ticdc-debezium", "label": "Start TiCDC Debezium changefeed", "description": "Creates the debezium-tidb-source changefeed via the TiCDC OpenAPI v2 if it does not already exist." },
    { "id": "add-column", "label": "Add column on Postgres", "description": "Runs ALTER TABLE accounts ADD COLUMN risk_tier VARCHAR(16) against Postgres." }
  ]
}
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test` - expected PASS.
- [ ] Commit: `git add demos/debezium/package.json demos/debezium/tsconfig.json demos/debezium/manifest.json demos/debezium/test/manifest.test.ts && git commit -m "debezium demo: scaffold package and manifest"`

### Task 2: Debezium envelope parser (pure)

- [ ] Write failing test `demos/debezium/runner/test/debeziumEnvelope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseDebeziumEnvelope } from '../src/debeziumEnvelope';

const realDebeziumInsert = JSON.stringify({
  payload: {
    before: null,
    after: { id: 1, name: 'acct-1', risk_tier: null },
    source: { connector: 'postgresql', db: 'lab', table: 'accounts', ts_ms: 1000 },
    op: 'c',
    ts_ms: 1005,
  },
});

const ticdcDebeziumInsert = JSON.stringify({
  payload: {
    before: null,
    after: { id: 1, name: 'acct-1' },
    source: { connector: 'TiCDC', db: 'lab', table: 'accounts', ts_ms: 2000 },
    op: 'c',
    ts_ms: 2005,
    CommitTs: 439749918821711874,
    ClusterID: 'cluster-1',
  },
});

describe('parseDebeziumEnvelope', () => {
  it('parses a real Debezium message', () => {
    const parsed = parseDebeziumEnvelope(realDebeziumInsert);
    expect(parsed).toEqual({
      ok: true,
      connector: 'postgresql',
      table: 'accounts',
      op: 'c',
      after: { id: 1, name: 'acct-1', risk_tier: null },
      tsMs: 1005,
    });
  });

  it('parses a TiCDC-shaped Debezium message the same way', () => {
    const parsed = parseDebeziumEnvelope(ticdcDebeziumInsert);
    expect(parsed).toEqual({
      ok: true,
      connector: 'TiCDC',
      table: 'accounts',
      op: 'c',
      after: { id: 1, name: 'acct-1' },
      tsMs: 2005,
    });
  });

  it('reports malformed JSON without throwing', () => {
    expect(parseDebeziumEnvelope('not json')).toEqual({ ok: false, reason: 'invalid JSON' });
  });

  it('reports a message missing payload.source without throwing', () => {
    expect(parseDebeziumEnvelope(JSON.stringify({ payload: {} }))).toEqual({ ok: false, reason: 'missing envelope fields' });
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test debeziumEnvelope` - expected FAIL.

- [ ] Create `demos/debezium/runner/src/debeziumEnvelope.ts`:

```ts
export type ParsedEnvelope = {
  readonly ok: true;
  readonly connector: string;
  readonly table: string;
  readonly op: string;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly tsMs: number;
};

export type EnvelopeParseFailure = {
  readonly ok: false;
  readonly reason: 'invalid JSON' | 'missing envelope fields';
};

export type EnvelopeParseResult = ParsedEnvelope | EnvelopeParseFailure;

type RawEnvelope = {
  readonly payload?: {
    readonly after?: Record<string, unknown> | null;
    readonly source?: { readonly connector?: string; readonly table?: string };
    readonly op?: string;
    readonly ts_ms?: number;
  };
};

export const parseDebeziumEnvelope = (raw: string): EnvelopeParseResult => {
  let message: RawEnvelope;
  try {
    message = JSON.parse(raw) as RawEnvelope;
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
  const source = message.payload?.source;
  const op = message.payload?.op;
  const tsMs = message.payload?.ts_ms;
  if (!source?.connector || !source.table || !op || tsMs === undefined) {
    return { ok: false, reason: 'missing envelope fields' };
  }
  return {
    ok: true,
    connector: source.connector,
    table: source.table,
    op,
    after: message.payload?.after ?? null,
    tsMs,
  };
};
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test debeziumEnvelope` - expected PASS.
- [ ] Commit: `git add demos/debezium/runner/src/debeziumEnvelope.ts demos/debezium/runner/test/debeziumEnvelope.test.ts && git commit -m "debezium demo: pure envelope parser for real and TiCDC Debezium output"`

### Task 3: Heartbeat SQL and lag computation (pure)

- [ ] Write failing test `demos/debezium/runner/test/heartbeat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHeartbeatUpsertSql, computeHeartbeatLagMs } from '../src/heartbeat';

describe('buildHeartbeatUpsertSql', () => {
  it('builds an upsert for a single heartbeat row keyed by id=1', () => {
    const built = buildHeartbeatUpsertSql({ sourceCommitMs: 5000 });
    expect(built.sql).toBe(
      'INSERT INTO heartbeat (id, source_commit_ms) VALUES (1, ?) ON DUPLICATE KEY UPDATE source_commit_ms = VALUES(source_commit_ms)',
    );
    expect(built.params).toEqual([5000]);
  });
});

describe('computeHeartbeatLagMs', () => {
  it('returns the gap between observed time and the heartbeat source commit time', () => {
    expect(computeHeartbeatLagMs({ observedAtMs: 5300, sourceCommitMs: 5000 })).toBe(300);
  });

  it('floors negative results at zero for clock-skew safety', () => {
    expect(computeHeartbeatLagMs({ observedAtMs: 4800, sourceCommitMs: 5000 })).toBe(0);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test heartbeat` - expected FAIL.

- [ ] Create `demos/debezium/runner/src/heartbeat.ts`:

```ts
export type BuiltSql = {
  readonly sql: string;
  readonly params: readonly number[];
};

export const buildHeartbeatUpsertSql = (options: { readonly sourceCommitMs: number }): BuiltSql => ({
  sql: 'INSERT INTO heartbeat (id, source_commit_ms) VALUES (1, ?) ON DUPLICATE KEY UPDATE source_commit_ms = VALUES(source_commit_ms)',
  params: [options.sourceCommitMs],
});

export type HeartbeatLagInput = {
  readonly observedAtMs: number;
  readonly sourceCommitMs: number;
};

export const computeHeartbeatLagMs = (input: HeartbeatLagInput): number =>
  Math.max(0, input.observedAtMs - input.sourceCommitMs);
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test heartbeat` - expected PASS.
- [ ] Commit: `git add demos/debezium/runner/src/heartbeat.ts demos/debezium/runner/test/heartbeat.test.ts && git commit -m "debezium demo: pure heartbeat SQL and lag computation"`

### Task 4: Connector status summarizer (pure)

- [ ] Write failing test `demos/debezium/runner/test/connectStatus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { summarizeConnectorStatus } from '../src/connectStatus';

describe('summarizeConnectorStatus', () => {
  it('returns 1 when every task is RUNNING', () => {
    const status = { connector: { state: 'RUNNING' }, tasks: [{ id: 0, state: 'RUNNING' }, { id: 1, state: 'RUNNING' }] };
    expect(summarizeConnectorStatus(status)).toBe(1);
  });

  it('returns 0 when any task is not RUNNING', () => {
    const status = { connector: { state: 'RUNNING' }, tasks: [{ id: 0, state: 'RUNNING' }, { id: 1, state: 'FAILED' }] };
    expect(summarizeConnectorStatus(status)).toBe(0);
  });

  it('returns 0 when there are no tasks', () => {
    expect(summarizeConnectorStatus({ connector: { state: 'RUNNING' }, tasks: [] })).toBe(0);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test connectStatus` - expected FAIL.

- [ ] Create `demos/debezium/runner/src/connectStatus.ts`:

```ts
export type ConnectorStatus = {
  readonly connector: { readonly state: string };
  readonly tasks: readonly { readonly id: number; readonly state: string }[];
};

export const summarizeConnectorStatus = (status: ConnectorStatus): number =>
  status.tasks.length > 0 && status.tasks.every((task) => task.state === 'RUNNING') ? 1 : 0;
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test connectStatus` - expected PASS.
- [ ] Commit: `git add demos/debezium/runner/src/connectStatus.ts demos/debezium/runner/test/connectStatus.test.ts && git commit -m "debezium demo: pure connector status summarizer"`

### Task 5: Parse rate tracker (pure)

- [ ] Write failing test `demos/debezium/runner/test/parseRate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createParseRateTracker } from '../src/parseRate';

describe('parse rate tracker', () => {
  it('reports 100% with no observations yet', () => {
    const tracker = createParseRateTracker();
    expect(tracker.successRatePercent()).toBe(100);
  });

  it('reports the ratio of successes to total observations', () => {
    const tracker = createParseRateTracker();
    tracker.recordSuccess();
    tracker.recordSuccess();
    tracker.recordFailure();
    expect(tracker.successRatePercent()).toBeCloseTo((2 / 3) * 100, 5);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test parseRate` - expected FAIL.

- [ ] Create `demos/debezium/runner/src/parseRate.ts`:

```ts
export type ParseRateTracker = {
  readonly recordSuccess: () => void;
  readonly recordFailure: () => void;
  readonly successRatePercent: () => number;
};

export const createParseRateTracker = (): ParseRateTracker => {
  let successCount = 0;
  let totalCount = 0;
  return {
    recordSuccess: () => {
      successCount += 1;
      totalCount += 1;
    },
    recordFailure: () => {
      totalCount += 1;
    },
    successRatePercent: () => (totalCount === 0 ? 100 : (successCount / totalCount) * 100),
  };
};
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test parseRate` - expected PASS.
- [ ] Commit: `git add demos/debezium/runner/src/parseRate.ts demos/debezium/runner/test/parseRate.test.ts && git commit -m "debezium demo: pure parse rate tracker"`

### Task 6: Schema propagation timer (pure)

- [ ] Write failing test `demos/debezium/runner/test/schemaPropagation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeSchemaPropagationMs } from '../src/schemaPropagation';

describe('computeSchemaPropagationMs', () => {
  it('returns undefined while the column has not yet appeared', () => {
    expect(computeSchemaPropagationMs({ controlPressedAtMs: 1000, columnObservedAtMs: undefined, nowMs: 1500 })).toBeUndefined();
  });

  it('returns the gap once the column has appeared', () => {
    expect(computeSchemaPropagationMs({ controlPressedAtMs: 1000, columnObservedAtMs: 1420, nowMs: 1500 })).toBe(420);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test schemaPropagation` - expected FAIL.

- [ ] Create `demos/debezium/runner/src/schemaPropagation.ts`:

```ts
export type SchemaPropagationInput = {
  readonly controlPressedAtMs: number;
  readonly columnObservedAtMs: number | undefined;
  readonly nowMs: number;
};

export const computeSchemaPropagationMs = (input: SchemaPropagationInput): number | undefined =>
  input.columnObservedAtMs === undefined ? undefined : Math.max(0, input.columnObservedAtMs - input.controlPressedAtMs);
```

- [ ] Run: `pnpm --filter @lab/demo-debezium test schemaPropagation` - expected PASS.
- [ ] Commit: `git add demos/debezium/runner/src/schemaPropagation.ts demos/debezium/runner/test/schemaPropagation.test.ts && git commit -m "debezium demo: pure schema propagation timer"`

### Task 7: Demo-local infra - Postgres and Kafka Connect (manual, I/O)

- [ ] Create `demos/debezium/infra/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    container_name: lab-debezium-postgres
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: lab
    command:
      - "postgres"
      - "-c"
      - "wal_level=logical"
      - "-c"
      - "max_wal_senders=10"
      - "-c"
      - "max_replication_slots=10"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 20
  connect:
    image: quay.io/debezium/connect:latest
    container_name: lab-debezium-connect
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "8083:8083"
    environment:
      BOOTSTRAP_SERVERS: kafka:29092
      GROUP_ID: lab-debezium-connect
      CONFIG_STORAGE_TOPIC: lab_connect_configs
      OFFSET_STORAGE_TOPIC: lab_connect_offsets
      STATUS_STORAGE_TOPIC: lab_connect_status
    volumes:
      - ./connect-plugins:/kafka/connect/debezium-jdbc-sink
networks:
  default:
    name: lab
    external: true
```

- [ ] Confirm the shared Kafka network exists (`infra/kafka/docker-compose.yml` from Plan 00 must already be running, since it creates the external `lab` network): `docker network inspect lab` - expected: no error, network exists.
- [ ] Confirm the Debezium JDBC sink connector plugin location before Task 7's compose comes up: `docker run --rm quay.io/debezium/connect:latest ls /kafka/connect` - expected output lists a `debezium-connector-jdbc` (or equivalently named) directory; if it is missing, download the matching release JAR from the [Debezium releases page](https://debezium.io/releases/) into `demos/debezium/infra/connect-plugins/` before starting the compose (this exact directory name is **UNVERIFIED** until this command is run - update this task with the confirmed name).
- [ ] Start the demo-local infra: `docker compose -f demos/debezium/infra/docker-compose.yml up -d` - expected: `lab-debezium-postgres` reports healthy, `lab-debezium-connect` is running.
- [ ] Confirm Kafka Connect's REST API is reachable: `curl -s http://127.0.0.1:8083/connectors` - expected: `[]` (no connectors yet).
- [ ] Confirm the JDBC sink plugin is loaded: `curl -s http://127.0.0.1:8083/connector-plugins | grep -i jdbc` - expected: at least one JDBC-related connector class listed.

### Task 8: Create the source table, heartbeat table, and both connectors (manual, I/O)

- [ ] Create the Postgres source table and heartbeat table:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:5432/lab" -c "
CREATE TABLE accounts (id SERIAL PRIMARY KEY, name VARCHAR(64) NOT NULL);
CREATE TABLE heartbeat (id INT PRIMARY KEY, source_commit_ms BIGINT NOT NULL);
"
```

Expected: both `CREATE TABLE` statements succeed with no error.

- [ ] Create the corresponding tables on TiDB:

```bash
mysql -h 127.0.0.1 -P 4000 -u root -e "
CREATE DATABASE IF NOT EXISTS lab;
USE lab;
CREATE TABLE accounts (id BIGINT PRIMARY KEY, name VARCHAR(64) NOT NULL);
CREATE TABLE heartbeat (id BIGINT PRIMARY KEY, source_commit_ms BIGINT NOT NULL);
"
```

Expected: no error; `SHOW TABLES;` lists both tables.

- [ ] Register the Debezium PostgreSQL source connector:

```bash
curl -s -X POST http://127.0.0.1:8083/connectors -H "content-type: application/json" -d '{
  "name": "postgres-source",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "postgres",
    "database.password": "postgres",
    "database.dbname": "lab",
    "plugin.name": "pgoutput",
    "topic.prefix": "pg",
    "table.include.list": "public.accounts,public.heartbeat"
  }
}'
```

Expected: `HTTP/1.1 201 Created` and a JSON body echoing the config.

- [ ] Confirm the source connector reaches `RUNNING`: `curl -s http://127.0.0.1:8083/connectors/postgres-source/status` - expected: `connector.state` and every entry in `tasks[].state` equal `"RUNNING"`.
- [ ] Register the Debezium JDBC sink connector (dialect and exact class name to be confirmed against Task 7's plugin-listing step; the values below are the documented defaults):

```bash
curl -s -X POST http://127.0.0.1:8083/connectors -H "content-type: application/json" -d '{
  "name": "tidb-sink",
  "config": {
    "connector.class": "io.debezium.connector.jdbc.JdbcSinkConnector",
    "topics": "pg.public.accounts,pg.public.heartbeat",
    "connection.url": "jdbc:mysql://host.docker.internal:4000/lab",
    "connection.username": "root",
    "connection.password": "",
    "insert.mode": "upsert",
    "primary.key.mode": "record_key",
    "primary.key.fields": "id",
    "delete.enabled": "true",
    "schema.evolution": "basic"
  }
}'
```

Expected: `HTTP/1.1 201 Created`.

- [ ] Confirm the sink connector reaches `RUNNING`: `curl -s http://127.0.0.1:8083/connectors/tidb-sink/status` - expected: every `tasks[].state` equal `"RUNNING"`. If it instead shows `FAILED`, read `tasks[0].trace` in the response for the exact JDBC/dialect error and resolve it before proceeding (this is the manual verification step for the JDBC-sink-against-TiDB **UNVERIFIED** item in section 4).
- [ ] Insert one row on Postgres and confirm it lands in TiDB: `psql "postgresql://postgres:postgres@127.0.0.1:5432/lab" -c "INSERT INTO accounts (name) VALUES ('acct-1');"` then, after a few seconds, `mysql -h 127.0.0.1 -P 4000 -u root -e "SELECT * FROM lab.accounts;"` - expected: one row, `name = 'acct-1'`.

### Task 9: Create the TiCDC Debezium changefeed (manual, I/O)

- [ ] Confirm the TiCDC binary's architecture and Debezium DDL support before relying on Act C (see the **UNVERIFIED** item in section 4): `cdc version` - record the version string for `LAB_ENV_TIDB`/notes.
- [ ] Create the changefeed:

```bash
cdc cli changefeed create \
  --server=http://127.0.0.1:8300 \
  --sink-uri="kafka://127.0.0.1:9092/tidb-changes-dbz?protocol=debezium&kafka-version=3.0.0&partition-num=3&max-message-bytes=10485760&replication-factor=1" \
  --changefeed-id="debezium-tidb-source"
```

Expected: `Create changefeed successfully!` with `"state":"normal"` in the returned `Info` block.

- [ ] Confirm messages arrive in Debezium format: `kafka-console-consumer.sh --bootstrap-server 127.0.0.1:9092 --topic tidb-changes-dbz --from-beginning --max-messages 1` - expected: one JSON message whose `payload.source.connector` is `"TiCDC"`.

### Task 10: Thin I/O adapters

- [ ] Create `demos/debezium/runner/src/connectApi.ts`:

```ts
export type ConnectorStatusResponse = {
  readonly connector: { readonly state: string };
  readonly tasks: readonly { readonly id: number; readonly state: string }[];
};

export type ConnectApi = {
  readonly getStatus: (name: string) => Promise<ConnectorStatusResponse>;
};

export const createConnectApi = (options: { readonly baseUrl: string }): ConnectApi => {
  const getStatus = async (name: string): Promise<ConnectorStatusResponse> => {
    const response = await fetch(`${options.baseUrl}/connectors/${name}/status`);
    return (await response.json()) as ConnectorStatusResponse;
  };
  return { getStatus };
};
```

Manual verification: `pnpm --filter @lab/demo-debezium exec tsx -e "import('./runner/src/connectApi').then(async m => { const api = m.createConnectApi({baseUrl:'http://127.0.0.1:8083'}); console.log(await api.getStatus('postgres-source')); })"` - expected output an object with `connector.state: 'RUNNING'`.

- [ ] Create `demos/debezium/runner/src/ticdcApi.ts`:

```ts
export type TicdcApi = {
  readonly changefeedExists: (id: string) => Promise<boolean>;
  readonly createDebeziumChangefeed: (options: { readonly id: string; readonly sinkUri: string }) => Promise<void>;
};

export const createTicdcApi = (options: { readonly baseUrl: string }): TicdcApi => {
  const changefeedExists = async (id: string): Promise<boolean> => {
    const response = await fetch(`${options.baseUrl}/api/v2/changefeeds/${id}`);
    return response.ok;
  };
  const createDebeziumChangefeed = async (createOptions: { readonly id: string; readonly sinkUri: string }): Promise<void> => {
    await fetch(`${options.baseUrl}/api/v2/changefeeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changefeed_id: createOptions.id, sink_uri: createOptions.sinkUri }),
    });
  };
  return { changefeedExists, createDebeziumChangefeed };
};
```

Manual verification: `pnpm --filter @lab/demo-debezium exec tsx -e "import('./runner/src/ticdcApi').then(async m => { const api = m.createTicdcApi({baseUrl:'http://127.0.0.1:8300'}); console.log(await api.changefeedExists('debezium-tidb-source')); })"` - expected output `true`.

- [ ] Create `demos/debezium/runner/src/postgresClient.ts`:

```ts
import { Pool } from 'pg';

export type PostgresClient = {
  readonly insertAccounts: (count: number) => Promise<void>;
  readonly upsertHeartbeat: (sourceCommitMs: number) => Promise<void>;
  readonly addRiskTierColumn: () => Promise<void>;
};

export const createPostgresClient = (options: { readonly connectionString: string }): PostgresClient => {
  const pool = new Pool({ connectionString: options.connectionString });
  const insertAccounts = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      await pool.query('INSERT INTO accounts (name) VALUES ($1)', [`acct-${Date.now()}-${i}`]);
    }
  };
  const upsertHeartbeat = async (sourceCommitMs: number): Promise<void> => {
    await pool.query(
      'INSERT INTO heartbeat (id, source_commit_ms) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET source_commit_ms = EXCLUDED.source_commit_ms',
      [sourceCommitMs],
    );
  };
  const addRiskTierColumn = async (): Promise<void> => {
    await pool.query('ALTER TABLE accounts ADD COLUMN risk_tier VARCHAR(16)');
  };
  return { insertAccounts, upsertHeartbeat, addRiskTierColumn };
};
```

- [ ] Create `demos/debezium/runner/src/kafkaConsumer.ts`:

```ts
import { Kafka, type Consumer } from '@confluentinc/kafka-javascript';

export type SharedConsumer = {
  readonly consumer: Consumer;
};

export const createSharedConsumer = (options: { readonly brokers: readonly string[]; readonly groupId: string }): SharedConsumer => {
  const kafka = new Kafka({ 'bootstrap.servers': options.brokers.join(',') });
  return { consumer: kafka.consumer({ 'group.id': options.groupId }) };
};
```

- [ ] Commit: `git add demos/debezium/runner/src/connectApi.ts demos/debezium/runner/src/ticdcApi.ts demos/debezium/runner/src/postgresClient.ts demos/debezium/runner/src/kafkaConsumer.ts && git commit -m "debezium demo: thin I/O adapters for Kafka Connect, TiCDC, Postgres, and the shared consumer"`

### Task 11: Wire the runner's main.ts

- [ ] Create `demos/debezium/runner/main.ts`:

```ts
import { createEmitter, every, onControl, createTidbPool } from '@lab/runner-kit';
import { createConnectApi } from './src/connectApi';
import { createTicdcApi } from './src/ticdcApi';
import { createPostgresClient } from './src/postgresClient';
import { createSharedConsumer } from './src/kafkaConsumer';
import { parseDebeziumEnvelope } from './src/debeziumEnvelope';
import { computeHeartbeatLagMs } from './src/heartbeat';
import { summarizeConnectorStatus } from './src/connectStatus';
import { createParseRateTracker } from './src/parseRate';
import { computeSchemaPropagationMs } from './src/schemaPropagation';

const emitter = createEmitter();
const pool = createTidbPool();
const connect = createConnectApi({ baseUrl: process.env.KAFKA_CONNECT_API ?? 'http://127.0.0.1:8083' });
const ticdc = createTicdcApi({ baseUrl: process.env.TICDC_API ?? 'http://127.0.0.1:8300' });
const postgres = createPostgresClient({ connectionString: process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/lab' });
const sharedConsumer = createSharedConsumer({ brokers: [process.env.KAFKA_BROKERS ?? '127.0.0.1:9092'], groupId: 'debezium-demo-consumer' });
const parseRate = createParseRateTracker();

let addColumnPressedAtMs: number | undefined;
let riskTierObservedAtMs: number | undefined;

const controller = new AbortController();

onControl((id) => {
  if (id === 'insert-burst') void postgres.insertAccounts(200);
  if (id === 'start-ticdc-debezium') {
    void ticdc.createDebeziumChangefeed({
      id: 'debezium-tidb-source',
      sinkUri: 'kafka://127.0.0.1:9092/tidb-changes-dbz?protocol=debezium&kafka-version=3.0.0',
    });
    emitter.phase('act-b-tidb-as-source');
  }
  if (id === 'add-column') {
    addColumnPressedAtMs = emitter.elapsedMs();
    void postgres.addRiskTierColumn();
    emitter.phase('act-c-schema-change');
  }
});

const runHeartbeatTick = async (): Promise<void> => {
  const sourceCommitMs = emitter.elapsedMs();
  await postgres.upsertHeartbeat(sourceCommitMs);
  const [row] = (await pool.query('SELECT source_commit_ms FROM heartbeat WHERE id = 1')) as unknown as [
    { readonly source_commit_ms: number }[],
  ];
  if (row?.[0]) {
    const lag = computeHeartbeatLagMs({ observedAtMs: emitter.elapsedMs(), sourceCommitMs: row[0].source_commit_ms });
    emitter.metric('replication-lag-ms', lag);
  }
};

const runConnectStatusTick = async (): Promise<void> => {
  const sourceStatus = await connect.getStatus('postgres-source');
  emitter.metric('connect-task-status-source', summarizeConnectorStatus(sourceStatus));
  const sinkStatus = await connect.getStatus('tidb-sink');
  emitter.metric('connect-task-status-sink', summarizeConnectorStatus(sinkStatus));
};

const runSchemaCheckTick = async (): Promise<void> => {
  if (addColumnPressedAtMs === undefined || riskTierObservedAtMs !== undefined) return;
  const [columns] = (await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'lab' AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'risk_tier'",
  )) as unknown as [{ readonly COLUMN_NAME: string }[]];
  if (columns.length > 0) {
    riskTierObservedAtMs = emitter.elapsedMs();
    const propagationMs = computeSchemaPropagationMs({
      controlPressedAtMs: addColumnPressedAtMs,
      columnObservedAtMs: riskTierObservedAtMs,
      nowMs: emitter.elapsedMs(),
    });
    if (propagationMs !== undefined) emitter.metric('schema-change-propagation-ms', propagationMs);
    emitter.check('schema-change-propagated', 'pass', `${propagationMs}ms`);
  }
};

const runConsumerTick = async (): Promise<void> => {
  const batch = await sharedConsumer.consumer.consumeBatch({ topics: ['pg.public.accounts', 'tidb-changes-dbz'], maxMessages: 500 });
  batch.forEach((message) => {
    const parsed = parseDebeziumEnvelope(message.value);
    if (parsed.ok) parseRate.recordSuccess();
    else parseRate.recordFailure();
  });
  emitter.metric('consumer-parse-success-rate', parseRate.successRatePercent());
};

void every({ intervalMs: 1000, task: runHeartbeatTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runConnectStatusTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runSchemaCheckTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runConsumerTick, signal: controller.signal });
```

- [ ] Manual run: `TIDB_HOST=127.0.0.1 KAFKA_BROKERS=127.0.0.1:9092 KAFKA_CONNECT_API=http://127.0.0.1:8083 TICDC_API=http://127.0.0.1:8300 POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/lab pnpm --filter @lab/demo-debezium start` - expected: `metric` JSON lines print once per second, `connect-task-status-source` and `connect-task-status-sink` both read `1`.
- [ ] Commit: `git add demos/debezium/runner/main.ts && git commit -m "debezium demo: wire connector monitors, heartbeat, schema check, and shared consumer"`

### Task 12: README and TALK-TRACK

- [ ] Create `demos/debezium/README.md`:

```markdown
# Debezium + TiDB: Postgres in, TiDB out, one consumer

A stock Debezium and Kafka Connect stack replicates live from PostgreSQL
into TiDB through a JDBC sink connector. Separately, TiDB emits its own
changes in Debezium's message format through TiCDC, so the same downstream
consumer code reads both.

## What it proves

- An existing Debezium PostgreSQL source connector plus a Debezium JDBC
  sink connector replicates into TiDB with no custom sink code.
- TiDB's own TiCDC changefeed can speak Debezium's format well enough that
  one consumer parses both a real Debezium topic and a TiCDC-Debezium topic.
- A live `ALTER TABLE ... ADD COLUMN` on the source is measured end to end,
  including what the sink connector's schema evolution setting does with it.

## Prerequisites

- Docker Desktop running.
- tiup installed.
- Node 22 and pnpm installed.
- `psql` and `mysql` CLI clients installed for manual verification.

## Run

1. `docker compose -f ../../infra/kafka/docker-compose.yml up -d` (shared Kafka, if not already running).
2. `../../infra/tidb/playground.sh` (local TiDB, if not already running).
3. `docker compose -f infra/docker-compose.yml up -d` (Postgres + Kafka Connect for this demo).
4. Create the source/heartbeat tables and both connectors, and the TiCDC
   Debezium changefeed (see Plan 03, Tasks 8-9, for exact commands).
5. `cp .env.example .env` and fill in the values.
6. `pnpm lab run debezium --record`.
7. Open the UI at `http://localhost:5173` and press the controls in order:
   `insert-burst`, then `start-ticdc-debezium`, then `add-column`.

## Record

`pnpm lab run debezium --record` writes `demos/debezium/traces/<timestamp>.json`.
Promote a good run: `cp demos/debezium/traces/<timestamp>.json demos/debezium/traces/featured.json`.

## Teardown

1. `curl -X DELETE http://127.0.0.1:8083/connectors/postgres-source`
2. `curl -X DELETE http://127.0.0.1:8083/connectors/tidb-sink`
3. `cdc cli changefeed remove --changefeed-id=debezium-tidb-source --server=http://127.0.0.1:8300`
4. `docker compose -f infra/docker-compose.yml down -v`
5. `docker compose -f ../../infra/kafka/docker-compose.yml down -v` (if no other demo needs it)
6. `tiup clean lab`

## Cost notes

Local run costs nothing beyond compute. No hardcoded prices; a TiDB Cloud
Dedicated variant of Act B bills node time plus TiCDC Replication Capacity
Units, same as Plan 02.
```

- [ ] Create `demos/debezium/TALK-TRACK.md`:

```markdown
# Talk track: Debezium + TiDB

## Warming up
"This is the Debezium and Kafka Connect stack most data platform teams
already run. We're not changing anything about it - we're changing what's
on each end."

## Act A: live replication into TiDB
"Postgres is the source of truth today. Every row that lands there is in
TiDB within milliseconds, through the same JDBC sink connector you'd point
at any relational target. The lag number you're watching is a heartbeat row
we write once a second - not modeled, read back directly."

## Act B: TiDB as a Debezium source
"Now flip it: TiDB is the source. TiCDC speaks Debezium's message format,
so the exact same consumer code reads changes from TiDB. It's not a
byte-identical clone of real Debezium output - TiCDC adds a couple of its
own fields - but the shape a consumer cares about is there."

## Act C: schema change
"We add a column live, on the source. Watch how long it takes to show up as
a real column in TiDB, and watch the consumer's parse rate while the schema
is changing underneath it."

## Wrap-up
"One consumer, two topics, two very different origins - Postgres and
TiDB - both spoken in Debezium's own format."

## Discovery questions

1. "What does your Kafka Connect footprint look like today - which source
   and sink connectors are you running, and against which databases?"
2. "If you migrated your primary database to TiDB tomorrow, which of your
   existing Debezium consumers would you want to keep unchanged?"
3. "How do you handle schema changes on your source database today - is
   there a coordinated migration step, or does it just flow through?"
4. "Do you have a heartbeat mechanism today to measure replication lag, or
   is that currently a blind spot?"
5. "Is Kafka Connect itself something your team operates, or is it managed
   for you (Confluent Cloud, MSK Connect, etc.)?"

## Objections and honest answers

1. "Is TiCDC's Debezium output really compatible with our existing
   consumers?"
   It is JSON-shaped like Debezium's envelope and carries the fields a
   typical consumer reads (`op`, `after`, `source.table`, `ts_ms`), but it
   is not byte-identical - it reports `connector: "TiCDC"` and adds
   `CommitTs`/`ClusterID` fields, and (depending on your TiCDC version and
   architecture) may not carry DDL events the way real Debezium does. Test
   your actual consumer against a sample topic before committing to this.
2. "Does the JDBC sink connector really not need extra configuration for
   TiDB?"
   It needs a JDBC URL pointed at TiDB's MySQL-protocol port, same as any
   MySQL-compatible target. The exact dialect behavior against TiDB is
   something this plan explicitly calls out as needing a live check
   (section 4), not an assumption.
3. "What happens to in-flight replication if Kafka Connect itself restarts?"
   This demo does not exercise a Kafka Connect worker restart; it only
   exercises connector-level restarts. Worker-level fault tolerance is a
   Kafka Connect operational question independent of the sink target.
4. "Can this run against TiDB Cloud instead of local TiDB?"
   For Act B, yes - TiDB Cloud Dedicated v8.1.0+ supports Debezium-format
   Kafka sinks. Act A (the JDBC sink) just needs a reachable JDBC endpoint,
   which TiDB Cloud Dedicated provides.
5. "Do we lose anything by not using Confluent's own JDBC sink connector?"
   You gain not needing the `ExtractNewRecordState` SMT, because Debezium's
   own JDBC sink reads its native envelope directly. You would choose
   Confluent's version if your organization already standardizes on it for
   non-Debezium sources too; that tradeoff is organizational, not technical.
```

- [ ] Commit: `git add demos/debezium/README.md demos/debezium/TALK-TRACK.md && git commit -m "debezium demo: README and talk track"`

## 8. Recording the featured trace

1. Complete Tasks 7-9 (Postgres + Kafka Connect up, both connectors `RUNNING`, TiCDC Debezium changefeed `normal`).
2. Set `.env` values: `LAB_ENV_TIDB` to the version printed by `infra/tidb/playground.sh`; `LAB_ENV_NOTES` to `"local docker compose postgres 16 + quay.io/debezium/connect + tiup playground"`.
3. Run `pnpm lab run debezium --record --port 7070`.
4. Let `warm-up` run until both connector-status metrics read `1`.
5. Press `insert-burst`; wait for `replication-lag-ms` to spike and recover, and for `records-per-sec-sink` to show throughput.
6. Press `start-ticdc-debezium`; wait for messages to appear on `tidb-changes-dbz` and for `consumer-parse-success-rate` to stay at or return to 100%.
7. Press `add-column`; wait for `schema-change-propagated` to show `pass` with an `observed` value, and confirm `consumer-parse-success-rate` does not silently drop to 0% while the schema is changing (if it does, that is worth keeping in the recording and calling out live, not editing around).
8. Let `wrap-up` run until `postgres-rows-equal-tidb-rows-act-a` and `consumer-parses-both-topics` both show `pass`.
9. Stop the run (Ctrl-C on `pnpm lab run`); confirm `demos/debezium/traces/<ISO timestamp>.json` was written.
10. Promote it: `cp demos/debezium/traces/<ISO timestamp>.json demos/debezium/traces/featured.json`.
11. `pnpm lab validate debezium` - expected: no schema errors, no `eventReferenceErrors`.
12. `pnpm lab check-public` - expected: no denylisted terms or internal URLs found.

## 9. Risks and gotchas

- **JDBC sink plugin availability is unverified (section 4):** the base `quay.io/debezium/connect` image's bundled connector set changes across releases. Confirm the plugin directory listing before recording, and pin the exact image tag used, recording it in `LAB_ENV_NOTES`.
- **TiDB dialect behavior for the JDBC sink connector is unverified (section 4):** if `connection.url=jdbc:mysql://...` triggers a MySQL-specific dialect path that assumes a real MySQL server (for example around `SHOW CREATE TABLE` parsing or auto-increment handling), the sink connector may fail in ways that look like a TiDB bug but are a dialect-detection gap. Task 8's manual step surfaces this before the recording session, not during it.
- **TiCDC architecture and Debezium DDL support is unverified (section 4):** if the playground's TiCDC does not support `newarch=true` or does not propagate DDL in Debezium format without it, Act C's schema-change narration must be adjusted to say the DDL is visible at the JDBC-sink side (Act A) but not necessarily on the TiCDC-Debezium topic (Act B) - do not claim symmetric DDL behavior across both topics without confirming it live.
- **`op` code differences:** real Debezium and TiCDC's Debezium output may not agree on every operation code fixture-for-fixture (for example update vs. read/snapshot codes). `parseDebeziumEnvelope`'s test fixtures use `"c"` (create); before recording, capture one real message from each topic and confirm the op codes the consumer needs to branch on.
- **Heartbeat table replication order:** because `accounts` and `heartbeat` are separate tables replicated independently, a heartbeat row observed in TiDB does not strictly guarantee every earlier `accounts` row has also landed; treat `replication-lag-ms` as a lag estimate for the connector pipeline as a whole, not a per-row guarantee, and say so in the talk track if asked.
- **Container networking:** the JDBC sink connector (running inside the `connect` container) reaches the host's TiDB playground via `host.docker.internal:4000` (Docker Desktop on macOS, per Plan 00's shared-infrastructure notes), not `127.0.0.1:4000` - a common setup mistake that produces a connection-refused failure that looks like a TiDB availability problem.
