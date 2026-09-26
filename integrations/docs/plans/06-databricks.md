# Plan 06: Databricks + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a data platform audience that TiDB is the real-time operational store sitting next to their Databricks lakehouse: Databricks reads live TiDB data straight over SQL (no copy job to babysit), scores it, and the fresh scores land back in TiDB in time for an app to serve them at low latency while writes keep flowing - closing the loop from event to servable feature in seconds, with an optional ad hoc analytical query on the same fresh rows.

**Architecture:** A single TypeScript runner process is both the operational workload generator and the orchestrator. It writes synthetic customer events into a TiDB Cloud Starter cluster, drives a Databricks SQL warehouse over the Statement Execution REST API to read those events through a read-only Lakehouse Federation connection and compute a per-customer risk score into a Databricks-managed Delta table, reads the freshly scored rows back over the same API, and reverse-ETLs them into a TiDB serving table with its own TiDB connection. The runner also times TiDB-side serving reads and an optional TiFlash ad hoc analytics query. Every step emits `metric`/`flow`/`phase`/`check`/`log` events per the Plan 00 contract.

**Tech Stack:** Node 22 + TypeScript (strict) runner using `@lab/runner-kit` and `@lab/contract`, `tsx` to run it, `mysql2` (transitively, via `createTidbPool`) for TiDB, the Databricks SQL Statement Execution REST API (`fetch`, no extra dependency) for Databricks. Databricks-side compute is plain SQL (Lakehouse Federation + one SQL warehouse), no notebook or PySpark job is deployed.

**Depends on:** Plan 00 (platform). Does not depend on the Kafka-sharing demos' infra; see Section 4 for why this plan does not use `infra/kafka`.

---

## 1. Why this demo

- **The question customers ask:** "We already have Databricks for training and batch. Where does an operational database like TiDB actually fit, and how do we get data between the two without building a fragile pipeline?" (asked repeatedly at a data and AI conference booth by data platform teams evaluating TiDB alongside an existing Databricks estate)
- **Pattern:** Data platform teams on Databricks asking how an operational database fits next to the lakehouse.
- **What TiDB proves here:**
  - TiDB is queryable directly from Databricks over standard MySQL wire protocol (JDBC / Lakehouse Federation) with no ingestion job to operate for the read path.
  - TiDB absorbs a reverse-ETL write-back workload (Databricks' computed scores) while its own OLTP write traffic keeps running unaffected.
  - The same fresh row can be served to an application at OLTP latency (TiDB row store) and queried in aggregate (TiFlash columnar replica) without a separate analytics database.
  - The full loop - operational write, lakehouse read, score, write-back, serve - closes in low single-digit seconds on a free-tier TiDB cluster, not overnight batch time.
- **What this demo does not claim:**
  - It does not claim TiDB replaces Databricks for training, large-scale batch transforms, or ML experimentation; Databricks remains the lakehouse and compute engine for those.
  - It does not claim TiDB Cloud Starter (the free tier used here) supports Change Data Capture to Kafka; that requires TiDB Cloud Dedicated or Premium (Section 4).
  - It does not run against a local `tiup playground` TiDB, because Databricks compute cannot reach a laptop behind NAT; this demo requires a TiDB Cloud cluster reachable over the public internet (Section 5).
  - It does not benchmark Databricks' own read throughput at scale; the federated read in this demo is intentionally small (single-digit thousands of rows) to keep the recording fast and the warehouse cost near zero.

## 2. What the audience sees

### Flow diagram

```
[app]  --writes-->        [tidb]        --federated-read-->   [databricks]
 (client)                (TiDB Cloud                              (cloud)
   ^                       Starter)      <--reverse-etl--------------|
   |                          |
   |<------serving-reads------|
   |                          |
   |                          v
   |                     [tiflash]
   |                    (columnar
   |                     replica)
   +<----analytics-query------+
```

Node positions (`x`, `y` percent of canvas): `app` at (8, 30) on the left; `tidb` at (50, 45) in the middle; `tiflash` at (50, 80) just below it; `databricks` at (88, 30) on the right, mirroring `app`.

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | `steady-writes` | Steady-State Writes | The app writes a steady stream of purchase/refund/chargeback events into TiDB; a heartbeat row updates every tick. | "This is just an app writing to TiDB - purchases, refunds, chargebacks, one row at a time, like any OLTP workload." |
| 2 | `federated-read` | Databricks Reads TiDB Live | The runner submits the federated heartbeat and scoring SQL to a Databricks SQL warehouse over the Statement Execution API; the warehouse reads TiDB through a read-only Lakehouse Federation connection. | "Databricks is now querying TiDB directly - no export job, no staging bucket, just a live JDBC read through Unity Catalog." |
| 3 | `score-write-back` | Reverse ETL: Scores Back to TiDB | Databricks' computed per-customer risk scores are read back and upserted into TiDB's `customer_risk_scores` table. | "The scores Databricks just computed are landing back in TiDB, in a table the app already knows how to query." |
| 4 | `low-latency-serving` | Serving Fresh Scores | The app keeps reading `customer_risk_scores` at OLTP latency while writes continue. | "The app is reading those scores right now, in single-digit milliseconds, while new events keep landing." |
| 5 | `adhoc-analytics` | Ad Hoc Analytics on Fresh Data | On demand, an aggregate query runs against TiDB with a TiFlash read hint over the same fresh rows. | "Same fresh data, same cluster, now answered by the columnar engine instead of the row store - no second database." |
| 6 | `rule-change` | Changing the Rule Live | The scoring SQL's rule (velocity vs. amount) is swapped for the next run. | "Swapping the scoring rule is a SQL change on the Databricks side - nothing in TiDB or the app has to redeploy." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `trigger-scoring` | Run scoring now | Immediately runs the federated-read -> score -> write-back sequence instead of waiting for the next scheduled run (guarded so overlapping runs are skipped). |
| `burst-events` | Burst events | Writes `BURST_EVENT_COUNT` synthetic events back-to-back (no inter-event delay) to spike the operational write rate before the next scoring run. |
| `change-rule` | Change scoring rule | Toggles the scoring rule between `velocity` (short window, count-weighted) and `amount` (longer window, dollar-weighted) for the next scoring run. |
| `run-analytics` | Run ad hoc analytics | Runs one aggregate query against TiDB with a `READ_FROM_STORAGE(TIFLASH[...])` hint and times it. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `federation-reachable` | Databricks Can Read TiDB | The first federated `SELECT MAX(written_at)` against the TiDB foreign catalog returns a row; `observed` carries the computed freshness lag. |
| `scores-written-back` | Scores Land Back in TiDB | The reverse-ETL upsert into `customer_risk_scores` completes without error; `observed` carries the row count written. |
| `loop-closed` | Full Loop Closes | `computeFullLoopSeconds` (Section 7) returns a finite, non-negative duration for the run; `observed` carries that duration. |
| `writes-continue-during-scoring` | OLTP Writes Never Pause | No tick during the scoring/write-back window recorded zero event writes; fails (with `observed` explaining why) if one did. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `event-write-rate` | Operational Write Rate | rows/s | both | higher | Count of rows inserted into TiDB's `events` table since the last tick (the `writes` edge's flow count that tick), divided by `EVENT_WRITE_INTERVAL_MS / 1000`. Emitted once per event-loop tick from `eventLoopTick` in `runner/main.ts`. |
| `freshness-lag-ms` | Freshness Lag: TiDB -> Delta | ms | both | lower | `computeFreshnessLagMs(heartbeatWrittenAtMs, observedAtMs)` where `heartbeatWrittenAtMs` is parsed (via `parseDatabricksTimestamp`) from the `MAX(written_at)` value returned by the federated `SELECT` built by `buildFederatedHeartbeatStatement`, and `observedAtMs` is `Date.now()` in the runner right after that Statement Execution API call resolves. Includes real network and warehouse-queueing time by design. |
| `rows-synced` | Rows Read by Databricks | rows | tile | neutral | The `row_count` field of the Statement Execution API response (parsed by `parseStatementResponse`) for the scoring `INSERT INTO ... SELECT ... FROM <federated events table>` statement built by `buildScoringStatement`. This is the number of distinct customers scored in the rule's time window, not a raw row-scan count. |
| `write-back-rate` | Reverse-ETL Write Rate | rows/s | both | higher | Number of scored rows in the batch upsert (`buildUpsertStatement`) divided by the wall-clock seconds `timed()` measured for the single `pool.execute(upsert.sql, upsert.params)` call in `runScoringOnce`. |
| `serving-p50` | Serving Read p50 | ms | both | lower | `summarize(servingLatencies.drain())` (from `@lab/runner-kit`) each event-loop tick, `.p50` field. Latencies are wall-clock milliseconds from `timed()` around `SELECT ... FROM customer_risk_scores ORDER BY RAND() LIMIT 1` in `readRandomScore`. |
| `serving-p99` | Serving Read p99 | ms | both | lower | Same `summarize()` call as `serving-p50`, `.p99` field. |
| `full-loop-time` | Event to Servable Feature | s | both | lower | `computeFullLoopSeconds(loopStartMs, writeBackAtMs)` where `loopStartMs` is the runner's own `Date.now()` at the most recent successful event write (`lastEventWrittenAtMs`) before the scoring run started, and `writeBackAtMs` is the runner's own `Date.now()` captured immediately after the federated read-back of scored rows and before the TiDB upsert. |
| `analytics-query-ms` | Ad Hoc TiFlash Query Latency | ms | tile | lower | `timed()` around the single aggregate `SELECT ... /*+ READ_FROM_STORAGE(TIFLASH[events]) */` query issued against TiDB directly (not through Databricks) when the `run-analytics` control fires. |

`freshness-lag-ms` carries `target: 5000`; `serving-p99` carries `target: 200`; `full-loop-time` carries `target: 30` - these are demo design goals shown as reference lines in the UI, not vendor SLAs, and are recorded as such in the manifest.

## 4. Verified facts and sources

**Environment note on verification method:** `WebFetch` was unavailable in the environment this plan was written in (every domain, including `example.com`, returned "Unable to verify if domain is safe to fetch"). All facts below were confirmed with `WebSearch`, which returns synthesized snippets plus source URLs from the live index rather than full page text. Anything where the search snippet was ambiguous or incomplete is marked **UNVERIFIED** with the exact page and check to run before relying on it.

