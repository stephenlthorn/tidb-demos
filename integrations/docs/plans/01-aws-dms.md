# Plan 01: AWS DMS + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a fintech-pattern migration from Aurora PostgreSQL to TiDB running live under AWS DMS: full load, then change data capture (CDC) against a database taking live writes, then a validated cutover, with the diagram animating rows flowing DMS to TiDB and CDC latency draining to zero before the flip.

**Architecture:** A load generator writes orders continuously to Aurora PostgreSQL. AWS DMS (a replication instance) full-loads existing rows into TiDB Cloud, then switches to CDC using PostgreSQL logical replication. The runner polls the AWS DMS `DescribeTableStatistics` API and CloudWatch `GetMetricData` for CDCLatencySource/CDCLatencyTarget, and independently queries both Aurora PostgreSQL and TiDB over SQL for row counts, checksums, and heartbeat freshness. A `control` from the UI can burst the write rate, trigger validation, or start cutover (stop writer, wait for latency to drain, flip the app's connection string).

**Tech Stack:** Node 22 + TypeScript runner using `@lab/runner-kit`, `@aws-sdk/client-database-migration-service`, `@aws-sdk/client-cloudwatch`, `pg` (Aurora PostgreSQL client), `mysql2` (via `createTidbPool`). Terraform for Aurora PostgreSQL + DMS + networking + IAM. TiDB Cloud Dedicated cluster created out of band (Terraform provider optional, see Task 2).

**Depends on:** Plan 00 (platform).

---

## 1. Why this demo

- **The question customers ask:** "We're on Aurora PostgreSQL today. Can we move to TiDB with AWS DMS, the same tool we already use for other migrations, without a big-bang cutover and without silently losing data types along the way?"
- **Pattern:** Fintech evaluating a move from Aurora PostgreSQL to TiDB, testing AWS DMS full load plus CDC as the migration path.
- **What TiDB proves here:**
  - TiDB Cloud is a supported AWS DMS target using the standard MySQL endpoint type, over the same public/private connectivity options DMS already offers.
  - Full load and CDC can run concurrently with live writes on the source, and the demo makes the CDC lag (source-to-target) visible in real time rather than assumed.
  - A cutover can be driven from measured signals (latency at zero, checksums equal) instead of a fixed wait, and the downtime window is measured, not estimated.
  - The heterogeneous PostgreSQL-to-MySQL-dialect schema conversion is a known, bounded set of type changes, not a black box.
- **What this demo does not claim:** it does not claim AWS DMS Schema Conversion (or AWS SCT) auto-converts every PostgreSQL feature; DMS itself only creates tables and primary keys, so secondary indexes, foreign keys, sequences, and check constraints are hand-written for this schema (see Section 4). It does not claim zero-downtime cutover; it measures the downtime window and reports it, and that window here is seconds, not zero.

## 2. What the audience sees

### Flow diagram

```
[app-writer]              [aurora-pg]         [dms]              [tidb]
  (client)     --writes-->  (source)  --load/cdc-->(service) --applied--> (tidb)
   x=8,y=20                x=8,y=55            x=45,y=55          x=85,y=55

                                          [validator] (service, x=45,y=85)
                                          checks: row-count-match, checksum-match
```

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | provision | Provision and verify | Terraform-built Aurora PostgreSQL, DMS replication instance, and TiDB Cloud cluster are confirmed reachable; runner checks `DescribeReplicationInstances` and a TiDB `SELECT 1`. | "Aurora PostgreSQL, AWS DMS, and TiDB Cloud are up. This is the same DMS you already use for other migrations." |
| 2 | schema | Schema conversion | The PostgreSQL schema (SERIAL, JSONB, BOOLEAN, TIMESTAMPTZ, UUID, NUMERIC, arrays) is shown next to the hand-written TiDB DDL it maps to; DMS is told to create tables and primary keys only. | "DMS creates tables and primary keys. Everything else in the type conversion is explicit, and we show you exactly what changed." |
| 3 | full-load | Full load | DMS bulk-copies existing rows table by table; the runner polls `DescribeTableStatistics` and animates rows/s per table. | "DMS full-loads the existing orders and accounts tables while the app keeps taking traffic." |
| 4 | cdc-live | CDC under live load | DMS switches to CDC via logical replication; the load generator keeps writing, and a burst control spikes the write rate to show DMS keep up. | "Now every insert, update, and delete on Aurora flows through logical replication into TiDB, live." |
| 5 | validate | Validate | DMS data validation runs alongside the demo's own row-count and checksum comparison, computed identically on both sides. | "We don't just trust DMS's validation state, we recompute row counts and checksums ourselves on both databases." |
| 6 | cutover | Cutover | Load generator stops, CDC latency is polled until it hits zero, a final check confirms row counts and checksums match, then the app's connection string flips to TiDB. | "Writes stop, CDC drains to zero lag, we verify one more time, then the app points at TiDB. That whole window is the downtime we measure." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| burst-writes | Burst writes | Load generator raises its insert/update rate against Aurora PostgreSQL for 30 seconds, then returns to baseline. |
| run-validation | Run validation | Runner computes `SELECT COUNT(*)` and a per-table checksum (`SUM(CRC32(CONCAT_WS(...)))`-style aggregate, computed with equivalent SQL on both engines) and emits `check` events. |
| start-cutover | Start cutover | Runner stops the load generator, polls CDC latency until it reaches zero, re-validates, then emits the cutover-complete log and downtime metric. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| schema-parity | Schema parity | Every column in the hand-written TiDB DDL has a documented source PostgreSQL type in the mapping table (Section 4); the runner does not verify this at runtime, it is a static design check reported once at demo start. |
| row-count-match | Row count match | `SELECT COUNT(*)` on Aurora PostgreSQL equals `SELECT COUNT(*)` on TiDB for every migrated table. |
| checksum-match | Checksum match | A per-table checksum aggregate computed with equivalent SQL on both sides is equal. |
| cutover-clean | Clean cutover | CDCLatencyTarget reaches 0 seconds and row-count-match plus checksum-match both pass immediately before the connection flip. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| full_load_rows_sec | Full load throughput | rows/s | both | higher | Delta of `FullLoadRows` from `DescribeTableStatistics` (AWS DMS API) between ticks, divided by tick interval seconds. |
| full_load_pct | Full load completion | % | tile | higher | `FullLoadRows / sourceRowCount * 100` per table, where `sourceRowCount` is a one-time `SELECT COUNT(*)` on Aurora PostgreSQL taken at phase start. |
| cdc_latency_source_s | CDC latency (source) | s | series | lower | CloudWatch metric `CDCLatencySource` (namespace `AWS/DMS`, dimension `ReplicationInstanceIdentifier` and `ReplicationTaskIdentifier`), read via `GetMetricData`, most recent datapoint per tick. **UNVERIFIED**: confirm the exact dimension name required (`ReplicationTaskIdentifier` vs `ReplicationInstanceIdentifier`) against the live console before building (Section 4). |
| cdc_latency_target_s | CDC latency (target) | s | series | lower | CloudWatch metric `CDCLatencyTarget`, same namespace and read path as above. |
| cdc_apply_rows_sec | CDC apply throughput | rows/s | series | higher | Delta of `AppliedInserts + AppliedUpdates + AppliedDeletes` from `DescribeTableStatistics` between ticks, divided by tick interval seconds. |
| validation_failed_rows | Validation failures | rows | tile | lower | `ValidationFailedRecords` from `DescribeTableStatistics`, summed across tables (requires validation turned on for the task). |
| row_count_diff | Row count difference | rows | tile | lower | `ABS(pg_count - tidb_count)` from the demo's own `SELECT COUNT(*)` on both sides, run by the `run-validation` control (direct measurement, not vendor-reported). |
| heartbeat_freshness_ms | End-to-end freshness | ms | series | lower | Runner inserts a timestamped heartbeat row into Aurora PostgreSQL every tick, then polls TiDB for that row's arrival; freshness is `visibleAt - insertedAt` in milliseconds (direct measurement). |
| cutover_downtime_s | Cutover downtime | s | tile | lower | Wall-clock seconds between the runner stopping the load generator and the runner confirming the app's new TiDB connection accepts a write, timed with `Date.now()` inside the runner (direct measurement). |

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| TiDB Cloud (Serverless/Essential and Dedicated) is a documented AWS DMS target using the MySQL endpoint type; DMS creates tables and primary keys only, not secondary indexes, foreign keys, or user accounts. | [Migrate from MySQL-Compatible Databases to TiDB Cloud Using AWS DMS](https://docs.pingcap.com/tidbcloud/migrate-from-mysql-using-aws-dms/) | Verified |
| Dedicated clusters support public endpoint, AWS PrivateLink private endpoint, and VPC peering; Serverless/Essential support public endpoint or AWS PrivateLink only (no VPC peering). SSL mode should be `verify-full` over public endpoint, and can be `none` over private endpoint. Dedicated CA cert comes from the TLS-to-Dedicated doc; Serverless/Essential uses the public ISRG Root X1 cert. | [Connect AWS DMS to TiDB Cloud](https://docs.pingcap.com/tidbcloud/tidb-cloud-connect-aws-dms/) | Verified |
| As a DMS target, set the extra connection attribute `Initstmt=SET FOREIGN_KEY_CHECKS=0;` on the TiDB endpoint. | [Connect AWS DMS to TiDB Cloud](https://docs.pingcap.com/tidbcloud/tidb-cloud-connect-aws-dms/) and [AWS: Using a MySQL-compatible database as a target](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Target.MySQL.html) | Verified |
| Recommended DMS replication instance class is `dms.t3.large` (2 vCPU / 8 GiB) or higher to avoid OOM; use the same AWS region for DMS and TiDB Cloud; filter out TiDB system databases (`INFORMATION_SCHEMA`, `PERFORMANCE_SCHEMA`, `mysql`, `sys`, `test`) in table mappings instead of using `%`. | [Migrate from MySQL-Compatible Databases to TiDB Cloud Using AWS DMS](https://docs.pingcap.com/tidbcloud/migrate-from-mysql-using-aws-dms/) | Verified |
| MySQL-compatible target user needs `GRANT ALTER, CREATE, DROP, INDEX, INSERT, UPDATE, DELETE, SELECT, CREATE TEMPORARY TABLES ON <schema>.*` plus `GRANT ALL PRIVILEGES ON awsdms_control.*`. | [AWS: Using a MySQL-compatible database as a target](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Target.MySQL.html) | Verified |
| Aurora PostgreSQL logical-replication CDC requires `rds.logical_replication = 1` in the **DB cluster** parameter group (a static parameter, needs an instance reboot); AWS then auto-manages `wal_level`, `max_wal_senders`, `max_replication_slots`, `max_connections`. The master user account already has `rds_superuser` and `rds_replication`. | [AWS DMS: Using PostgreSQL as a source, "Enabling CDC with an AWS-managed PostgreSQL DB instance"](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html) | Verified |
| Aurora PostgreSQL CDC support requires version 2.2 (PostgreSQL 10.6 compatibility) or higher; version 2.1/10.5 or lower supports full load only, not CDC. | [AWS DMS: Using PostgreSQL as a source](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html) | Verified |
| DMS uses the `pglogical` plugin automatically when it is installed and enabled (`shared_preload_libraries` includes `pglogical`, extension created); Aurora PostgreSQL supports `pglogical` from version 2.6.x and 3.3.x up; otherwise DMS falls back to the built-in `test_decoding` plugin, which needs no extension. Extra connection attribute `PluginName` can force `test_decoding` even when `pglogical` is available. | [AWS DMS: Using PostgreSQL as a source, "Configuring the pglogical plugin"](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html) | Verified |
| Aurora PostgreSQL Serverless v1 supports full load only (no CDC); Serverless v2 supports full load, full load + CDC, and CDC-only. This demo uses a provisioned Aurora PostgreSQL instance, so this limitation does not apply, but it is documented for anyone adapting the plan. | [AWS DMS: Using PostgreSQL as a source](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html) | Verified |
| AWS DMS Serverless (the auto-provisioned-capacity replication mode, billed in DMS Capacity Units/DCUs of 2 GiB RAM each) lists "PostgreSQL-compatible databases" as a supported source and "MySQL-compatible databases" as a supported target, so this pair is supported in principle. | [AWS DMS Serverless components](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Serverless.Components.html) | Verified (source/target engine family listed); **UNVERIFIED**: whether AWS DMS Serverless has been validated end-to-end against TiDB Cloud specifically (the pingcap.com guide above only documents a classic replication instance) - confirm with a manual test in Task 8, and default this plan to a DMS replication instance since that is the path PingCAP's own docs verify. |
| A captured PostgreSQL table must have a primary key for CDC (UPDATE/DELETE on a table without one are otherwise ignored); a table with an ARRAY column must have a primary key or it is suspended during full load; multiple tables differing only by case are not supported; DMS does not replicate DROP TABLE, TRUNCATE PARTITION, table partitioning/inheritance metadata, or `ALTER COLUMN SET DEFAULT` / nullability changes. | [AWS DMS: Using PostgreSQL as a source](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html) | Verified |
| PostgreSQL-to-DMS source type mapping used for this schema: `SERIAL`/`BIGSERIAL` to `INT4`/`INT8` (auto-increment must be hand-added on the TiDB DDL, DMS does not migrate the sequence), `BOOLEAN` to a 5-char `true`/`false` string internally (so the TiDB column is hand-declared `BOOLEAN`/`TINYINT(1)` rather than trusting DMS's default), `NUMERIC(p,s)` to `NUMERIC` when precision is 0-38 (else `STRING`), `TIMESTAMP WITH TIME ZONE` to `DATETIME` (zone is not preserved, values normalize to the endpoint's configured time zone), `UUID` to `STRING`, `JSONB`/`JSON`/`ARRAY` to `NCLOB` (migrated as text; the TiDB column is hand-declared `JSON` for JSONB and `TEXT` for arrays, since DMS's internal `NCLOB` lands as a MySQL text type either way). | [AWS DMS: Using PostgreSQL as a source, "Source data types for PostgreSQL"](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html) | Verified |
| PostgreSQL `NUMERIC` without an explicit precision/scale is treated by DMS as `NUMERIC(28,6)` by default, which can silently truncate values (example given: `0.611111104488373` becomes `0.611111`). This demo declares explicit precision/scale on every `NUMERIC` column in the source schema to avoid this. | [AWS DMS: Using PostgreSQL as a source](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html) | Verified |
| AWS DMS does not automatically create secondary indexes, foreign keys, or user accounts on the TiDB target; the demo's TiDB DDL adds these by hand before the full load starts (indexes are created after full load per DMS best practice to avoid slowing the bulk copy). | [Migrate from MySQL-Compatible Databases to TiDB Cloud Using AWS DMS](https://docs.pingcap.com/tidbcloud/migrate-from-mysql-using-aws-dms/) | Verified |
| CloudWatch metric `CDCLatencySource` measures delay (seconds) between the last captured source commit and the replication instance's current time; `CDCLatencyTarget` measures delay between the first unapplied change's source commit time and current time, and is always >= `CDCLatencySource`. | [AWS re:Post: Troubleshoot high source latency on an AWS DMS task](https://repost.aws/knowledge-center/dms-high-source-latency) and [Troubleshooting latency issues in AWS DMS](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Troubleshooting_Latency.html) | Verified via secondary/support source; **UNVERIFIED**: confirm the exact CloudWatch namespace/dimension pair against the primary "Monitoring AWS DMS tasks" doc page before wiring `GetMetricData` (Task 6). |
| `DescribeTableStatistics` returns per-table `FullLoadRows`, `AppliedInserts`, `AppliedUpdates`, `AppliedDeletes`, `ValidationFailedRecords`, and `TableState`. | Prior knowledge of the AWS DMS API, not fetched from `docs.aws.amazon.com/dms/latest/APIReference` in this session. | **UNVERIFIED**: confirm the exact field names and casing against `DescribeTableStatistics` in the AWS DMS API Reference before writing `runner/src/dms-poller.ts` (Task 6). |
| AWS DMS data validation (`Turn on validation` at task creation) independently re-reads source and target rows and reports per-table failures; this demo turns it on and also computes its own row-count and checksum comparisons rather than only trusting the vendor's validation state. | [Migrate from MySQL-Compatible Databases to TiDB Cloud Using AWS DMS](https://docs.pingcap.com/tidbcloud/migrate-from-mysql-using-aws-dms/) (validation option in task wizard) | Verified that the option exists and is recommended; **UNVERIFIED**: exact CloudWatch/API surface for reading validation state beyond `ValidationFailedRecords` - confirm in Task 6. |
| AWS DMS pricing (replication instance hourly rate by instance class, plus storage) is on the DMS pricing page; there is no fixed dollar figure recorded in this plan. | [AWS DMS pricing](https://aws.amazon.com/dms/pricing/) | Not fetched this session; URL given for the runner/README to link to. **UNVERIFIED**: confirm current instance-hour rate structure at build time (Section 5). |
| TiDB Cloud pricing (Dedicated node-hour rate, or Essential/Serverless request-based pricing) is on the TiDB Cloud pricing page; no fixed dollar figure is recorded in this plan. | [TiDB Cloud pricing](https://www.pingcap.com/tidb-cloud-pricing/) | Not fetched this session; URL given for the runner/README to link to. **UNVERIFIED**: confirm current tier/pricing structure at build time (Section 5). |
| Aurora PostgreSQL pricing (instance hour by class, storage, I/O) is on the Amazon Aurora pricing page. | [Amazon Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/) | Not fetched this session; URL given for teardown/cost section. **UNVERIFIED**: confirm current instance-class rate at build time (Section 5). |

## 5. Prerequisites, cost, and teardown

- Accounts and access: an AWS account with permission to create RDS/Aurora, DMS, VPC, and IAM resources; a TiDB Cloud account with permission to create a Dedicated cluster (Dedicated is required here for VPC peering/PrivateLink; see Section 4).
- Local tools: macOS, Docker Desktop (not required to run this demo locally since all data stores are cloud-hosted, but used for the relay/UI dev loop), Node 22, pnpm, terraform, aws cli, tiup (unused by this demo directly).
- Cost model: this demo bills for (1) the Aurora PostgreSQL instance while it runs, (2) the AWS DMS replication instance while it runs, (3) the TiDB Cloud Dedicated cluster while it runs, each at its documented hourly rate times hours running, plus (4) TiDB Cloud PrivateLink/VPC peering hourly charges if used, per the pricing pages linked in Section 4. No dollar figures are hardcoded; read the current rate from the linked pricing pages before recording cost in the README.
- Teardown: exact commands, run in this order:
  1. `pnpm lab run aws-dms` runner should already have exited or been Ctrl-C'd.
  2. `cd demos/aws-dms/infra/terraform && terraform destroy -auto-approve` - destroys the DMS replication instance, endpoints, task, Aurora PostgreSQL cluster, and the VPC/subnets/security groups/IAM role created for this demo.
  3. Delete the TiDB Cloud Dedicated cluster from the TiDB Cloud console (Terraform-managed only if Task 2 wires the TiDB Cloud Terraform provider; otherwise this is a manual console step, documented explicitly in `README.md`).
  4. Confirm nothing is still billing: `aws dms describe-replication-instances --query 'ReplicationInstances[].ReplicationInstanceIdentifier'` returns an empty list; `aws rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier'` returns an empty list (or does not include this demo's cluster identifier); the TiDB Cloud console's cluster list no longer shows the demo cluster.

## 6. File structure

```
demos/aws-dms/
  manifest.json                 DemoManifestSchema instance (id aws-dms, number 1); see Task 1
  package.json                  @lab/demo-aws-dms, deps @lab/contract + @lab/runner-kit (workspace:*), pg, @aws-sdk/client-database-migration-service, @aws-sdk/client-cloudwatch
  tsconfig.json                 extends ../../tsconfig.base.json
  README.md                     what it proves, prerequisites, run, record, teardown, cost notes (Task 10)
  TALK-TRACK.md                 presenter script per phase, discovery questions, objections (Task 11)
  .env.example                  standard TIDB_* block plus PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE, DMS_REPLICATION_INSTANCE_ARN, DMS_TASK_ARN, DMS_TASK_ID, AWS_REGION
  infra/terraform/main.tf       Aurora PostgreSQL, DMS replication instance/endpoints/task, VPC, security groups, IAM (Task 2)
  infra/terraform/variables.tf  region, instance classes, CIDR blocks, TiDB Cloud connection details as inputs
  infra/terraform/outputs.tf    Aurora endpoint, DMS ARNs, security group id
  infra/sql/schema.sql           PostgreSQL source DDL (Task 3)
  infra/sql/schema-tidb.sql      Hand-written TiDB target DDL matching schema.sql (Task 3)
  runner/main.ts                 Entry point: wires phases, controls, emitter (Task 9)
  runner/src/checksum.ts          Pure per-table checksum SQL builder (Task 4, TDD)
  runner/src/row-count-diff.ts    Pure row-count-diff calculation (Task 4, TDD)
  runner/src/freshness.ts         Pure freshness-from-timestamps calculation (Task 5, TDD)
  runner/src/cutover-timer.ts     Pure elapsed-time-to-downtime-seconds calculation (Task 5, TDD)
  runner/src/dms-poller.ts        I/O adapter: DescribeTableStatistics polling (Task 6, manual live-run)
  runner/src/cloudwatch-poller.ts I/O adapter: GetMetricData for CDCLatencySource/Target (Task 6, manual live-run)
  runner/src/pg-client.ts         I/O adapter: Aurora PostgreSQL connection + heartbeat insert (Task 7, manual live-run)
  runner/src/load-generator.ts    I/O adapter: baseline + burst write load against Aurora PostgreSQL (Task 7, manual live-run)
  test/manifest.test.ts           Parses manifest.json with DemoManifestSchema (Task 1)
  test/checksum.test.ts           Vitest for runner/src/checksum.ts (Task 4)
  test/row-count-diff.test.ts     Vitest for runner/src/row-count-diff.ts (Task 4)
  test/freshness.test.ts          Vitest for runner/src/freshness.ts (Task 5)
  test/cutover-timer.test.ts      Vitest for runner/src/cutover-timer.ts (Task 5)
  traces/featured.json            Recorded run, committed after capture (Task 12)
```

## 7. Tasks

### Task 1: Manifest

- [ ] Write `demos/aws-dms/manifest.json`:

```json
{
  "id": "aws-dms",
  "number": 1,
  "title": "AWS DMS: Aurora PostgreSQL to TiDB",
  "tagline": "Full load, live CDC, and a measured cutover from Aurora PostgreSQL to TiDB using AWS DMS.",
  "integrations": ["aws-dms", "aurora-postgresql"],
  "pattern": "Fintech evaluating a move from Aurora PostgreSQL to TiDB, testing AWS DMS full load plus CDC as the migration path.",
  "publish": true,
  "runner": { "command": ["node", "--import", "tsx", "runner/main.ts"], "cwd": "." },
  "nodes": [
    { "id": "app-writer", "label": "App / load generator", "kind": "client", "x": 8, "y": 20 },
    { "id": "aurora-pg", "label": "Aurora PostgreSQL (source)", "kind": "source", "x": 12, "y": 55 },
    { "id": "dms", "label": "AWS DMS (full load + CDC)", "kind": "service", "x": 48, "y": 55 },
    { "id": "tidb", "label": "TiDB Cloud (target)", "kind": "tidb", "x": 85, "y": 55 },
    { "id": "validator", "label": "Validator", "kind": "service", "x": 48, "y": 88 }
  ],
  "edges": [
    { "id": "writes", "from": "app-writer", "to": "aurora-pg", "label": "writes", "unit": "rows/s" },
    { "id": "full-load", "from": "aurora-pg", "to": "dms", "label": "full load + CDC", "unit": "rows/s" },
    { "id": "applied", "from": "dms", "to": "tidb", "label": "applied", "unit": "rows/s" }
  ],
  "metrics": [
    { "id": "full_load_rows_sec", "label": "Full load throughput", "unit": "rows/s", "display": "both", "better": "higher", "group": "full-load", "howMeasured": "Delta of FullLoadRows from DescribeTableStatistics between ticks, divided by tick interval seconds." },
    { "id": "full_load_pct", "label": "Full load completion", "unit": "%", "display": "tile", "better": "higher", "group": "full-load", "howMeasured": "FullLoadRows / sourceRowCount * 100 per table, sourceRowCount taken once via SELECT COUNT(*) on Aurora PostgreSQL at phase start." },
    { "id": "cdc_latency_source_s", "label": "CDC latency (source)", "unit": "s", "display": "series", "better": "lower", "group": "cdc", "howMeasured": "CloudWatch metric CDCLatencySource (namespace AWS/DMS), most recent datapoint per tick via GetMetricData." },
    { "id": "cdc_latency_target_s", "label": "CDC latency (target)", "unit": "s", "display": "series", "better": "lower", "group": "cdc", "howMeasured": "CloudWatch metric CDCLatencyTarget (namespace AWS/DMS), most recent datapoint per tick via GetMetricData." },
    { "id": "cdc_apply_rows_sec", "label": "CDC apply throughput", "unit": "rows/s", "display": "both", "better": "higher", "group": "cdc", "howMeasured": "Delta of AppliedInserts + AppliedUpdates + AppliedDeletes from DescribeTableStatistics between ticks, divided by tick interval seconds." },
    { "id": "validation_failed_rows", "label": "Validation failures", "unit": "rows", "display": "tile", "better": "lower", "group": "validate", "howMeasured": "ValidationFailedRecords from DescribeTableStatistics, summed across tables." },
    { "id": "row_count_diff", "label": "Row count difference", "unit": "rows", "display": "tile", "better": "lower", "group": "validate", "howMeasured": "ABS(pg_count - tidb_count) from the runner's own SELECT COUNT(*) on both databases." },
    { "id": "heartbeat_freshness_ms", "label": "End-to-end freshness", "unit": "ms", "display": "series", "better": "lower", "group": "cdc", "howMeasured": "visibleAt - insertedAt for a timestamped heartbeat row inserted into Aurora PostgreSQL and polled for on TiDB." },
    { "id": "cutover_downtime_s", "label": "Cutover downtime", "unit": "s", "display": "tile", "better": "lower", "group": "cutover", "howMeasured": "Wall-clock seconds from stopping the load generator to confirming a successful write against the new TiDB connection." }
  ],
  "phases": [
    { "id": "provision", "label": "Provision and verify", "narration": "Aurora PostgreSQL, AWS DMS, and TiDB Cloud are up. This is the same DMS you already use for other migrations." },
    { "id": "schema", "label": "Schema conversion", "narration": "DMS creates tables and primary keys. Everything else in the type conversion is explicit, and we show you exactly what changed." },
    { "id": "full-load", "label": "Full load", "narration": "DMS full-loads the existing orders and accounts tables while the app keeps taking traffic." },
    { "id": "cdc-live", "label": "CDC under live load", "narration": "Now every insert, update, and delete on Aurora flows through logical replication into TiDB, live." },
    { "id": "validate", "label": "Validate", "narration": "We don't just trust DMS's validation state, we recompute row counts and checksums ourselves on both databases." },
    { "id": "cutover", "label": "Cutover", "narration": "Writes stop, CDC drains to zero lag, we verify one more time, then the app points at TiDB. That whole window is the downtime we measure." }
  ],
  "checks": [
    { "id": "schema-parity", "label": "Schema parity", "description": "Every TiDB column has a documented source PostgreSQL type in the plan's mapping table." },
    { "id": "row-count-match", "label": "Row count match", "description": "SELECT COUNT(*) is equal on Aurora PostgreSQL and TiDB for every migrated table." },
    { "id": "checksum-match", "label": "Checksum match", "description": "A per-table checksum aggregate is equal on both sides." },
    { "id": "cutover-clean", "label": "Clean cutover", "description": "CDCLatencyTarget is 0 and both row-count-match and checksum-match pass immediately before the connection flip." }
  ],
  "controls": [
    { "id": "burst-writes", "label": "Burst writes", "description": "Raise the load generator's write rate against Aurora PostgreSQL for 30 seconds." },
    { "id": "run-validation", "label": "Run validation", "description": "Compute row counts and checksums on both databases and emit check events." },
    { "id": "start-cutover", "label": "Start cutover", "description": "Stop the load generator, drain CDC latency to zero, re-validate, then flip the app's connection to TiDB." }
  ]
}
```

- [ ] Write `demos/aws-dms/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('aws-dms manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8');
    const result = DemoManifestSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/manifest.test.ts` - expected FAIL (`@lab/contract` not yet a dependency, no `package.json`/`tsconfig.json` in this folder).
- [ ] Write `demos/aws-dms/package.json`:

```json
{
  "name": "@lab/demo-aws-dms",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "pg": "^8.13.0",
    "@aws-sdk/client-database-migration-service": "^3.700.0",
    "@aws-sdk/client-cloudwatch": "^3.700.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] Write `demos/aws-dms/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["runner/**/*.ts", "test/**/*.ts"]
}
```

- [ ] Run: `cd demos/aws-dms && pnpm install && pnpm vitest run test/manifest.test.ts` - expected PASS.
- [ ] Commit: `git add demos/aws-dms/manifest.json demos/aws-dms/package.json demos/aws-dms/tsconfig.json demos/aws-dms/test/manifest.test.ts && git commit -m "aws-dms: add manifest and package scaffold"`

### Task 2: Infrastructure (manual live-run, I/O-heavy Terraform, no unit tests)

- [ ] Write `demos/aws-dms/infra/terraform/variables.tf` with inputs: `aws_region`, `aurora_instance_class` (default `db.t4g.medium`, smallest supported for logical replication CDC), `dms_instance_class` (default `dms.t3.large` per Section 4), `vpc_cidr`, `tidb_cloud_cidr_or_privatelink_service_name`.
- [ ] Write `demos/aws-dms/infra/terraform/main.tf` provisioning: a VPC with 2 private subnets + 1 public subnet + NAT gateway (per the network options in Section 4), an Aurora PostgreSQL cluster (`engine = "aurora-postgresql"`, cluster parameter group with `rds.logical_replication = 1`), a DMS replication instance (`dms.t3.large`, in the private subnets), a DMS source endpoint pointing at the Aurora cluster, and IAM roles DMS requires (`dms-vpc-role`, `dms-cloudwatch-logs-role`).
- [ ] Write `demos/aws-dms/infra/terraform/outputs.tf` exporting the Aurora writer endpoint, the DMS replication instance ARN, and the security group ID to add to the TiDB Cloud traffic filter.
- [ ] Manual live-run: `cd demos/aws-dms/infra/terraform && terraform init && terraform apply` - expected output: `Apply complete!` with `aurora_endpoint`, `dms_replication_instance_arn` in the outputs.
- [ ] Manual step (console, not Terraform in this pass - mark as a documented manual step in README per Section 5): create the TiDB Cloud Dedicated cluster, note its host/port, add the DMS replication instance's public and private IPs to its traffic filter, and download its CA certificate per [Connect AWS DMS to TiDB Cloud](https://docs.pingcap.com/tidbcloud/tidb-cloud-connect-aws-dms/).
- [ ] Manual live-run: in the AWS DMS console, create the TiDB target endpoint (MySQL engine, SSL mode `verify-full` if public endpoint or `none` if private, extra connection attribute `Initstmt=SET FOREIGN_KEY_CHECKS=0;`), then click **Run test** - expected: connection test status **successful**.
- [ ] Manual live-run: create the DMS migration task (source: Aurora endpoint, target: TiDB endpoint, migration type **Migrate existing data and replicate ongoing changes**, table mappings scoped to the `lab` schema only, **Turn on validation** enabled) - expected: task status becomes **Ready**.
- [ ] Commit: `git add demos/aws-dms/infra/terraform && git commit -m "aws-dms: add Terraform for Aurora PostgreSQL and DMS"`

### Task 3: Schema (manual live-run, DDL has no pure logic to unit test)

- [ ] Write `demos/aws-dms/infra/sql/schema.sql` (PostgreSQL source):

```sql
CREATE TABLE accounts (
  account_id SERIAL PRIMARY KEY,
  external_ref UUID NOT NULL DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  risk_tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  order_id BIGSERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(account_id),
  amount NUMERIC(18,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE heartbeat (
  heartbeat_id BIGSERIAL PRIMARY KEY,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] Write `demos/aws-dms/infra/sql/schema-tidb.sql` (hand-written TiDB target, per the type mapping in Section 4):

```sql
CREATE TABLE accounts (
  account_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  external_ref VARCHAR(36) NOT NULL,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  risk_tags TEXT NOT NULL,
  metadata JSON NOT NULL,
  opened_at DATETIME NOT NULL,
  INDEX idx_accounts_active (is_active)
);

CREATE TABLE orders (
  order_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL,
  placed_at DATETIME NOT NULL,
  INDEX idx_orders_account (account_id),
  INDEX idx_orders_status (status)
);

CREATE TABLE heartbeat (
  heartbeat_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inserted_at DATETIME NOT NULL
);
```

- [ ] Manual live-run: `psql "$PG_CONN_STRING" -f demos/aws-dms/infra/sql/schema.sql` - expected output: three `CREATE TABLE` confirmations.
- [ ] Manual live-run: `mysql -h "$TIDB_HOST" -P "$TIDB_PORT" -u "$TIDB_USER" -p"$TIDB_PASSWORD" "$TIDB_DATABASE" < demos/aws-dms/infra/sql/schema-tidb.sql` - expected: no output on success (or `Query OK` per statement with `-v`).
- [ ] Commit: `git add demos/aws-dms/infra/sql && git commit -m "aws-dms: add PostgreSQL source and TiDB target DDL"`

### Task 4: Pure logic - checksum and row-count-diff

- [ ] Write `demos/aws-dms/test/checksum.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildChecksumQuery } from '../runner/src/checksum';

describe('buildChecksumQuery', () => {
  it('builds a postgres checksum query summing a CRC32-style hash of concatenated columns', () => {
    const query = buildChecksumQuery({ dialect: 'postgres', table: 'orders', columns: ['order_id', 'amount', 'status'] });
    expect(query).toBe(
      "SELECT COALESCE(SUM(('x' || substr(md5(CONCAT_WS('|', order_id, amount, status)), 1, 8))::bit(32)::bigint), 0) AS checksum FROM orders",
    );
  });

  it('builds a mysql-compatible checksum query using the same hash shape', () => {
    const query = buildChecksumQuery({ dialect: 'mysql', table: 'orders', columns: ['order_id', 'amount', 'status'] });
    expect(query).toBe(
      "SELECT COALESCE(SUM(CONV(SUBSTRING(MD5(CONCAT_WS('|', order_id, amount, status)), 1, 8), 16, 10)), 0) AS checksum FROM orders",
    );
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/checksum.test.ts` - expected FAIL (`runner/src/checksum.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/checksum.ts`:

```ts
export type ChecksumDialect = 'postgres' | 'mysql';

export type ChecksumQueryOptions = {
  readonly dialect: ChecksumDialect;
  readonly table: string;
  readonly columns: readonly string[];
};

export const buildChecksumQuery = (options: ChecksumQueryOptions): string => {
  const columnList = options.columns.join(', ');
  if (options.dialect === 'postgres') {
    return `SELECT COALESCE(SUM(('x' || substr(md5(CONCAT_WS('|', ${columnList})), 1, 8))::bit(32)::bigint), 0) AS checksum FROM ${options.table}`;
  }
  return `SELECT COALESCE(SUM(CONV(SUBSTRING(MD5(CONCAT_WS('|', ${columnList})), 1, 8), 16, 10)), 0) AS checksum FROM ${options.table}`;
};
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/checksum.test.ts` - expected PASS.
- [ ] Write `demos/aws-dms/test/row-count-diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rowCountDiff } from '../runner/src/row-count-diff';

describe('rowCountDiff', () => {
  it('returns zero when both counts match', () => {
    expect(rowCountDiff({ sourceCount: 1000, targetCount: 1000 })).toBe(0);
  });

  it('returns the absolute difference when counts do not match', () => {
    expect(rowCountDiff({ sourceCount: 1000, targetCount: 994 })).toBe(6);
    expect(rowCountDiff({ sourceCount: 994, targetCount: 1000 })).toBe(6);
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/row-count-diff.test.ts` - expected FAIL (`runner/src/row-count-diff.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/row-count-diff.ts`:

```ts
export type RowCountDiffOptions = {
  readonly sourceCount: number;
  readonly targetCount: number;
};

export const rowCountDiff = (options: RowCountDiffOptions): number =>
  Math.abs(options.sourceCount - options.targetCount);
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/row-count-diff.test.ts` - expected PASS.
- [ ] Commit: `git add demos/aws-dms/runner/src/checksum.ts demos/aws-dms/runner/src/row-count-diff.ts demos/aws-dms/test/checksum.test.ts demos/aws-dms/test/row-count-diff.test.ts && git commit -m "aws-dms: add checksum and row-count-diff pure logic"`

### Task 5: Pure logic - freshness and cutover timer

- [ ] Write `demos/aws-dms/test/freshness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { freshnessMs } from '../runner/src/freshness';

describe('freshnessMs', () => {
  it('returns the millisecond gap between insertion and visibility', () => {
    expect(freshnessMs({ insertedAtMs: 1000, visibleAtMs: 1250 })).toBe(250);
  });

  it('returns zero when visibility is immediate', () => {
    expect(freshnessMs({ insertedAtMs: 1000, visibleAtMs: 1000 })).toBe(0);
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/freshness.test.ts` - expected FAIL (`runner/src/freshness.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/freshness.ts`:

```ts
export type FreshnessOptions = {
  readonly insertedAtMs: number;
  readonly visibleAtMs: number;
};

export const freshnessMs = (options: FreshnessOptions): number =>
  options.visibleAtMs - options.insertedAtMs;
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/freshness.test.ts` - expected PASS.
- [ ] Write `demos/aws-dms/test/cutover-timer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cutoverDowntimeSeconds } from '../runner/src/cutover-timer';

describe('cutoverDowntimeSeconds', () => {
  it('converts a millisecond span to seconds rounded to one decimal', () => {
    expect(cutoverDowntimeSeconds({ stoppedAtMs: 0, confirmedAtMs: 4300 })).toBe(4.3);
  });

  it('returns zero for a zero-length span', () => {
    expect(cutoverDowntimeSeconds({ stoppedAtMs: 1000, confirmedAtMs: 1000 })).toBe(0);
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/cutover-timer.test.ts` - expected FAIL (`runner/src/cutover-timer.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/cutover-timer.ts`:

```ts
export type CutoverTimerOptions = {
  readonly stoppedAtMs: number;
  readonly confirmedAtMs: number;
};

export const cutoverDowntimeSeconds = (options: CutoverTimerOptions): number =>
  Math.round(((options.confirmedAtMs - options.stoppedAtMs) / 1000) * 10) / 10;
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/cutover-timer.test.ts` - expected PASS.
- [ ] Commit: `git add demos/aws-dms/runner/src/freshness.ts demos/aws-dms/runner/src/cutover-timer.ts demos/aws-dms/test/freshness.test.ts demos/aws-dms/test/cutover-timer.test.ts && git commit -m "aws-dms: add freshness and cutover-timer pure logic"`

### Task 6: I/O adapters - DMS and CloudWatch pollers (manual live-run)

- [ ] Write `demos/aws-dms/runner/src/dms-poller.ts`, an adapter around `@aws-sdk/client-database-migration-service`'s `DescribeTableStatisticsCommand`, returning `{ tableName, fullLoadRows, appliedInserts, appliedUpdates, appliedDeletes, validationFailedRecords, tableState }` per table. Before writing the field access, confirm the exact response field names and casing against the live API response captured below (the UNVERIFIED item in Section 4).
- [ ] Manual live-run: `aws dms describe-table-statistics --replication-task-arn "$DMS_TASK_ARN" --region "$AWS_REGION"` - expected output: a JSON array under `TableStatistics` with fields including `FullLoadRows`, `AppliedInserts`, `AppliedUpdates`, `AppliedDeletes`, `ValidationState`, `TableState`; copy the exact field names from this output into `dms-poller.ts` (do not guess ahead of this step).
- [ ] Write `demos/aws-dms/runner/src/cloudwatch-poller.ts`, an adapter around `@aws-sdk/client-cloudwatch`'s `GetMetricDataCommand` for the `AWS/DMS` namespace, metrics `CDCLatencySource` and `CDCLatencyTarget`.
- [ ] Manual live-run: `aws cloudwatch list-metrics --namespace AWS/DMS --metric-name CDCLatencySource --region "$AWS_REGION"` - expected output: a `Metrics` array whose `Dimensions` show the exact dimension names (`ReplicationInstanceIdentifier`, `ReplicationTaskIdentifier`, or both) to use in `GetMetricData`; copy those dimension names into `cloudwatch-poller.ts`.
- [ ] Manual live-run: `aws cloudwatch get-metric-data --metric-data-queries file://demos/aws-dms/infra/cloudwatch-query.json --start-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --region "$AWS_REGION"` - expected output: `MetricDataResults` with non-empty `Values` once the task is in CDC.
- [ ] Commit: `git add demos/aws-dms/runner/src/dms-poller.ts demos/aws-dms/runner/src/cloudwatch-poller.ts && git commit -m "aws-dms: add DMS and CloudWatch polling adapters"`

### Task 7: I/O adapters - PostgreSQL client, load generator, heartbeat (manual live-run)

- [ ] Write `demos/aws-dms/runner/src/pg-client.ts`, wrapping `pg.Pool` configured from `PG_HOST`/`PG_PORT`/`PG_USER`/`PG_PASSWORD`/`PG_DATABASE`, exposing `insertHeartbeat()`, `countRows(table)`, and `runChecksum(table, columns)` using `buildChecksumQuery({ dialect: 'postgres', ... })`.
- [ ] Write `demos/aws-dms/runner/src/load-generator.ts`, using `every` from `@lab/runner-kit` to insert a baseline rate of `accounts`/`orders` rows against `pg-client.ts` each tick, with a `burst()` method that raises the rate for 30 seconds when the `burst-writes` control fires.
- [ ] Manual live-run: `PG_HOST=... PG_PORT=... PG_USER=... PG_PASSWORD=... PG_DATABASE=... node --import tsx -e "import('./demos/aws-dms/runner/src/pg-client.ts').then(m => m.createPgClient().insertHeartbeat()).then(console.log)"` - expected output: the inserted heartbeat row's `heartbeat_id` and `inserted_at`.
- [ ] Manual live-run: same pattern calling `countRows('orders')` - expected output: a number matching `psql -c 'SELECT COUNT(*) FROM orders'` run independently.
- [ ] Commit: `git add demos/aws-dms/runner/src/pg-client.ts demos/aws-dms/runner/src/load-generator.ts && git commit -m "aws-dms: add PostgreSQL client and load generator adapters"`

### Task 8: Runner main and control wiring

- [ ] Write `demos/aws-dms/runner/main.ts` wiring `createEmitter`, `onControl`, `every` (1000ms tick), the DMS poller, CloudWatch poller, PostgreSQL client, TiDB pool from `createTidbPool`, and the phase sequence from Section 2: `provision` (health checks) to `schema` (log the DDL mapping) to `full-load` (poll `DescribeTableStatistics` until `TableState` is `Table completed` for all tables) to `cdc-live` (poll CDC metrics, start the load generator) to `validate` (on `run-validation` control: row-count-diff and checksum-match checks) to `cutover` (on `start-cutover` control: stop load generator, poll `cdc_latency_target_s` until it reports 0 for three consecutive ticks, re-run validate, then emit `cutover_downtime_s` and a `log` confirming the app's new TiDB connection accepted a write).
- [ ] Manual live-run: `pnpm lab run aws-dms --record` with the Terraform infra from Task 2 up and DMS task running - expected: the relay's `/health` returns `{"ok":true,"demo":"aws-dms"}`, and `curl -N http://localhost:7070/events` streams `phase` events advancing through all six phases without a `log` event at `error` level.
- [ ] Manual live-run: `curl -X POST http://localhost:7070/control/burst-writes` during the `cdc-live` phase - expected: `cdc_apply_rows_sec` visibly rises in the next few `metric` events.
- [ ] Manual live-run: `curl -X POST http://localhost:7070/control/run-validation` - expected: `check` events for `row-count-match` and `checksum-match` both reach `pass`.
- [ ] Manual live-run: `curl -X POST http://localhost:7070/control/start-cutover` - expected: `cdc_latency_target_s` reaches `0`, `check` event `cutover-clean` reaches `pass`, and a final `metric` event for `cutover_downtime_s` is emitted.
- [ ] Commit: `git add demos/aws-dms/runner/main.ts && git commit -m "aws-dms: wire runner phases and controls"`

### Task 9: Validation and public-content gate

- [ ] Manual live-run: `pnpm lab validate aws-dms` - expected: `manifest valid`, and once `traces/featured.json` exists (Task 12), `trace valid, 0 eventReferenceErrors`.
- [ ] Manual live-run: `pnpm lab check-public` - expected: no denylisted terms found in `demos/aws-dms/**`.
- [ ] Commit only if this step required fixes: `git add demos/aws-dms && git commit -m "aws-dms: fix validation/public-content findings"`

## 8. Recording the featured trace

1. Bring up infra (Task 2) and confirm the DMS task is `Ready` with an empty target schema freshly loaded from Task 3.
2. Set `.env` (`cp .env.example .env` and fill in `TIDB_*`, `PG_*`, `DMS_REPLICATION_INSTANCE_ARN`, `DMS_TASK_ARN`, `AWS_REGION`), and set `LAB_ENV_TIDB` to the TiDB Cloud version shown in the cluster's console overview page, `LAB_ENV_NOTES` to the AWS region and DMS instance class used.
3. Run `pnpm lab run aws-dms --record --port 7070` and open the UI (`pnpm --filter @lab/ui dev`) pointed at `http://localhost:7070`.
4. Let `provision` and `schema` phases complete, then start the DMS task so `full-load` begins; once full load finishes and CDC starts, press **Burst writes** once during `cdc-live` to show throughput rising, then **Run validation**, then **Start cutover**. A good run is 3-6 minutes end to end with no `log` events at `error` level and every check reaching `pass`.
5. Stop the runner (Ctrl-C) to flush `demos/aws-dms/traces/<ISO timestamp>.json`.
6. Promote it: `cp demos/aws-dms/traces/<ISO timestamp>.json demos/aws-dms/traces/featured.json`.
7. Run `pnpm lab validate aws-dms` and `pnpm lab check-public` - both must pass before committing `traces/featured.json`.

## 9. Risks and gotchas

- **`rds.logical_replication` is a static parameter.** Setting it requires an Aurora instance reboot; do this during Task 2's `terraform apply`, before any data is loaded, not mid-demo.
- **Aurora PostgreSQL version matters for CDC.** Confirm the cluster's engine version maps to Aurora PostgreSQL 2.2/PG 10.6-compatible or higher (Section 4); anything lower silently supports full load only and CDC never starts.
- **DMS validation and checksum checks both need a primary key on every table.** The schema in Task 3 gives every table one; if this plan is extended with more tables, keep that rule or `row-count-match`/`checksum-match` degrade per the PostgreSQL-source limitations in Section 4.
- **NUMERIC without precision/scale silently truncates.** Every `NUMERIC` column in `schema.sql` declares explicit precision and scale for this reason (Section 4); do not add an unscoped `NUMERIC` column later without re-checking this.
- **TiDB system databases must be filtered out of DMS table mappings.** Use an explicit schema/table selector, never `%`, per Section 4, or the task fails trying to migrate `mysql`/`sys`/`INFORMATION_SCHEMA`.
- **CloudWatch metric propagation lag.** `CDCLatencySource`/`CDCLatencyTarget` can take up to a minute to appear after CDC starts; the `cutover` phase's "poll until zero for three consecutive ticks" rule exists specifically to avoid cutting over on a stale/missing datapoint.
- **DMS Serverless is unverified for this pairing end-to-end (Section 4).** Default to a classic replication instance; only try DMS Serverless as a follow-up experiment once the base demo is recorded.
- **`DescribeTableStatistics` field names are UNVERIFIED against the live API in this plan.** Task 6 requires running the raw `aws dms describe-table-statistics` CLI call and copying real field names before writing `dms-poller.ts`; do not hand-write field names from memory.
- **Cost creep from an idle Aurora/DMS/TiDB Cloud stack.** Follow the exact teardown commands in Section 5 immediately after recording; re-verify with the listed `aws dms`/`aws rds` describe calls and the TiDB Cloud console before ending the work session.