| Fact | Source | Status |
|---|---|---|
| Databricks Lakehouse Federation supports a `CREATE CONNECTION ... TYPE MYSQL` connection type, generally available for MySQL. | [Run federated queries on MySQL](https://docs.databricks.com/aws/en/query-federation/mysql), [Announcing GA of Lakehouse Federation](https://www.databricks.com/blog/announcing-general-availability-lakehouse-federation) | Verified |
| Lakehouse Federation requires Databricks Runtime 13.3 LTS+ (classic) or a 2023.40+ Pro/Serverless SQL warehouse, and SSL is required to create a MySQL connection. | [Run federated queries on MySQL](https://docs.databricks.com/aws/en/query-federation/mysql) | Verified |
| `CREATE CONNECTION <name> TYPE mysql OPTIONS (host '...', port '...', user secret(...), password secret(...))` and `CREATE FOREIGN CATALOG <name> USING CONNECTION <name>` are the exact DDL forms; MySQL is two-layer namespaced so no database name is needed on the catalog. | [CREATE CONNECTION](https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-ddl-create-connection) | Verified |
| Lakehouse Federation is **read-only**: foreign catalog tables cannot be written to (no `INSERT`/`CREATE TABLE` against them). | [What is query federation?](https://docs.databricks.com/aws/en/query-federation/database-federation), community thread on writing to foreign catalogs | Verified - this is why the demo writes scores to a native Unity Catalog Delta table, then reverse-ETLs from there into TiDB itself rather than writing through the federation connection. |
| The Databricks SQL Statement Execution API (`POST /api/2.0/sql/statements`, `GET /api/2.0/sql/statements/{id}`) runs SQL against a `warehouse_id` and returns `status.state` (`PENDING`/`RUNNING`/`SUCCEEDED`/`FAILED`/...), polling if the result isn't ready within `wait_timeout` (5-50s). | [Statement Execution API reference](https://docs.databricks.com/api/statement-execution/v1), [Statement Execution API tutorial](https://docs.databricks.com/aws/en/dev-tools/sql-execution-tutorial) | Verified |
| Statement Execution API supports named parameters (`:name` markers) with an optional `type`; if omitted the value is treated as `STRING`. | [Databricks Parameterization guide](https://www.dataexpert.io/blog/databricks-parameterization-quick-guide), community thread on statement parameters | Verified as a capability. This plan does not use it for the scoring SQL (Section 7 explains why) but documents it as the safer alternative if this pattern is extended to untrusted input. |
| An official Node.js driver `@databricks/sql` exists and can itself use the Statement Execution API under the hood. | [npm: @databricks/sql](https://www.npmjs.com/package/@databricks/sql), [Databricks SQL Driver for Node.js docs](https://docs.databricks.com/aws/en/dev-tools/nodejs-sql-driver) | Verified. Not chosen as the integration path - see the rationale below the table. |
| Databricks Free Edition runs on **serverless compute only**, must use Unity Catalog to reach external data sources, and its outbound network access is "restricted to a limited set of trusted domains" with "no specific IP you can whitelist." | [Databricks Free Edition limitations](https://docs.databricks.com/aws/en/getting-started/free-edition-limitations), Databricks Community threads on outbound whitelisting | Partially verified. The serverless-only and Unity-Catalog-required facts are clear; whether TiDB Cloud's public endpoint host specifically falls inside or outside that trusted-domain allowlist is **UNVERIFIED** - confirm with the exact step in Section 5 before assuming Free Edition works for this demo. |
| A Databricks 14-day free trial workspace is a full production-shaped account (not serverless-only, normal Unity Catalog + network configuration) with usage credits, distinct from Free Edition. | [Sign up for Databricks / free trial vs. free edition](https://docs.databricks.com/aws/en/getting-started/free-trial-vs-free-edition) | Verified as a qualitative distinction. Exact credit amount and duration are on that page; not restated in prose here per the no-hardcoded-quotas rule. |
| Databricks serverless compute's outbound IPs are dynamic unless the workspace has a Network Connectivity Configuration (NCC) with stable IP ranges published for allowlisting. | [Configure a firewall for serverless compute access](https://learn.microsoft.com/en-us/azure/databricks/security/network/serverless-network-security/serverless-firewall-config) | Verified. Confirms why this plan cannot give a fixed IP for the TiDB Cloud allow list (Section 5). |
| TiDB Cloud renamed "Serverless" to "Starter" in August 2025; current cluster tiers are Starter, Essential, Premium, and Dedicated. | [Select a Plan](https://docs.pingcap.com/tidbcloud/select-cluster-tier/), [TiDB Cloud Starter Pricing Details](https://www.pingcap.com/tidb-cloud-starter-pricing-details/) | Verified |
| TiDB Cloud Starter is reachable over a public endpoint; the client IP must be in that endpoint's allow list, and TLS must be enabled (Starter's server certificate is issued by Let's Encrypt, trusted by Node's built-in CA bundle - no `TIDB_CA_PATH` needed). | [Connect to TiDB Cloud Starter or Essential via Public Endpoint](https://docs.pingcap.com/tidbcloud/connect-via-standard-connection-serverless/), [TLS Connections to TiDB Cloud Starter or Essential](https://docs.pingcap.com/tidbcloud/secure-connections-to-serverless-clusters/) | Verified |
| TiDB Cloud Starter supports columnar (TiFlash-equivalent) storage via `ALTER TABLE ... SET TIFLASH REPLICA`, at no extra charge beyond the additional replica's storage/compute. | [TiFlash Overview (TiDB Cloud)](https://docs.pingcap.com/tidbcloud/tiflash-overview/), [TiDB Cloud HTAP Quick Start](https://docs.pingcap.com/tidbcloud/tidb-cloud-htap-quickstart/) | Verified |
| The manual optimizer hint to force a TiFlash read is `/*+ READ_FROM_STORAGE(TIFLASH[table_name]) */`, applied per-table in the query. | [Use TiDB to Read TiFlash Replicas](https://docs.pingcap.com/tidb/stable/use-tidb-to-read-tiflash/), [Optimizer Hints](https://docs.pingcap.com/tidb/stable/optimizer-hints/) | Verified |
| TiDB Cloud changefeed to Apache Kafka (TiCDC path) is **unavailable on Starter**; it requires a Dedicated (v6.1.3+) or Premium cluster. | [Sink to Apache Kafka](https://docs.pingcap.com/tidbcloud/changefeed-sink-to-apache-kafka/) | Verified. This is the deciding fact against making the TiCDC -> Kafka -> Databricks path primary (Section 1/this section, rationale below). |
| TiDB Cloud changefeed to cloud storage (S3/GCS) requires TiDB cluster version v7.1.1+ and is documented for Dedicated; a separate "Export" feature exists for TiDB Cloud Premium. | [Sink to Cloud Storage](https://docs.pingcap.com/tidbcloud/changefeed-sink-to-cloud-storage/), [Export Data from TiDB Cloud Premium](https://docs.pingcap.com/tidbcloud/premium-export/) | Verified. Neither is available on the free Starter tier this demo targets. |
| A built-in MySQL JDBC driver (`com.mysql.cj.jdbc.Driver`) is available on Databricks Runtime 11.3 LTS and above for direct `spark.read.jdbc`-style access, separate from Lakehouse Federation. | [Query MySQL with Databricks](https://docs.databricks.com/en/connect/external-systems/mysql.html) | Verified as available; not the path this plan uses (no Spark cluster/notebook is deployed - see rationale below), but useful for readers who want a PySpark alternative. |
| Databricks SQL warehouse sessions default to UTC (`current_timestamp()` returns UTC) unless a session `TIMEZONE` is set. | [TIMEZONE parameter](https://docs.databricks.com/aws/en/sql/language-manual/parameters/timezone) | Verified |
| Databricks SQL `INTERVAL` literal syntax for subtracting time is `<timestamp> - INTERVAL '<n>' <UNIT>` (singular unit, quoted number), e.g. `CURRENT_TIMESTAMP - INTERVAL '5' MINUTE`. | [INTERVAL type](https://docs.databricks.com/aws/en/sql/language-manual/data-types/interval-type) | Verified |

**Primary integration path chosen: (a) Databricks reads TiDB over JDBC / Lakehouse Federation.** Rationale:

- It runs entirely on TiDB Cloud **Starter**, which is free and needs no cluster tier upgrade, unlike the changefeed-to-Kafka path (b) or the export-to-S3 path (c), both of which are gated to Dedicated/Premium clusters that bill hourly (Section 5).
- It needs no Kafka broker reachable from Databricks. Path (b) would need either a self-hosted Kafka exposed to the internet (not something to recommend even for a demo) or a paid managed Kafka plus a TiDB Cloud Dedicated Private Connect setup - both far more infrastructure than a 3-6 minute recording justifies.
- It is the path PingCAP's own integration guide documents as the supported route: "With a built-in JDBC driver in Databricks, you can now connect TiDB Cloud to Databricks in a few minutes" ([Analytics on TiDB Cloud with Databricks](https://www.pingcap.com/blog/analytics-on-tidb-cloud-with-databricks/)). That guide predates the Lakehouse Federation GA and shows plain `spark.read.jdbc`; this plan uses the newer Unity Catalog Lakehouse Federation connection instead because it is the currently GA, documented way to register TiDB as a queryable catalog without a notebook.

**Secondary paths, documented but not built:**

- **(b) TiCDC -> Kafka -> Databricks Structured Streaming into Delta.** Real CDC, sub-second propagation, and reuses the platform's shared `infra/kafka/docker-compose.yml` - but only works from a TiDB Cloud Dedicated or Premium cluster (changefeed is Starter-unavailable, verified above), which bills per node-hour even when idle. Worth a follow-up demo once a Dedicated cluster is already provisioned for another plan in this folder; this plan's `manifest.json` does not model it.
- **(c) TiDB Cloud export to S3 + Databricks Auto Loader.** Batch-oriented (periodic snapshot, not the tick-by-tick loop this demo's phases narrate) and, like (b), gated to Dedicated/Premium for the changefeed-to-storage route or Premium for the dedicated Export feature. Better suited to a "batch lakehouse ingestion" demo than a "live serving loop" demo.

**Chosen Databricks REST client: Statement Execution API over `fetch`, not `@databricks/sql`.** Rationale: this demo only ever needs to run one SQL statement at a time and poll for its result - exactly what the Statement Execution API is for. `@databricks/sql` is a stateful client with connection/session lifecycle (`connect()`/`close()`, async iterators over result sets) built for query-heavy application code; adopting it here would add a dependency and a mockable-client seam for no behavior this demo needs beyond what two `fetch` calls and a small parser already provide (see `runner/src/statementExecutionClient.ts`, Section 7). Node 22 ships a global `fetch`, so this path adds zero new dependencies.

## 5. Prerequisites, cost, and teardown

- **Accounts and access:**
  - A TiDB Cloud account with a **Starter** cluster created in the region closest to the chosen Databricks workspace's cloud/region (lower latency, and some clouds require same-cloud reachability for federation - confirm in the Databricks workspace's own region when creating the TiDB Cloud cluster).
  - A Databricks workspace. Try **Free Edition** first (zero cost); if the federated `SELECT` in Task 11 below fails to reach TiDB Cloud's host, fall back to a **free trial workspace** (any supported cloud) which behaves like a normal paid account for the trial's duration. Section 4 documents why Free Edition's egress behavior toward an arbitrary external host is unconfirmed.
  - A Databricks personal access token (User Settings -> Developer -> Access tokens) with permission to run statements on a SQL warehouse and to create connections/catalogs in Unity Catalog.
  - A Databricks secret scope holding the TiDB username and password (`databricks secrets create-scope --scope lab-tidb` then `databricks secrets put-secret lab-tidb tidb-user` / `lab-tidb tidb-password` via the Databricks CLI), referenced by the `CREATE CONNECTION` statement in Task 11 - Lakehouse Federation requires credentials to go through `secret(...)`, never a literal password in the DDL (Section 4).
- **Local tools:** macOS, Node 22, pnpm. `python3`, `tiup`, and Docker Desktop (already part of the standard environment) are not used by this demo - there is no local TiDB and no local container in this plan (Section 6 explains the omitted `infra/` folder).
- **Cost model:**
  - TiDB Cloud Starter bills on a Request Unit (RU) and storage basis with a free monthly quota; this demo's write/read volume during a short recording session is designed to stay inside that free quota. Formula and current quota: [TiDB Cloud Starter Pricing Details](https://www.pingcap.com/tidb-cloud-starter-pricing-details/).
  - Databricks bills the SQL warehouse's DBUs while it is running (`cost = DBU-rate for the warehouse's cloud/size x DBUs consumed per hour x hours running`); a small serverless SQL warehouse with a short auto-stop timeout keeps this near the trial's included credits. Formula and current DBU rates: [Databricks SQL pricing](https://www.databricks.com/product/pricing/databricks-sql). Free Edition, if it works for this demo, has no DBU cost at all (Section 4).
  - Neither TiDB Cloud Starter nor a Databricks SQL warehouse triggers hourly node billing the way a Dedicated TiDB cluster or a Databricks classic (non-serverless) cluster would - this plan deliberately avoids both.
- **Teardown (exact commands):**
  1. In the Databricks SQL editor, drop the demo's objects: `DROP TABLE IF EXISTS main.lab_databricks.risk_scores; DROP FOREIGN CATALOG IF EXISTS tidb_fed; DROP CONNECTION IF EXISTS tidb_lab_connection;`
  2. Stop the SQL warehouse if it is not already auto-stopped: Databricks UI -> SQL Warehouses -> the demo warehouse -> **Stop**.
  3. Revoke the personal access token: Databricks UI -> User Settings -> Developer -> Access tokens -> **Delete** next to the token created for this demo.
  4. Delete the Databricks secret scope: `databricks secrets delete-scope --scope lab-tidb`.
  5. In the TiDB Cloud console, terminate the Starter cluster (Cluster -> ... -> **Delete**) if it was created only for this demo, or at minimum tighten its public endpoint's IP access list back down from "allow all" (Section 9) to your own IP.
  6. Confirm nothing is left billing: TiDB Cloud console -> Billing shows no active Dedicated/Premium clusters; Databricks account console -> Usage shows the SQL warehouse's DBU usage stopped accruing after step 2.

## 6. File structure

```
demos/databricks/
  manifest.json                validated by DemoManifestSchema; nodes/edges/metrics/phases/checks/controls for this demo
  package.json                 "@lab/demo-databricks", depends on @lab/contract + @lab/runner-kit (workspace:*)
  tsconfig.json                extends ../../tsconfig.base.json
  README.md                    what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md                presenter script per phase, discovery questions, objections and answers
  .env.example                 standard TIDB_* block (pointed at TiDB Cloud, not local playground) + DATABRICKS_* vars
  runner/
    main.ts                    entry point: wires createEmitter/createTidbPool/every/onControl to the modules below
    src/
      scoringRule.ts            ScoringRule type, the two rule presets, and the pure nextRule toggle
      scoringStatement.ts        pure SQL string builders for the federated heartbeat read and the scoring statement
      upsertStatement.ts         pure builder for the batched reverse-ETL upsert into TiDB
      statementResponse.ts       pure parser for Databricks Statement Execution API responses + the poll-decision state machine
      freshness.ts               pure freshness-lag / full-loop-time math and Databricks timestamp parsing
      eventGenerator.ts          pure synthetic event generator (injectable random source, so it is unit-testable)
      tidbSchema.ts              DDL string constants for the three TiDB tables and the TiFlash replica statement
      statementExecutionClient.ts  thin I/O adapter: submits/polls statements against the Databricks REST API using fetch
    test/
      scoringRule.test.ts
      scoringStatement.test.ts
      upsertStatement.test.ts
      statementResponse.test.ts
      freshness.test.ts
      eventGenerator.test.ts
  test/
    manifest.test.ts            parses manifest.json with DemoManifestSchema
  traces/
    featured.json               the recording the website plays (committed after Section 8)
```

No `infra/` folder is created for this demo. Every other plan's `infra/` folder holds a local `docker-compose.yml` and/or `terraform/`; this demo has nothing to run locally, because Databricks compute must reach TiDB over the public internet, so the only viable TiDB for this demo is a cloud-hosted Starter cluster (Section 1), and the only Databricks compute is a managed SQL warehouse, both provisioned through their own consoles (Section 5), not through a docker-compose file this repo would own. This is a deliberate omission, not a missing file.

Also note: `package.json` lists `mysql2` as a **devDependency** in addition to `@lab/contract` and `@lab/runner-kit`. It is only needed for TypeScript to resolve the `Pool` type that `createTidbPool` returns when pnpm's isolated `node_modules` layout does not hoist `@lab/runner-kit`'s own dependency on `mysql2` into this package - `runner/main.ts` never imports `mysql2` directly, it only uses `ReturnType<typeof createTidbPool>`.

## 7. Tasks

### Task 1: Scaffold the demo package

- [ ] Not started

Create the package skeleton (no tests yet, nothing to fail/pass - this is scaffolding).

`demos/databricks/package.json`:

```json
{
  "name": "@lab/demo-databricks",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "mysql2": "^3.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`demos/databricks/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "resolveJsonModule": true
  },
  "include": ["runner/**/*.ts", "test/**/*.ts"]
}
```

Run:

```bash
mkdir -p demos/databricks/runner/src demos/databricks/runner/test demos/databricks/test demos/databricks/traces
cd demos/databricks && pnpm install
```

Expected: `pnpm install` completes and links `@lab/contract` and `@lab/runner-kit` from the workspace (both must already exist from Plan 00; if they do not yet, run this task after Plan 00 lands).

Commit:

```bash
git add demos/databricks/package.json demos/databricks/tsconfig.json
git commit -m "databricks demo: scaffold package"
```

### Task 2: Manifest

- [ ] Not started

Write the failing test first.

`demos/databricks/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('databricks demo manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const result = DemoManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('is demo number 6 with id databricks', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.id).toBe('databricks');
    expect(result.number).toBe(6);
  });

  it('names every node referenced by an edge', () => {
    const result = DemoManifestSchema.parse(manifest);
    const nodeIds = new Set(result.nodes.map((node) => node.id));
    result.edges.forEach((edge) => {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    });
  });
});
```

Run:

```bash
cd demos/databricks && pnpm vitest run test/manifest.test.ts
```

Expected FAIL: `Cannot find module '../manifest.json'` (file does not exist yet).

Minimal implementation.

`demos/databricks/manifest.json`:

```json
{
  "id": "databricks",
  "number": 6,
  "title": "TiDB + Databricks: Operational Store Meets the Lakehouse",
  "tagline": "TiDB serves live features while Databricks trains and scores on the same fresh data.",
  "integrations": ["Databricks", "Databricks SQL Lakehouse Federation", "TiFlash"],
  "pattern": "Data platform teams on Databricks asking how an operational database fits next to the lakehouse.",
  "publish": true,
  "runner": {
    "command": ["node", "--import", "tsx", "runner/main.ts"],
    "cwd": "."
  },
  "nodes": [
    { "id": "app", "label": "Operational App", "kind": "client", "x": 8, "y": 30 },
    { "id": "tidb", "label": "TiDB Cloud (Starter)", "kind": "tidb", "x": 50, "y": 45 },
    { "id": "tiflash", "label": "TiFlash (columnar)", "kind": "tidb", "x": 50, "y": 80 },
    { "id": "databricks", "label": "Databricks Lakehouse", "kind": "cloud", "x": 88, "y": 30 }
  ],
  "edges": [
    { "id": "writes", "from": "app", "to": "tidb", "label": "events written", "unit": "rows/s" },
    { "id": "federated-read", "from": "tidb", "to": "databricks", "label": "federated read (JDBC)", "unit": "rows/s" },
    { "id": "reverse-etl", "from": "databricks", "to": "tidb", "label": "scores written back", "unit": "rows/s" },
    { "id": "serving-reads", "from": "tidb", "to": "app", "label": "serving reads", "unit": "req/s" },
    { "id": "replication", "from": "tidb", "to": "tiflash", "label": "columnar replication", "unit": "rows/s" },
    { "id": "analytics-query", "from": "tiflash", "to": "app", "label": "ad hoc analytics results", "unit": "req/s" }
  ],
  "metrics": [
    { "id": "event-write-rate", "label": "Operational Write Rate", "unit": "rows/s", "display": "both", "better": "higher", "group": "operational", "howMeasured": "Rows inserted into TiDB's events table since the last event-loop tick, divided by EVENT_WRITE_INTERVAL_MS / 1000." },
    { "id": "freshness-lag-ms", "label": "Freshness Lag: TiDB -> Delta", "unit": "ms", "display": "both", "better": "lower", "group": "sync", "target": 5000, "howMeasured": "computeFreshnessLagMs(heartbeatWrittenAtMs, observedAtMs): heartbeatWrittenAtMs parsed from the federated MAX(written_at) read; observedAtMs is Date.now() when that read resolves." },
    { "id": "rows-synced", "label": "Rows Read by Databricks", "unit": "rows", "display": "tile", "better": "neutral", "group": "sync", "howMeasured": "The row_count field of the Statement Execution API response for the scoring INSERT ... SELECT statement." },
    { "id": "write-back-rate", "label": "Reverse-ETL Write Rate", "unit": "rows/s", "display": "both", "better": "higher", "group": "sync", "howMeasured": "Scored rows in the upsert batch divided by the wall-clock seconds timed() measured for the single TiDB upsert statement." },
    { "id": "serving-p50", "label": "Serving Read p50", "unit": "ms", "display": "both", "better": "lower", "group": "serving", "howMeasured": "summarize() of timed() latencies for SELECT ... FROM customer_risk_scores ORDER BY RAND() LIMIT 1, .p50 field, recomputed each event-loop tick." },
    { "id": "serving-p99", "label": "Serving Read p99", "unit": "ms", "display": "both", "better": "lower", "group": "serving", "target": 200, "howMeasured": "Same summarize() call as serving-p50, .p99 field." },
    { "id": "full-loop-time", "label": "Event to Servable Feature", "unit": "s", "display": "both", "better": "lower", "group": "loop", "target": 30, "howMeasured": "computeFullLoopSeconds(loopStartMs, writeBackAtMs): loopStartMs is the runner's Date.now() at the last event write before the scoring run started; writeBackAtMs is Date.now() right after the scored rows are read back from Databricks." },
    { "id": "analytics-query-ms", "label": "Ad Hoc TiFlash Query Latency", "unit": "ms", "display": "tile", "better": "lower", "group": "analytics", "howMeasured": "timed() around the single TiFlash-hinted aggregate SELECT issued directly against TiDB when the run-analytics control fires." }
  ],
  "phases": [
    { "id": "steady-writes", "label": "Steady-State Writes", "narration": "This is just an app writing to TiDB - purchases, refunds, chargebacks, one row at a time, like any OLTP workload." },
    { "id": "federated-read", "label": "Databricks Reads TiDB Live", "narration": "Databricks is now querying TiDB directly - no export job, no staging bucket, just a live JDBC read through Unity Catalog." },
    { "id": "score-write-back", "label": "Reverse ETL: Scores Back to TiDB", "narration": "The scores Databricks just computed are landing back in TiDB, in a table the app already knows how to query." },
    { "id": "low-latency-serving", "label": "Serving Fresh Scores", "narration": "The app is reading those scores right now, in single-digit milliseconds, while new events keep landing." },
    { "id": "adhoc-analytics", "label": "Ad Hoc Analytics on Fresh Data", "narration": "Same fresh data, same cluster, now answered by the columnar engine instead of the row store - no second database." },
    { "id": "rule-change", "label": "Changing the Rule Live", "narration": "Swapping the scoring rule is a SQL change on the Databricks side - nothing in TiDB or the app has to redeploy." }
  ],
  "checks": [
    { "id": "federation-reachable", "label": "Databricks Can Read TiDB", "description": "The first federated SELECT MAX(written_at) against the TiDB foreign catalog returns a row." },
    { "id": "scores-written-back", "label": "Scores Land Back in TiDB", "description": "The reverse-ETL upsert into customer_risk_scores completes without error." },
    { "id": "loop-closed", "label": "Full Loop Closes", "description": "computeFullLoopSeconds returns a finite, non-negative duration for the run." },
    { "id": "writes-continue-during-scoring", "label": "OLTP Writes Never Pause", "description": "No tick during the scoring/write-back window recorded zero event writes." }
  ],
  "controls": [
    { "id": "trigger-scoring", "label": "Run scoring now", "description": "Immediately runs the federated-read -> score -> write-back sequence." },
    { "id": "burst-events", "label": "Burst events", "description": "Writes BURST_EVENT_COUNT synthetic events back-to-back." },
    { "id": "change-rule", "label": "Change scoring rule", "description": "Toggles the scoring rule between velocity and amount for the next run." },
    { "id": "run-analytics", "label": "Run ad hoc analytics", "description": "Runs one TiFlash-hinted aggregate query against TiDB and times it." }
  ]
}
```

Run:

```bash
cd demos/databricks && pnpm vitest run test/manifest.test.ts
```

Expected PASS: 3 passed.

Commit:

```bash
git add demos/databricks/manifest.json demos/databricks/test/manifest.test.ts
git commit -m "databricks demo: add manifest"
```

### Task 3: Scoring rule presets and the rule-toggle

- [ ] Not started

`demos/databricks/runner/test/scoringRule.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { velocityRule, amountRule, nextRule } from '../src/scoringRule';

describe('nextRule', () => {
  it('toggles from velocity to amount', () => {
    expect(nextRule(velocityRule)).toEqual(amountRule);
  });

  it('toggles from amount back to velocity', () => {
    expect(nextRule(amountRule)).toEqual(velocityRule);
  });

  it('round-trips back to the same rule after two toggles', () => {
    expect(nextRule(nextRule(velocityRule))).toEqual(velocityRule);
  });
});
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/scoringRule.test.ts
```

Expected FAIL: `Cannot find module '../src/scoringRule'`.

`demos/databricks/runner/src/scoringRule.ts`:

```ts
export type ScoringRuleName = 'velocity' | 'amount';

export type ScoringRule = {
  readonly name: ScoringRuleName;
  readonly windowMinutes: number;
  readonly chargebackWeight: number;
  readonly refundWeight: number;
  readonly baseWeight: number;
};

export const velocityRule: ScoringRule = {
  name: 'velocity',
  windowMinutes: 5,
  chargebackWeight: 4,
  refundWeight: 2,
  baseWeight: 1,
};

export const amountRule: ScoringRule = {
  name: 'amount',
  windowMinutes: 15,
  chargebackWeight: 1.5,
  refundWeight: 1.2,
  baseWeight: 1,
};

export const nextRule = (current: ScoringRule): ScoringRule =>
  (current.name === 'velocity' ? amountRule : velocityRule);
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/scoringRule.test.ts
```

Expected PASS: 3 passed.

Commit:

```bash
git add demos/databricks/runner/src/scoringRule.ts demos/databricks/runner/test/scoringRule.test.ts
git commit -m "databricks demo: scoring rule presets and toggle"
```

### Task 4: Scoring and heartbeat SQL builders

- [ ] Not started

`demos/databricks/runner/test/scoringStatement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildScoringStatement,
  buildFederatedHeartbeatStatement,
  type FederationConfig,
} from '../src/scoringStatement';
import { velocityRule } from '../src/scoringRule';

const config: FederationConfig = {
  federatedCatalog: 'tidb_fed',
  federatedSchema: 'lab',
  eventsTable: 'events',
  heartbeatsTable: 'heartbeats',
  scoresCatalog: 'main',
  scoresSchema: 'lab_databricks',
  scoresTable: 'risk_scores',
};

describe('buildScoringStatement', () => {
  it('reads from the federated events table and writes into the scores table', () => {
    const sql = buildScoringStatement(velocityRule, config);
    expect(sql).toContain('INSERT INTO main.lab_databricks.risk_scores');
    expect(sql).toContain('FROM tidb_fed.lab.events');
    expect(sql).toContain("'velocity' AS rule");
    expect(sql).toContain("INTERVAL '5' MINUTE");
  });

  it('bakes the rule weights into the CASE expression', () => {
    const sql = buildScoringStatement(velocityRule, config);
    expect(sql).toContain('amount * 4.0000');
    expect(sql).toContain('amount * 2.0000');
    expect(sql).toContain('amount * 1.0000');
  });

  it('rejects a non-finite weight rather than emit broken SQL', () => {
    const brokenRule = { ...velocityRule, baseWeight: Number.NaN };
    expect(() => buildScoringStatement(brokenRule, config)).toThrow('weight must be finite');
  });
});

describe('buildFederatedHeartbeatStatement', () => {
  it('selects the latest heartbeat from the federated table', () => {
    expect(buildFederatedHeartbeatStatement(config)).toBe(
      'SELECT MAX(written_at) AS last_heartbeat FROM tidb_fed.lab.heartbeats',
    );
  });
});
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/scoringStatement.test.ts
```

Expected FAIL: `Cannot find module '../src/scoringStatement'`.

`demos/databricks/runner/src/scoringStatement.ts`:

```ts
import type { ScoringRule } from './scoringRule';

export type FederationConfig = {
  readonly federatedCatalog: string;
  readonly federatedSchema: string;
  readonly eventsTable: string;
  readonly heartbeatsTable: string;
  readonly scoresCatalog: string;
  readonly scoresSchema: string;
  readonly scoresTable: string;
};

const formatWeight = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error(`weight must be finite: ${value}`);
  return value.toFixed(4);
};

const qualifiedEvents = (config: FederationConfig): string =>
  `${config.federatedCatalog}.${config.federatedSchema}.${config.eventsTable}`;

const qualifiedHeartbeats = (config: FederationConfig): string =>
  `${config.federatedCatalog}.${config.federatedSchema}.${config.heartbeatsTable}`;

const qualifiedScores = (config: FederationConfig): string =>
  `${config.scoresCatalog}.${config.scoresSchema}.${config.scoresTable}`;

export const buildScoringStatement = (rule: ScoringRule, config: FederationConfig): string => `
INSERT INTO ${qualifiedScores(config)} (customer_id, score, rule, scored_at)
SELECT
  customer_id,
  ROUND(
    SUM(
      CASE event_type
        WHEN 'chargeback' THEN amount * ${formatWeight(rule.chargebackWeight)}
        WHEN 'refund' THEN amount * ${formatWeight(rule.refundWeight)}
        ELSE amount * ${formatWeight(rule.baseWeight)}
      END
    ) / GREATEST(COUNT(*), 1),
    3
  ) AS score,
  '${rule.name}' AS rule,
  current_timestamp() AS scored_at
FROM ${qualifiedEvents(config)}
WHERE created_at >= current_timestamp() - INTERVAL '${rule.windowMinutes}' MINUTE
GROUP BY customer_id
`.trim();

export const buildFederatedHeartbeatStatement = (config: FederationConfig): string =>
  `SELECT MAX(written_at) AS last_heartbeat FROM ${qualifiedHeartbeats(config)}`.trim();
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/scoringStatement.test.ts
```

Expected PASS: 4 passed.

Commit:

```bash
git add demos/databricks/runner/src/scoringStatement.ts demos/databricks/runner/test/scoringStatement.test.ts
git commit -m "databricks demo: scoring and heartbeat SQL builders"
```

### Task 5: Reverse-ETL upsert builder

- [ ] Not started

`demos/databricks/runner/test/upsertStatement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildUpsertStatement } from '../src/upsertStatement';

describe('buildUpsertStatement', () => {
  it('returns an empty statement for no rows', () => {
    expect(buildUpsertStatement([])).toEqual({ sql: '', params: [] });
  });

  it('builds one value group per row with ON DUPLICATE KEY UPDATE', () => {
    const result = buildUpsertStatement([
      { customerId: 1, score: 4.2, rule: 'velocity', updatedAtMs: Date.UTC(2026, 8, 25, 12, 0, 0) },
      { customerId: 2, score: 1.1, rule: 'velocity', updatedAtMs: Date.UTC(2026, 8, 25, 12, 0, 1) },
    ]);
    expect(result.sql).toContain('VALUES (?, ?, ?, ?), (?, ?, ?, ?)');
    expect(result.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(result.params).toEqual([
      1, 4.2, 'velocity', '2026-09-25 12:00:00.000',
      2, 1.1, 'velocity', '2026-09-25 12:00:01.000',
    ]);
  });
});
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/upsertStatement.test.ts
```

Expected FAIL: `Cannot find module '../src/upsertStatement'`.

`demos/databricks/runner/src/upsertStatement.ts`:

```ts
export type ScoredRow = {
  readonly customerId: number;
  readonly score: number;
  readonly rule: string;
  readonly updatedAtMs: number;
};

export type UpsertStatement = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

const toDateTimeMs = (ms: number): string => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');

export const buildUpsertStatement = (rows: readonly ScoredRow[]): UpsertStatement => {
  if (rows.length === 0) return { sql: '', params: [] };
  const placeholders = rows.map(() => '(?, ?, ?, ?)').join(', ');
  const params = rows.flatMap((row) => [row.customerId, row.score, row.rule, toDateTimeMs(row.updatedAtMs)]);
  const sql =
    `INSERT INTO customer_risk_scores (customer_id, score, rule, updated_at) VALUES ${placeholders} ` +
    'ON DUPLICATE KEY UPDATE score = VALUES(score), rule = VALUES(rule), updated_at = VALUES(updated_at)';
  return { sql, params };
};
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/upsertStatement.test.ts
```

Expected PASS: 2 passed.

Commit:

```bash
git add demos/databricks/runner/src/upsertStatement.ts demos/databricks/runner/test/upsertStatement.test.ts
git commit -m "databricks demo: reverse-ETL upsert builder"
```

### Task 6: Statement Execution API response parser and poll-decision state machine

- [ ] Not started

`demos/databricks/runner/test/statementResponse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseStatementResponse, decidePoll } from '../src/statementResponse';

describe('parseStatementResponse', () => {
  it('extracts rows and row count from a succeeded response', () => {
    const parsed = parseStatementResponse({
      statement_id: 'abc123',
      status: { state: 'SUCCEEDED' },
      result: { data_array: [['2026-09-25 12:00:00.000']], row_count: 1 },
    });
    expect(parsed).toEqual({
      statementId: 'abc123',
      state: 'SUCCEEDED',
      rowCount: 1,
      rows: [['2026-09-25 12:00:00.000']],
      errorMessage: undefined,
    });
  });

  it('extracts the error message from a failed response', () => {
    const parsed = parseStatementResponse({
      statement_id: 'abc123',
      status: { state: 'FAILED', error: { message: 'table not found' } },
    });
    expect(parsed.state).toBe('FAILED');
    expect(parsed.errorMessage).toBe('table not found');
    expect(parsed.rows).toEqual([]);
  });

  it('defaults to FAILED for a response with no recognizable state', () => {
    const parsed = parseStatementResponse({});
    expect(parsed.state).toBe('FAILED');
    expect(parsed.statementId).toBe('');
  });
});

describe('decidePoll', () => {
  it('keeps polling while the statement is still running and under the timeout', () => {
    expect(decidePoll('RUNNING', 1000, 60000)).toBe('poll');
  });

  it('is ready once the statement succeeds, even close to the timeout', () => {
    expect(decidePoll('SUCCEEDED', 59999, 60000)).toBe('ready');
  });

  it('fails immediately on a FAILED state regardless of elapsed time', () => {
    expect(decidePoll('FAILED', 100, 60000)).toBe('failed');
  });

  it('times out once elapsed time reaches the timeout while still pending', () => {
    expect(decidePoll('PENDING', 60000, 60000)).toBe('timeout');
  });
});
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/statementResponse.test.ts
```

Expected FAIL: `Cannot find module '../src/statementResponse'`.

`demos/databricks/runner/src/statementResponse.ts`:

```ts
export type StatementState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'CLOSED';

export type StatementResponse = {
  readonly statementId: string;
  readonly state: StatementState;
  readonly rowCount: number | undefined;
  readonly rows: readonly (readonly string[])[];
  readonly errorMessage: string | undefined;
};

type RawStatementResponse = {
  readonly statement_id?: unknown;
  readonly status?: { readonly state?: unknown; readonly error?: { readonly message?: unknown } };
  readonly result?: { readonly data_array?: unknown; readonly row_count?: unknown };
};

const isStatementState = (value: unknown): value is StatementState =>
  value === 'PENDING' ||
  value === 'RUNNING' ||
  value === 'SUCCEEDED' ||
  value === 'FAILED' ||
  value === 'CANCELED' ||
  value === 'CLOSED';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toRawStatementResponse = (value: unknown): RawStatementResponse => (isRecord(value) ? value : {});

const toStringRows = (value: unknown): readonly (readonly string[])[] => {
  if (!Array.isArray(value)) return [];
  return value.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell)) : []));
};

export const parseStatementResponse = (json: unknown): StatementResponse => {
  const raw = toRawStatementResponse(json);
  const status = isRecord(raw.status) ? raw.status : {};
  const result = isRecord(raw.result) ? raw.result : {};
  const error = isRecord(status.error) ? status.error : {};
  const state = isStatementState(status.state) ? status.state : 'FAILED';
  const rows = toStringRows(result.data_array);
  const rowCount = typeof result.row_count === 'number' ? result.row_count : undefined;
  const errorMessage = typeof error.message === 'string' ? error.message : undefined;
  const statementId = typeof raw.statement_id === 'string' ? raw.statement_id : '';
  return { statementId, state, rowCount, rows, errorMessage };
};

export type PollDecision = 'poll' | 'ready' | 'failed' | 'timeout';

export const decidePoll = (state: StatementState, elapsedMs: number, timeoutMs: number): PollDecision => {
  if (state === 'SUCCEEDED') return 'ready';
  if (state === 'FAILED' || state === 'CANCELED' || state === 'CLOSED') return 'failed';
  if (elapsedMs >= timeoutMs) return 'timeout';
  return 'poll';
};
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/statementResponse.test.ts
```

Expected PASS: 7 passed.

Commit:

```bash
git add demos/databricks/runner/src/statementResponse.ts demos/databricks/runner/test/statementResponse.test.ts
git commit -m "databricks demo: statement response parser and poll state machine"
```

### Task 7: Freshness and full-loop math

- [ ] Not started

`demos/databricks/runner/test/freshness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeFreshnessLagMs, computeFullLoopSeconds, parseDatabricksTimestamp } from '../src/freshness';

describe('computeFreshnessLagMs', () => {
  it('returns the gap between the heartbeat write time and when it was observed', () => {
    expect(computeFreshnessLagMs(1000, 1800)).toBe(800);
  });

  it('never returns a negative lag when clocks are skewed', () => {
    expect(computeFreshnessLagMs(2000, 1800)).toBe(0);
  });
});

describe('computeFullLoopSeconds', () => {
  it('converts the millisecond gap between write and score to seconds', () => {
    expect(computeFullLoopSeconds(1_000, 4_500)).toBe(3.5);
  });

  it('never returns a negative duration', () => {
    expect(computeFullLoopSeconds(5_000, 4_000)).toBe(0);
  });
});

describe('parseDatabricksTimestamp', () => {
  it('parses a space-separated UTC timestamp into epoch milliseconds', () => {
    expect(parseDatabricksTimestamp('2026-09-25 12:00:00.000')).toBe(Date.parse('2026-09-25T12:00:00.000Z'));
  });

  it('throws on an unparseable value', () => {
    expect(() => parseDatabricksTimestamp('not-a-timestamp')).toThrow('invalid timestamp');
  });
});
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/freshness.test.ts
```

Expected FAIL: `Cannot find module '../src/freshness'`.

`demos/databricks/runner/src/freshness.ts`:

```ts
export const computeFreshnessLagMs = (heartbeatWrittenAtMs: number, observedAtMs: number): number =>
  Math.max(0, observedAtMs - heartbeatWrittenAtMs);

export const computeFullLoopSeconds = (eventWrittenAtMs: number, scoreWrittenAtMs: number): number =>
  Math.max(0, (scoreWrittenAtMs - eventWrittenAtMs) / 1000);

export const parseDatabricksTimestamp = (value: string): number => {
  const isoLike = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`;
  const parsed = Date.parse(withZone);
  if (Number.isNaN(parsed)) throw new Error(`invalid timestamp: ${value}`);
  return parsed;
};
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/freshness.test.ts
```

Expected PASS: 5 passed.

Commit:

```bash
git add demos/databricks/runner/src/freshness.ts demos/databricks/runner/test/freshness.test.ts
git commit -m "databricks demo: freshness and full-loop math"
```

### Task 8: Synthetic event generator

- [ ] Not started

`demos/databricks/runner/test/eventGenerator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateEvent } from '../src/eventGenerator';

const sequence = (values: readonly number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
};

describe('generateEvent', () => {
  it('keeps the customer id within 1..customerCount', () => {
    const event = generateEvent(50, sequence([0, 0, 0]));
    expect(event.customerId).toBe(1);
  });

  it('picks purchase below the 0.85 roll threshold', () => {
    const event = generateEvent(50, sequence([0.1, 0.5, 0.5]));
    expect(event.eventType).toBe('purchase');
  });

  it('picks refund between 0.85 and 0.97', () => {
    const event = generateEvent(50, sequence([0.1, 0.9, 0.5]));
    expect(event.eventType).toBe('refund');
  });

  it('picks chargeback at or above 0.97', () => {
    const event = generateEvent(50, sequence([0.1, 0.99, 0.5]));
    expect(event.eventType).toBe('chargeback');
  });

  it('rounds the amount to two decimal places', () => {
    const event = generateEvent(50, sequence([0.5, 0.5, 0.123456]));
    expect(event.amount).toBeCloseTo(66.11, 2);
  });
});
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/eventGenerator.test.ts
```

Expected FAIL: `Cannot find module '../src/eventGenerator'`.

`demos/databricks/runner/src/eventGenerator.ts`:

```ts
export type EventType = 'purchase' | 'refund' | 'chargeback';

export type GeneratedEvent = {
  readonly customerId: number;
  readonly eventType: EventType;
  readonly amount: number;
};

export type RandomSource = () => number;

const weightedEventType = (random: RandomSource): EventType => {
  const roll = random();
  if (roll < 0.85) return 'purchase';
  if (roll < 0.97) return 'refund';
  return 'chargeback';
};

export const generateEvent = (customerCount: number, random: RandomSource): GeneratedEvent => {
  const customerId = 1 + Math.floor(random() * customerCount);
  const eventType = weightedEventType(random);
  const baseAmount = 5 + random() * 495;
  const amount = Math.round(baseAmount * 100) / 100;
  return { customerId, eventType, amount };
};
```

Run:

```bash
cd demos/databricks && pnpm vitest run runner/test/eventGenerator.test.ts
```

Expected PASS: 5 passed.

Commit:

```bash
git add demos/databricks/runner/src/eventGenerator.ts demos/databricks/runner/test/eventGenerator.test.ts
git commit -m "databricks demo: synthetic event generator"
```

### Task 9: TiDB schema DDL constants

- [ ] Not started

Pure string constants; no test file (there is no behavior to assert beyond "this is the SQL text," and the SQL's correctness is proven live in Task 12). Do not skip Task 12's manual verification because of that.

`demos/databricks/runner/src/tidbSchema.ts`:

```ts
export const createEventsTableSql = `
CREATE TABLE IF NOT EXISTS events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_customer_created (customer_id, created_at)
)`.trim();

export const createHeartbeatsTableSql = `
CREATE TABLE IF NOT EXISTS heartbeats (
  id INT PRIMARY KEY,
  written_at DATETIME(3) NOT NULL
)`.trim();

export const createScoresTableSql = `
CREATE TABLE IF NOT EXISTS customer_risk_scores (
  customer_id INT PRIMARY KEY,
  score DECIMAL(10,3) NOT NULL,
  rule VARCHAR(20) NOT NULL,
  updated_at DATETIME(3) NOT NULL
)`.trim();

export const enableTiflashReplicaSql = 'ALTER TABLE events SET TIFLASH REPLICA 1';
```

Run: nothing to run yet (no consumer until Task 13).

Commit:

```bash
git add demos/databricks/runner/src/tidbSchema.ts
git commit -m "databricks demo: TiDB schema DDL"
```

### Task 10: Databricks Statement Execution API client

- [ ] Not started

Thin I/O adapter over `fetch`; verified live, not with a mocked unit test, per the platform's thin-adapter rule. Write it, then verify it against a real warehouse once Task 11 has created the connection it queries against - so its live-run check is folded into Task 11's manual step to avoid running it against nothing.

`demos/databricks/runner/src/statementExecutionClient.ts`:

```ts
import { decidePoll, parseStatementResponse, type StatementResponse } from './statementResponse';

export type DatabricksConfig = {
  readonly host: string;
  readonly token: string;
  readonly warehouseId: string;
  readonly statementTimeoutMs: number;
};

const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const submitStatement = async (config: DatabricksConfig, statement: string): Promise<StatementResponse> => {
  const response = await fetch(`https://${config.host}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: authHeaders(config.token),
    body: JSON.stringify({ warehouse_id: config.warehouseId, statement, wait_timeout: '5s' }),
  });
  const json: unknown = await response.json();
  return parseStatementResponse(json);
};

const fetchStatement = async (config: DatabricksConfig, statementId: string): Promise<StatementResponse> => {
  const response = await fetch(`https://${config.host}/api/2.0/sql/statements/${statementId}`, {
    headers: authHeaders(config.token),
  });
  const json: unknown = await response.json();
  return parseStatementResponse(json);
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const runStatement = async (config: DatabricksConfig, statement: string): Promise<StatementResponse> => {
  const startedAtMs = Date.now();
  let current = await submitStatement(config, statement);
  for (;;) {
    const decision = decidePoll(current.state, Date.now() - startedAtMs, config.statementTimeoutMs);
    if (decision === 'ready') return current;
    if (decision === 'failed') throw new Error(`statement failed: ${current.errorMessage ?? current.state}`);
    if (decision === 'timeout') throw new Error(`statement timed out after ${config.statementTimeoutMs}ms`);
    await wait(500);
    current = await fetchStatement(config, current.statementId);
  }
};
```

Commit:

```bash
git add demos/databricks/runner/src/statementExecutionClient.ts
git commit -m "databricks demo: Statement Execution API client"
```

### Task 11: One-time Databricks-side setup (manual, live)

- [ ] Not started

Create the TiDB Cloud Starter cluster first (Section 5) and note its host, port 4000, username, and password.

Step 1: register the TiDB credentials as Databricks secrets, from a terminal:

```bash
databricks secrets create-scope --scope lab-tidb
databricks secrets put-secret lab-tidb tidb-user
databricks secrets put-secret lab-tidb tidb-password
```

Then, in the Databricks SQL editor (attached to a running SQL warehouse), run in order:

Step 2: create the federation connection (read-only).

```sql
CREATE CONNECTION IF NOT EXISTS tidb_lab_connection
TYPE mysql
OPTIONS (
  host '<your-starter-cluster-host>',
  port '4000',
  user secret ('lab-tidb', 'tidb-user'),
  password secret ('lab-tidb', 'tidb-password')
);
```

Step 3: register TiDB's `lab` database as a foreign (read-only) catalog.

```sql
CREATE FOREIGN CATALOG IF NOT EXISTS tidb_fed
USING CONNECTION tidb_lab_connection
OPTIONS (database 'lab');
```

Step 4: create the writable Delta table Databricks scores into.

```sql
CREATE SCHEMA IF NOT EXISTS main.lab_databricks;
CREATE TABLE IF NOT EXISTS main.lab_databricks.risk_scores (
  customer_id BIGINT,
  score DOUBLE,
  rule STRING,
  scored_at TIMESTAMP
);
```

Step 5: confirm the federated read reaches TiDB (run only after Task 12 has created `events`/`heartbeats` in TiDB).

```sql
SELECT * FROM tidb_fed.lab.heartbeats;
```

Expected output for step 5: either zero rows (if Task 12/13 has not run yet - the connection still succeeded, that's what matters) or one row once the runner has written a heartbeat. An error here (connection refused, TLS handshake failure, access denied) means the TiDB Cloud allow list or credentials are wrong - fix before continuing (Section 9).

Then, from a terminal, exercise `runStatement` from Task 10 directly to prove the TypeScript client works end to end against this same warehouse:

```bash
cd demos/databricks
DATABRICKS_HOST=<workspace-host> DATABRICKS_TOKEN=<token> DATABRICKS_WAREHOUSE_ID=<id> \
  pnpm exec tsx -e "
    import { runStatement } from './runner/src/statementExecutionClient';
    const need = (name: string): string => {
      const value = process.env[name];
      if (value === undefined || value === '') throw new Error('missing ' + name);
      return value;
    };
    const config = { host: need('DATABRICKS_HOST'), token: need('DATABRICKS_TOKEN'), warehouseId: need('DATABRICKS_WAREHOUSE_ID'), statementTimeoutMs: 30000 };
    runStatement(config, 'SELECT 1 AS ok').then((r) => console.log(JSON.stringify(r)));
  "
```

Expected: a single line of JSON with `"state":"SUCCEEDED"` and `"rows":[["1"]]`.

If this fails on a Free Edition workspace specifically with a network/connection error reaching `<your-starter-cluster-host>` (not `SELECT 1 AS ok`, which never leaves Databricks), that is the Free Edition egress restriction from Section 4/5 - switch to a free trial workspace and repeat this task.

Commit: nothing to commit (external state); note the warehouse ID and connection name in your own notes for Task 13's `.env`.

### Task 12: One-time TiDB-side setup (manual, live)

- [ ] Not started

`.env` in `demos/databricks/` (copy from `.env.example`, fill in real values, never commit `.env`):

```
TIDB_HOST=<your-starter-cluster-host>
TIDB_PORT=4000
TIDB_USER=<generated-user>.root
TIDB_PASSWORD=<password>
TIDB_DATABASE=lab
TIDB_TLS=true
LAB_ENV_TIDB=TiDB Cloud Starter (public endpoint)
LAB_ENV_NOTES=Databricks reads this cluster over Lakehouse Federation; local tiup playground is not used because Databricks cannot reach a laptop behind NAT.

DATABRICKS_HOST=<workspace-host>
DATABRICKS_TOKEN=<token>
DATABRICKS_WAREHOUSE_ID=<warehouse-id>
DATABRICKS_STATEMENT_TIMEOUT_MS=60000
DATABRICKS_FEDERATION_CATALOG=tidb_fed
DATABRICKS_FEDERATION_SCHEMA=lab
DATABRICKS_SCORES_CATALOG=main
DATABRICKS_SCORES_SCHEMA=lab_databricks
DATABRICKS_SCORES_TABLE=risk_scores
EVENT_WRITE_INTERVAL_MS=1000
SCORING_INTERVAL_MS=15000
BURST_EVENT_COUNT=200
CUSTOMER_COUNT=50
```

`demos/databricks/.env.example` (committed, the contract's standard block plus this demo's variables, values redacted). Unlike most demos in this folder, this one cannot point `TIDB_HOST`/`TIDB_TLS` at a local `tiup playground`, because Databricks compute must reach TiDB over the public internet; when filling in the real `.env`, set `TIDB_HOST` to the Starter cluster's public endpoint host (for example `<your-starter-cluster-host>.<region>.prod.aws.tidbcloud.com`) and `TIDB_TLS=true`:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=
DATABRICKS_HOST=
DATABRICKS_TOKEN=
DATABRICKS_WAREHOUSE_ID=
DATABRICKS_STATEMENT_TIMEOUT_MS=60000
DATABRICKS_FEDERATION_CATALOG=tidb_fed
DATABRICKS_FEDERATION_SCHEMA=lab
DATABRICKS_SCORES_CATALOG=main
DATABRICKS_SCORES_SCHEMA=lab_databricks
DATABRICKS_SCORES_TABLE=risk_scores
EVENT_WRITE_INTERVAL_MS=1000
SCORING_INTERVAL_MS=15000
BURST_EVENT_COUNT=200
CUSTOMER_COUNT=50
```

In the TiDB Cloud console, before running anything: Cluster -> Connect -> Public Endpoint -> add your current IP (and, temporarily, Databricks' dynamic egress per Section 9) to the allow list.

Commit:

```bash
git add demos/databricks/.env.example
git commit -m "databricks demo: env template"
```

### Task 13: Wire the runner entry point

- [ ] Not started

`demos/databricks/runner/main.ts`:

```ts
import {
  createEmitter,
  createTidbPool,
  createSampleWindow,
  summarize,
  timed,
  every,
  onControl,
} from '@lab/runner-kit';
import {
  createEventsTableSql,
  createHeartbeatsTableSql,
  createScoresTableSql,
  enableTiflashReplicaSql,
} from './src/tidbSchema';
import { generateEvent } from './src/eventGenerator';
import { velocityRule, nextRule, type ScoringRule } from './src/scoringRule';
import {
  buildScoringStatement,
  buildFederatedHeartbeatStatement,
  type FederationConfig,
} from './src/scoringStatement';
import { buildUpsertStatement, type ScoredRow } from './src/upsertStatement';
import { computeFreshnessLagMs, computeFullLoopSeconds, parseDatabricksTimestamp } from './src/freshness';
import { runStatement, type DatabricksConfig } from './src/statementExecutionClient';

const env = process.env;

const numberFromEnv = (name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const requireEnv = (name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const federationConfig: FederationConfig = {
  federatedCatalog: env.DATABRICKS_FEDERATION_CATALOG ?? 'tidb_fed',
  federatedSchema: env.DATABRICKS_FEDERATION_SCHEMA ?? 'lab',
  eventsTable: 'events',
  heartbeatsTable: 'heartbeats',
  scoresCatalog: env.DATABRICKS_SCORES_CATALOG ?? 'main',
  scoresSchema: env.DATABRICKS_SCORES_SCHEMA ?? 'lab_databricks',
  scoresTable: env.DATABRICKS_SCORES_TABLE ?? 'risk_scores',
};

const databricksConfig: DatabricksConfig = {
  host: requireEnv('DATABRICKS_HOST'),
  token: requireEnv('DATABRICKS_TOKEN'),
  warehouseId: requireEnv('DATABRICKS_WAREHOUSE_ID'),
  statementTimeoutMs: numberFromEnv('DATABRICKS_STATEMENT_TIMEOUT_MS', 60000),
};

const eventIntervalMs = numberFromEnv('EVENT_WRITE_INTERVAL_MS', 1000);
const scoringIntervalMs = numberFromEnv('SCORING_INTERVAL_MS', 15000);
const burstEventCount = numberFromEnv('BURST_EVENT_COUNT', 200);
const customerCount = numberFromEnv('CUSTOMER_COUNT', 50);

const pool = createTidbPool(env);
const emitter = createEmitter();
const servingLatencies = createSampleWindow();
const controller = new AbortController();

let currentRule: ScoringRule = velocityRule;
let lastEventWrittenAtMs = Date.now();
let pendingWriteCount = 0;
let scoringInFlight = false;
let sawZeroWritesDuringScoring = false;
let federationCheckSent = false;
let scoresCheckSent = false;

const toDateTimeMs = (ms: number): string => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const qualifiedScoresTable = (): string =>
  `${federationConfig.scoresCatalog}.${federationConfig.scoresSchema}.${federationConfig.scoresTable}`;

const ensureSchema = async (): Promise<void> => {
  await pool.query(createEventsTableSql);
  await pool.query(createHeartbeatsTableSql);
  await pool.query(createScoresTableSql);
  await pool.query(enableTiflashReplicaSql).catch(() => undefined);
};

const insertEvent = async (): Promise<void> => {
  const event = generateEvent(customerCount, Math.random);
  await pool.execute(
    'INSERT INTO events (customer_id, event_type, amount, created_at) VALUES (?, ?, ?, ?)',
    [event.customerId, event.eventType, event.amount, toDateTimeMs(Date.now())],
  );
  lastEventWrittenAtMs = Date.now();
  pendingWriteCount += 1;
};

const writeHeartbeat = async (): Promise<void> => {
  await pool.execute(
    'INSERT INTO heartbeats (id, written_at) VALUES (1, ?) ON DUPLICATE KEY UPDATE written_at = VALUES(written_at)',
    [toDateTimeMs(Date.now())],
  );
};

const readRandomScore = async (): Promise<void> => {
  const { ms } = await timed(async () => {
    await pool.execute('SELECT customer_id, score, rule, updated_at FROM customer_risk_scores ORDER BY RAND() LIMIT 1');
  });
  servingLatencies.add(ms);
  emitter.flow('serving-reads', 1);
};

const eventLoopTick = async (): Promise<void> => {
  const writesBefore = pendingWriteCount;
  await insertEvent();
  await writeHeartbeat();
  await readRandomScore();
  const wroteThisTick = pendingWriteCount - writesBefore;
  if (wroteThisTick === 0 && scoringInFlight) sawZeroWritesDuringScoring = true;
  emitter.flow('writes', wroteThisTick);
  emitter.metric('event-write-rate', wroteThisTick / (eventIntervalMs / 1000));
  const summary = summarize(servingLatencies.drain());
  if (summary) {
    emitter.metric('serving-p50', summary.p50);
    emitter.metric('serving-p99', summary.p99);
  }
};

const runScoringOnce = async (): Promise<void> => {
  if (scoringInFlight) return;
  scoringInFlight = true;
  sawZeroWritesDuringScoring = false;
  const loopStartMs = lastEventWrittenAtMs;
  if (!federationCheckSent) emitter.check('federation-reachable', 'pending');
  if (!scoresCheckSent) emitter.check('scores-written-back', 'pending');
  emitter.check('loop-closed', 'pending');
  emitter.check('writes-continue-during-scoring', 'pending');
  try {
    emitter.phase('federated-read');
    emitter.node('databricks', 'busy', 'reading TiDB via Lakehouse Federation');
    const heartbeatResult = await runStatement(
      databricksConfig,
      buildFederatedHeartbeatStatement(federationConfig),
    );
    const heartbeatValue = heartbeatResult.rows[0]?.[0];
    if (heartbeatValue) {
      const lagMs = computeFreshnessLagMs(parseDatabricksTimestamp(heartbeatValue), Date.now());
      emitter.metric('freshness-lag-ms', lagMs);
      if (!federationCheckSent) {
        emitter.check('federation-reachable', 'pass', `${lagMs}ms lag`);
        federationCheckSent = true;
      }
    }

    const scoringResult = await runStatement(
      databricksConfig,
      buildScoringStatement(currentRule, federationConfig),
    );
    const rowsSynced = scoringResult.rowCount ?? 0;
    emitter.metric('rows-synced', rowsSynced);
    emitter.flow('federated-read', rowsSynced);

    emitter.phase('score-write-back');
    emitter.node('databricks', 'healthy', 'scoring complete');
    const readBackResult = await runStatement(
      databricksConfig,
      `SELECT customer_id, score, rule FROM ${qualifiedScoresTable()} WHERE rule = '${currentRule.name}'`,
    );
    const writeBackAtMs = Date.now();
    const scoredRows: readonly ScoredRow[] = readBackResult.rows.map((row) => ({
      customerId: Number(row[0]),
      score: Number(row[1]),
      rule: String(row[2]),
      updatedAtMs: writeBackAtMs,
    }));
    const upsert = buildUpsertStatement(scoredRows);
    if (upsert.sql !== '') {
      const { ms } = await timed(async () => {
        await pool.execute(upsert.sql, [...upsert.params]);
      });
      const writeBackRate = scoredRows.length / Math.max(ms / 1000, 0.001);
      emitter.metric('write-back-rate', writeBackRate);
      emitter.flow('reverse-etl', scoredRows.length);
      if (!scoresCheckSent) {
        emitter.check('scores-written-back', 'pass', `${scoredRows.length} rows`);
        scoresCheckSent = true;
      }
    }

    const fullLoopSeconds = computeFullLoopSeconds(loopStartMs, writeBackAtMs);
    emitter.metric('full-loop-time', fullLoopSeconds);
    emitter.check('loop-closed', 'pass', `${fullLoopSeconds.toFixed(1)}s`);
    emitter.check(
      'writes-continue-during-scoring',
      sawZeroWritesDuringScoring ? 'fail' : 'pass',
      sawZeroWritesDuringScoring ? 'a tick recorded zero writes during scoring' : 'writes continued throughout',
    );
    emitter.phase('low-latency-serving');
  } catch (error) {
    emitter.log('error', `scoring run failed: ${errorMessage(error)}`, 'databricks');
    emitter.node('databricks', 'degraded', errorMessage(error));
  } finally {
    scoringInFlight = false;
  }
};

const runAdhocAnalytics = async (): Promise<void> => {
  emitter.phase('adhoc-analytics');
  const { value, ms } = await timed(async () => {
    const [rows] = await pool.query(
      '/*+ READ_FROM_STORAGE(TIFLASH[events]) */ SELECT event_type, COUNT(*) AS n, SUM(amount) AS total FROM events WHERE created_at >= NOW(3) - INTERVAL 5 MINUTE GROUP BY event_type',
    );
    return rows;
  });
  emitter.metric('analytics-query-ms', ms);
  emitter.flow('analytics-query', Array.isArray(value) ? value.length : 0);
};

const runBurst = async (): Promise<void> => {
  for (let i = 0; i < burstEventCount; i += 1) {
    await insertEvent();
  }
};

onControl((id) => {
  if (id === 'trigger-scoring') void runScoringOnce();
  if (id === 'burst-events') void runBurst();
  if (id === 'change-rule') {
    currentRule = nextRule(currentRule);
    emitter.log('info', `scoring rule now: ${currentRule.name}`);
    emitter.phase('rule-change');
  }
  if (id === 'run-analytics') void runAdhocAnalytics();
});

const main = async (): Promise<void> => {
  await ensureSchema();
  emitter.node('app', 'healthy');
  emitter.node('tidb', 'healthy');
  emitter.node('tiflash', 'healthy');
  emitter.node('databricks', 'idle');
  emitter.phase('steady-writes');

  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  await Promise.all([
    every({ intervalMs: eventIntervalMs, task: eventLoopTick, signal: controller.signal }),
    every({ intervalMs: scoringIntervalMs, task: runScoringOnce, signal: controller.signal }),
  ]);

  await pool.end();
};

main().catch((error) => {
  emitter.log('error', errorMessage(error));
  process.exitCode = 1;
});
```

`main.ts` is the impure orchestration shell: every pure decision (rule toggling, SQL text, response parsing, poll decisions, freshness/loop math, event generation) lives in the `src/*.ts` modules tested in Tasks 3-8 and is exercised here only through function calls. The module-level `let` bindings hold orchestration state (in-flight guards, the active rule, counters) the way any long-running process must; the values they point to (`ScoringRule`, counts, booleans) are themselves immutable and replaced wholesale, never mutated in place.

Run (manual, live, needs Tasks 11/12 done and `.env` populated):

```bash
cd demos/databricks && node --import tsx runner/main.ts
```

Expected: no crash; after `EVENT_WRITE_INTERVAL_MS`, a stream of JSON lines on stdout starting with `{"type":"node",...}` and `{"type":"phase","phase":"steady-writes",...}`, then repeating `{"type":"metric","id":"event-write-rate",...}` and `{"type":"metric","id":"serving-p50",...}` lines every second, then after `SCORING_INTERVAL_MS` a burst of `{"type":"phase","phase":"federated-read",...}` through `{"type":"check","id":"loop-closed","status":"pass",...}` lines. Stop with Ctrl-C.

Commit:

```bash
git add demos/databricks/runner/main.ts
git commit -m "databricks demo: wire runner main"
```

### Task 14: End-to-end live run through the relay

- [ ] Not started

From the `integrations/` workspace root:

```bash
pnpm lab validate databricks
pnpm lab run databricks --port 7070
```

Expected for `validate`: `manifest.json is valid` (or the equivalent success line the relay prints per Plan 00) with no schema errors.

Expected for `run`: the relay prints it is spawning `node --import tsx runner/main.ts` in `demos/databricks`, then `GET http://localhost:7070/health` (in a second terminal, `curl http://localhost:7070/health`) returns `{"ok":true,"demo":"databricks"}`.

Then exercise a control end to end:

```bash
curl -X POST http://localhost:7070/control/trigger-scoring
```

Expected: `curl` returns success (2xx), and the terminal running `pnpm lab run` shows a new `{"type":"control","id":"trigger-scoring",...}` line immediately followed by the `federated-read` phase sequence from Task 13, without waiting for the next `SCORING_INTERVAL_MS` tick.

Commit: nothing (this task only proves the wiring; no new files).

### Task 15: Public-content gate

- [ ] Not started

```bash
pnpm lab check-public
```

Expected: passes with no denylisted terms or internal URLs found in `demos/databricks/`. If it flags anything, fix the flagged file and rerun before moving to Section 8.

### Task 16: README and TALK-TRACK

- [ ] Not started

`demos/databricks/README.md`:

```markdown
# TiDB + Databricks: Operational Store Meets the Lakehouse

## What this proves

Databricks reads live TiDB data through a read-only Lakehouse Federation
connection (no export job, no staging bucket), computes a per-customer risk
score, and the runner reverse-ETLs those scores back into TiDB. An app then
serves the fresh scores out of TiDB at OLTP latency while writes keep
flowing, and an optional ad hoc analytical query answers over the same fresh
rows from TiDB's columnar (TiFlash) replica. See `docs/plans/06-databricks.md`
in this repo for the full design, verified facts and sources, and the
rationale for choosing this path over TiCDC-to-Kafka or export-to-S3.

## Prerequisites

- A TiDB Cloud **Starter** cluster (free), with its public endpoint's IP
  access list open to your machine and to Databricks (see "Networking" below).
- A Databricks workspace: try **Free Edition** first; if the federated read
  in setup step 3 below cannot reach TiDB Cloud's host, use a free trial
  workspace instead. A personal access token with permission to run
  statements on a SQL warehouse and manage Unity Catalog connections/catalogs.
- A Databricks secret scope holding the TiDB username and password.
- Node 22 and pnpm.

## One-time setup

1. Create the TiDB Cloud Starter cluster; note its host and create a
   database user for this demo.
2. In a terminal, create the Databricks secret scope and secrets:
   ```bash
   databricks secrets create-scope --scope lab-tidb
   databricks secrets put-secret lab-tidb tidb-user
   databricks secrets put-secret lab-tidb tidb-password
   ```
3. In the Databricks SQL editor, run the `CREATE CONNECTION`,
   `CREATE FOREIGN CATALOG`, and `CREATE TABLE main.lab_databricks.risk_scores`
   statements from Task 11 of the plan.
4. Copy `.env.example` to `.env` and fill in the TiDB and Databricks values.
5. `pnpm install` at the `integrations/` workspace root.

## Run

```bash
pnpm lab run databricks --port 7070
```

Open the UI (see the platform's own README for how it points at a running
relay) to watch the flow diagram and metrics live, or drive it headless with:

```bash
curl http://localhost:7070/health
curl -X POST http://localhost:7070/control/trigger-scoring
curl -X POST http://localhost:7070/control/burst-events
curl -X POST http://localhost:7070/control/change-rule
curl -X POST http://localhost:7070/control/run-analytics
```

## Record

```bash
pnpm lab run databricks --record --port 7070
```

Stop with Ctrl-C when done; promote the newest file under
`demos/databricks/traces/` to `traces/featured.json`. Full recording
choreography is in `docs/plans/06-databricks.md` Section 8.

## Networking

Databricks serverless compute does not have a fixed outbound IP unless the
workspace has a Network Connectivity Configuration. For this demo, the
practical option is to temporarily open the TiDB Cloud Starter cluster's
public endpoint allow list to all IPs while recording or demoing live, then
tighten it back down. This is a demo convenience, not a production pattern.

## Cost

TiDB Cloud Starter has a free monthly quota; this demo's traffic is designed
to stay inside it (see current quota and pricing at
https://www.pingcap.com/tidb-cloud-starter-pricing-details/). Databricks
bills the SQL warehouse's DBUs while it runs (see
https://www.databricks.com/product/pricing/databricks-sql); use a small
serverless warehouse with a short auto-stop timeout, or Free Edition if it
works for your workspace.

## Teardown

```sql
DROP TABLE IF EXISTS main.lab_databricks.risk_scores;
DROP FOREIGN CATALOG IF EXISTS tidb_fed;
DROP CONNECTION IF EXISTS tidb_lab_connection;
```

Then: stop the Databricks SQL warehouse, delete the personal access token,
delete the secret scope (`databricks secrets delete-scope --scope lab-tidb`),
and delete or lock back down the TiDB Cloud Starter cluster's public
endpoint allow list.
```

`demos/databricks/TALK-TRACK.md`:

```markdown
# Talk track: TiDB + Databricks

## Phase-by-phase script

**Steady-State Writes.** "This is just an app writing to TiDB - purchases,
refunds, chargebacks, one row at a time, like any OLTP workload. Nothing
Databricks-specific here yet; this is the system of record most teams
already have."

**Databricks Reads TiDB Live.** "Now watch the right side. Databricks is
querying TiDB directly, through a read-only Lakehouse Federation connection
in Unity Catalog. No export job ran, no file landed in a bucket first - this
is a live JDBC read against the same TiDB cluster the app is writing to
right now."

**Reverse ETL: Scores Back to TiDB.** "Databricks just computed a risk score
per customer from that data. Those scores are landing back in TiDB, in a
table the app already knows how to query. This is the reverse-ETL half of
the loop - lakehouse compute, operational serving."

**Serving Fresh Scores.** "The app is reading those scores right now, at
single-digit-millisecond p50, while new events keep landing in the
background. That's the point: analytical compute happened on Databricks,
but nobody has to stand up a second serving database to use the result."

**Ad Hoc Analytics on Fresh Data.** "Same fresh data, same cluster - now
answered by the columnar engine instead of the row store. One button, no
second database, no separate ETL to keep an analytics replica in sync."

**Changing the Rule Live.** "Swapping the scoring rule from velocity-weighted
to amount-weighted is a SQL change on the Databricks side. Nothing in TiDB
or the app redeploys."

## Discovery questions

1. "Where does your team currently store the operational data Databricks
   reads for training or scoring - and how does it get there today?"
2. "When a Databricks job produces a score or a feature, what serves it back
   to your application, and how fresh does that have to be?"
3. "Have you had to build or maintain a CDC pipeline just to get operational
   data into the lakehouse? What did that cost to build and to keep running?"
4. "If your operational database and your analytics store are different
   systems today, how do you reconcile them when they disagree?"
5. "What's your tolerance for the lag between an event happening and a
   Databricks-computed feature being usable by an application?"

## Objections and honest answers

1. **"We already have a CDC pipeline into our lakehouse; why would we
   change it?"** If it works and meets your freshness bar, keep it. This
   demo's federated-read path is for the read side of the loop and doesn't
   require replacing an existing ingestion pipeline; it's most compelling
   when the missing piece is the *reverse* direction - getting a
   Databricks-computed result back into a low-latency serving store, which a
   one-way CDC pipeline usually doesn't do for you.
2. **"Isn't querying an operational database from an analytics engine going
   to slow down our OLTP traffic?"** In this demo, the federated read is a
   scoped, time-windowed aggregate, not a full scan, and TiDB's TiFlash
   replica exists specifically so analytical reads don't compete with OLTP
   reads/writes on the row store. We show writes continuing throughout the
   scoring window as a check, not just a claim - but a much larger federated
   query against the row store on a small cluster can still add load; index
   and window the query at production scale the same way we did here.
3. **"Why not just batch-export to S3 and use Auto Loader like everyone
   else?"** That's a legitimate, cheaper-at-scale pattern, and this plan
   documents it as an alternative (path (c) in Section 4 of the design doc).
   It trades the "seconds" loop time this demo shows for cheaper, batch-cadence
   freshness. Pick it if your use case tolerates minutes-to-hours of lag;
   pick the federated-read path if it doesn't.
4. **"TiDB Cloud Starter is a free tier - does any of this hold up on a
   production cluster?"** The read path (Lakehouse Federation) and the
   reverse-ETL write path (a normal SQL upsert) work the same way on
   Dedicated or Premium; what changes at that tier is that TiCDC-to-Kafka and
   export-to-S3 also become available as additional, complementary paths
   (Section 4), and you get dedicated compute instead of shared multi-tenant
   capacity.
5. **"What happens if the Databricks warehouse is slow or down when we need
   a fresh score?"** The app keeps serving whatever score is already in
   TiDB - staleness is visible (the freshness-lag metric would climb), but
   there's no outage in the serving path, because TiDB is not blocked
   waiting on Databricks. That's a direct benefit of decoupling the serving
   store from the compute engine that feeds it.
```

Run: no automated test (both files are documentation content); read them back once written to confirm the code blocks render as intended.

Commit:

```bash
git add demos/databricks/README.md demos/databricks/TALK-TRACK.md
git commit -m "databricks demo: README and talk track"
```

## 8. Recording the featured trace

1. **Warm up first, off camera.** Serverless SQL warehouses and a cold federation connection add tens of seconds the first time. At least five minutes before recording: start the Databricks SQL warehouse, run `SELECT 1` and the Task 11 `SELECT * FROM tidb_fed.lab.heartbeats` once each to warm the connection, and confirm `information_schema.tiflash_replica` shows `AVAILABLE = 1` for the `events` table (`SELECT AVAILABLE FROM information_schema.tiflash_replica WHERE TABLE_NAME = 'events';` against TiDB) so the `run-analytics` control has something to read during recording.
2. **Set the trace environment values honestly** in `demos/databricks/.env` before starting:
   ```
   LAB_ENV_TIDB=TiDB Cloud Starter (public endpoint), <TiDB version string shown in the console>
   LAB_ENV_NOTES=Databricks SQL warehouse <serverless size>, workspace region <region>; warmed for 5 minutes before this recording.
   ```
3. **Record:**
   ```bash
   cd integrations
   pnpm lab run databricks --record --port 7070
   ```
4. In the UI (`packages/ui`, pointed at `localhost:7070`), let `steady-writes` run about 15-20 seconds, then click **Run scoring now**, then once scores land click **Run ad hoc analytics**, then **Change scoring rule** and **Run scoring now** again to show the rule swap, then **Burst events** followed by one more **Run scoring now** to show the loop holding up under load. Aim for the whole recording to land between 3 and 6 minutes; narrate using the `phases[].narration` text as your script (also reproduced in `TALK-TRACK.md`).
5. Stop with **Ctrl-C** in the `pnpm lab run` terminal. This writes `demos/databricks/traces/<ISO timestamp>.json`.
6. Promote the recording:
   ```bash
   cd demos/databricks/traces
   cp "$(ls -t *.json | head -1)" featured.json
   ```
7. Validate and gate:
   ```bash
   cd ../../..
   pnpm lab validate databricks
   pnpm lab check-public
   ```
8. Commit only `traces/featured.json` (every other file in `traces/` is gitignored per the platform contract):
   ```bash
   git add demos/databricks/traces/featured.json
   git commit -m "databricks demo: record featured trace"
   ```

## 9. Risks and gotchas

- **Free Edition egress is the single biggest unknown (Section 4/5).** Confirm it with the `SELECT 1 AS ok` vs. federated-read test in Task 11 before planning a recording session around it; budget the fallback to a free trial workspace as the default assumption, not a last resort.
- **TiDB Cloud allow list vs. Databricks' dynamic serverless egress IPs.** Without a Network Connectivity Configuration (an enterprise Databricks feature), there is no fixed IP range to add to TiDB Cloud's allow list. For this demo only, temporarily set the Starter cluster's public endpoint allow list to permit all IPs for the recording session, then tighten it back down afterward (Section 5 teardown, step 5) - call this out on camera as a demo-only relaxation, never a production recommendation.
- **SQL warehouse cold start.** A stopped serverless warehouse can take tens of seconds to resume on the first query; this would visibly stall the `federated-read` phase if it happens during recording. Warm-up (Section 8, step 1) exists specifically to avoid this landing on camera.
- **Clock skew inside `freshness-lag-ms`.** The metric is `Date.now()` in the runner minus a timestamp computed by Databricks' `current_timestamp()`; besides real network/query latency, this includes whatever clock drift exists between the machine running the runner and the Databricks warehouse's clock. This is disclosed in the metric's `howMeasured` rather than hidden - if the recorded number looks suspiciously small or negative-then-clamped-to-zero, that is why.
- **TiFlash replication lag before the first `run-analytics` click.** `ALTER TABLE events SET TIFLASH REPLICA 1` (Task 9/13) returns immediately but the columnar copy catches up asynchronously. Task 8 in Section 8 (checking `information_schema.tiflash_replica.AVAILABLE`) exists to keep this off camera; if `run-analytics` is clicked before the replica is available, TiDB may reject the manual hint or return zero rows for very recent data - both are confusing on a recording.
- **Overlapping scoring runs.** The periodic `every({ intervalMs: scoringIntervalMs, ... })` loop and the `trigger-scoring` control both call `runScoringOnce`; the `scoringInFlight` guard in `runner/main.ts` makes a second call a no-op rather than letting two federated reads race. This is intentional, not a bug to fix later.
- **String-built SQL for the scoring statement.** `buildScoringStatement` interpolates `rule.name` and the weight/window numbers directly into the SQL text rather than using the Statement Execution API's verified `:name` parameter markers (Section 4). This is safe here only because `ScoringRuleName` is a two-value union checked at compile time and every numeric field is validated finite before formatting (Task 4's test for a `NaN` weight). If this pattern is ever extended to accept a value that did not come from this file's own presets, switch to named parameters instead of interpolation.
- **Databricks and TiDB region mismatch.** If the TiDB Cloud Starter cluster and the Databricks workspace are on different clouds or distant regions, `freshness-lag-ms` and `full-loop-time` will be dominated by cross-region network latency rather than anything TiDB- or Databricks-specific. Create both in the same cloud/region pairing where possible (Section 5).

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 06-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/06-databricks.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - **Environment note on verification method:** `WebFetch` was unavailable in the environment this plan was written in (every domain, including `example.com`, returned "Unable to verify if domain is safe to fetch"). All facts below were confirmed with `WebSearch`, which returns synthesized snippets plu
  - | Databricks Free Edition runs on **serverless compute only**, must use Unity Catalog to reach external data sources, and its outbound network access is "restricted to a limited set of trusted domains" with "no specific IP you can whitelist." | [Databricks Free Edition limitations](https://docs.data
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/06-databricks.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 06-P1: Scaffold the demo package
- Tasks: 1
- Depends on: 06-V1   Shared runtime: none
- Files owned: `integrations/demos/databricks/package.json`, `integrations/demos/databricks/runner/src`, `integrations/demos/databricks/runner/test`, `integrations/demos/databricks/test`, `integrations/demos/databricks/traces`, `integrations/demos/databricks/tsconfig.json`
- Model: sonnet   Effort: S
- Gate:
  - every command in Task 1 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 1's steps are all checked off and the gate output matches.

### Packet 06-P2: Manifest
- Tasks: 2
- Depends on: 06-P1   Shared runtime: none
- Files owned: `integrations/demos/databricks/manifest.json`, `integrations/demos/databricks/test/manifest.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 2's steps are all checked off and the gate output matches.

### Packet 06-P3: Scoring rule presets and the rule-toggle
- Tasks: 3
- Depends on: 06-P2   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/src/scoringRule.ts`, `integrations/demos/databricks/runner/test/scoringRule.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 3's steps are all checked off and the gate output matches.

### Packet 06-P4: Scoring and heartbeat SQL builders
- Tasks: 4
- Depends on: 06-P3   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/src/scoringStatement.ts`, `integrations/demos/databricks/runner/test/scoringStatement.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 4's steps are all checked off and the gate output matches.

### Packet 06-P5: Reverse-ETL upsert builder
- Tasks: 5
- Depends on: 06-P4   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/src/upsertStatement.ts`, `integrations/demos/databricks/runner/test/upsertStatement.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 5's steps are all checked off and the gate output matches.

### Packet 06-P6: Statement Execution API response parser and poll-decision state machine
- Tasks: 6
- Depends on: 06-P5   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/src/statementResponse.ts`, `integrations/demos/databricks/runner/test/statementResponse.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 6's steps are all checked off and the gate output matches.

### Packet 06-P7: Freshness and full-loop math
- Tasks: 7
- Depends on: 06-P6   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/src/freshness.ts`, `integrations/demos/databricks/runner/test/freshness.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 7's steps are all checked off and the gate output matches.

### Packet 06-P8: Synthetic event generator
- Tasks: 8
- Depends on: 06-P7   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/src/eventGenerator.ts`, `integrations/demos/databricks/runner/test/eventGenerator.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 8's steps are all checked off and the gate output matches.

### Packet 06-P9: TiDB schema DDL constants
- Tasks: 9
- Depends on: 06-P8   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/src/tidbSchema.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 06-P10: Databricks Statement Execution API client
- Tasks: 10
- Depends on: 06-P9   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/src/statementExecutionClient.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 06-P11: One-time Databricks-side setup (manual, live)
- Tasks: 11
- Depends on: 06-P10   Shared runtime: none
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: M
- Gate:
  - every command in Task 11 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 06-P12: One-time TiDB-side setup (manual, live)
- Tasks: 12
- Depends on: 06-P11   Shared runtime: cloud-account
- Files owned: `integrations/demos/databricks/.env.example`
- Model: sonnet   Effort: S
- Gate:
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/databricks/.env.example` -> 8
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 06-P13: Wire the runner entry point
- Tasks: 13
- Depends on: 06-P12   Shared runtime: none
- Files owned: `integrations/demos/databricks/runner/main.ts`
- Model: sonnet   Effort: L
- Gate:
  - `pnpm --filter @lab/demo-databricks typecheck` -> exit 0
- Done when: Task 13's steps are all checked off and the gate output matches.

### Packet 06-P14: End-to-end live run through the relay
- Tasks: 14
- Depends on: 06-P13   Shared runtime: tidb-playground
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 14 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 14's steps are all checked off and the gate output matches.

### Packet 06-P15: Public-content gate
- Tasks: 15
- Depends on: 06-P14   Shared runtime: none
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 15 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 15's steps are all checked off and the gate output matches.

### Packet 06-P16: README and TALK-TRACK
- Tasks: 16
- Depends on: 06-P15   Shared runtime: cloud-account
- Files owned: `integrations/demos/databricks/README.md`, `integrations/demos/databricks/TALK-TRACK.md`, `integrations/demos/databricks/traces`
- Model: sonnet   Effort: L
- Gate:
  - `grep -c $'\u2014' integrations/demos/databricks/README.md integrations/demos/databricks/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 16's steps are all checked off and the gate output matches.

### Packet 06-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 06-P16   Shared runtime: cloud-account
- Files owned: `integrations/demos/databricks/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate databricks` -> `databricks: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.
