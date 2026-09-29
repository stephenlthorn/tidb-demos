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
| cdc_latency_source_s | CDC latency (source) | s | series | lower | CloudWatch metric `CDCLatencySource` (namespace `AWS/DMS`, dimension `ReplicationInstanceIdentifier` and `ReplicationTaskIdentifier`), read via `GetMetricData`, most recent datapoint per tick. **VERIFIED live (2026-09-29)**: both dimensions are required, but `ReplicationTaskIdentifier`'s value is the task's CloudWatch resource id (the last colon-separated segment of the replication task ARN, e.g. `6WOZGNMC4FER5N46WKKMXPC4RY`), not the human-readable task identifier/name (`tidb-lab-aws-dms-task`); `ReplicationInstanceIdentifier`'s value is the instance's name as expected. Confirmed with `aws cloudwatch list-metrics --namespace AWS/DMS --metric-name CDCLatencyTarget`, which listed one series per dimension pair actually publishing data (Section 8 Build notes). |
| cdc_latency_target_s | CDC latency (target) | s | series | lower | CloudWatch metric `CDCLatencyTarget`, same namespace and read path as above. |
| cdc_apply_rows_sec | CDC apply throughput | rows/s | series | higher | Delta of `AppliedInserts + AppliedUpdates + AppliedDeletes` from `DescribeTableStatistics` between ticks, divided by tick interval seconds. |
| validation_failed_rows | Validation failures | rows | tile | lower | `ValidationFailedRecords` from `DescribeTableStatistics`, summed across tables (requires validation turned on for the task). |
| row_count_diff | Row count difference | rows | tile | lower | `ABS(pg_count - tidb_count)` from the demo's own `SELECT COUNT(*)` on both sides, run by the `run-validation` control (direct measurement, not vendor-reported). |
| heartbeat_freshness_ms | End-to-end freshness | ms | series | lower | Runner inserts a timestamped heartbeat row into Aurora PostgreSQL every tick, then polls TiDB for that row's arrival; freshness is `visibleAt - insertedAt` in milliseconds (direct measurement). |
| cutover_downtime_s | Cutover downtime | s | tile | lower | Wall-clock seconds between the runner stopping the load generator and the runner confirming the app's new TiDB connection accepts a write, timed with `Date.now()` inside the runner (direct measurement). |

## 4. Verified facts and sources

**Decision (this build):** the TiDB target is a **TiDB Cloud Starter** cluster, reached over Starter's public endpoint with TLS, not TiDB Cloud Dedicated. Wherever a demo in this repo can run on Starter instead of Dedicated, the user's standing preference is to prefer Starter: it needs no VPC/PrivateLink setup on the TiDB Cloud side, no cluster-creation lead time, and no per-node-hour billing while idle. The cluster itself is created by a separate, concurrently-built module (`infra/tidbcloud-starter`), which writes `TIDB_HOST`/`TIDB_PORT`/`TIDB_USER`/`TIDB_PASSWORD` into `demos/aws-dms/.env`; this demo's Terraform takes those as input variables (`tidb_host`, `tidb_port`, `tidb_user`, `tidb_password`) rather than creating or managing the TiDB Cloud cluster. Every Dedicated/PrivateLink/VPC-peering resource that an earlier draft of this plan's Terraform included has been removed from `infra/terraform/main.tf`; the DMS replication instance instead reaches TiDB Cloud Starter's public endpoint directly over an internet gateway (Section 5).

| Fact | Source | Status |
|---|---|---|
| TiDB Cloud (Serverless/Essential and Dedicated) is a documented AWS DMS target using the MySQL endpoint type; DMS creates tables and primary keys only, not secondary indexes, foreign keys, or user accounts. | [Migrate from MySQL-Compatible Databases to TiDB Cloud Using AWS DMS](https://docs.pingcap.com/tidbcloud/migrate-from-mysql-using-aws-dms/) | Verified |
| Dedicated clusters support public endpoint, AWS PrivateLink private endpoint, and VPC peering; Serverless/Essential support public endpoint or AWS PrivateLink only (no VPC peering). SSL mode should be `verify-full` over public endpoint, and can be `none` over private endpoint. Dedicated CA cert comes from the TLS-to-Dedicated doc; Serverless/Essential uses the public ISRG Root X1 cert. **This build uses the public-endpoint path only** (Starter, no PrivateLink, no VPC peering): `ssl_mode = "verify-full"` on the DMS target endpoint, with the ISRG Root X1 certificate imported into DMS as an `aws_dms_certificate` (`certificate_pem` from `letsencrypt.org/certs/isrgrootx1.pem`, committed at `infra/terraform/certs/isrg-root-x1.pem` since it is a public root certificate, not a secret) and referenced from the endpoint's `certificate_arn`. | [Connect AWS DMS to TiDB Cloud](https://docs.pingcap.com/tidbcloud/tidb-cloud-connect-aws-dms/) and [TLS Connections to TiDB Cloud Starter or Essential](https://docs.pingcap.com/tidbcloud/secure-connections-to-serverless-clusters/) | Verified |
| DMS replication instance classes include the T3 burstable family: `dms.t3.micro` (2 vCPU / 1 GiB), `dms.t3.small` (2 vCPU / 2 GiB), `dms.t3.medium` (2 vCPU / 4 GiB), `dms.t3.large` (2 vCPU / 8 GiB), plus C5/C6i/R5/R6i and newer families. **This build uses `dms.t3.small`**: it is the smallest class above `dms.t3.micro`, whose 1 GiB of memory risks the OOM failure mode this plan's own PingCAP-sourced guidance below warns about, even though this demo's schema and CDC volume are modest and the task runs for only a couple of hours. | [Choosing the right AWS DMS replication instance](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_ReplicationInstance.Types.html) | Verified |
| `aws_dms_replication_instance` supports `publicly_accessible = true`, which places the instance's network interface in a subnet with a route to an internet gateway and assigns it a public IP, so it can reach a public endpoint (like TiDB Cloud Starter's) without a NAT gateway. The `aws_dms_replication_subnet_group` backing it needs subnets in at least two Availability Zones regardless of `multi_az`. | [Terraform AWS provider: `aws_dms_replication_instance`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dms_replication_instance) and [Terraform AWS provider: `aws_dms_instance_profile`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dms_instance_profile) | Verified |
| Aurora PostgreSQL Serverless v2 is configured with `engine_mode = "provisioned"` (not the older Aurora Serverless v1 `"serverless"` engine mode) plus a `serverlessv2_scaling_configuration { min_capacity, max_capacity }` block on `aws_rds_cluster`, and an `aws_rds_cluster_instance` with `instance_class = "db.serverless"`. Capacity is in Aurora Capacity Units (ACUs, 2 GiB memory each); the documented minimum is 0.5 ACU. | [Terraform AWS provider: `aws_rds_cluster`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/rds_cluster) | Verified |
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
| CloudWatch metric `CDCLatencySource` measures delay (seconds) between the last captured source commit and the replication instance's current time; `CDCLatencyTarget` measures delay between the first unapplied change's source commit time and current time, and is always >= `CDCLatencySource`. | [AWS re:Post: Troubleshoot high source latency on an AWS DMS task](https://repost.aws/knowledge-center/dms-high-source-latency) and [Troubleshooting latency issues in AWS DMS](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Troubleshooting_Latency.html) | **VERIFIED live (2026-09-29)**: namespace `AWS/DMS`, dimensions `ReplicationInstanceIdentifier` (instance name) and `ReplicationTaskIdentifier` (the task ARN's resource id, not its name - see the `cdc_latency_source_s` row in Section 3 and Section 8 Build notes for the live bug this caused). |
| `DescribeTableStatistics` returns per-table `FullLoadRows`, `AppliedInserts`, `AppliedUpdates`, `AppliedDeletes`, `ValidationFailedRecords`, and `TableState`. | Prior knowledge of the AWS DMS API, not fetched from `docs.aws.amazon.com/dms/latest/APIReference` in this session. | **VERIFIED live (2026-09-29)**: `aws dms describe-table-statistics` against the real `tidb-lab-aws-dms-task` returned exactly these fields with this casing for all three tables (`orders`, `accounts`, `heartbeat`). |
| AWS DMS data validation (`Turn on validation` at task creation) independently re-reads source and target rows and reports per-table failures; this demo turns it on and also computes its own row-count and checksum comparisons rather than only trusting the vendor's validation state. | [Migrate from MySQL-Compatible Databases to TiDB Cloud Using AWS DMS](https://docs.pingcap.com/tidbcloud/migrate-from-mysql-using-aws-dms/) (validation option in task wizard) | **Live finding (2026-09-29) supersedes this row**: DMS's built-in validation (`EnableValidation: true`) does not work against a TiDB Cloud Starter target - see the "DMS native validation" row in Section 8 Build notes. This build sets `EnableValidation: false` and relies entirely on the demo's own row-count and checksum comparisons, which is a stronger form of the same "don't just trust the vendor's validation state" design intent this row already documented. |
| AWS DMS pricing (replication instance hourly rate by instance class, plus storage) is on the DMS pricing page; there is no fixed dollar figure recorded in this plan. | [AWS DMS pricing](https://aws.amazon.com/dms/pricing/) | Not fetched this session; URL given for the runner/README to link to. **UNVERIFIED**: confirm current instance-hour rate structure at build time (Section 5). |
| TiDB Cloud pricing (Dedicated node-hour rate, or Essential/Serverless request-based pricing) is on the TiDB Cloud pricing page; no fixed dollar figure is recorded in this plan. | [TiDB Cloud pricing](https://www.pingcap.com/tidb-cloud-pricing/) | Not fetched this session; URL given for the runner/README to link to. **UNVERIFIED**: confirm current tier/pricing structure at build time (Section 5). |
| Aurora PostgreSQL pricing (instance hour by class, storage, I/O) is on the Amazon Aurora pricing page. | [Amazon Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/) | Not fetched this session; URL given for teardown/cost section. **UNVERIFIED**: confirm current instance-class rate at build time (Section 5). |

## 5. Prerequisites, cost, and teardown

**Decision (this build):** TiDB target is TiDB Cloud **Starter**, not Dedicated, reached over Starter's public endpoint with TLS (`verify-full`, ISRG Root X1). The Starter cluster is created and destroyed by the sibling `infra/tidbcloud-starter` module, not by this demo's Terraform. This follows the user's standing preference to use Starter wherever a demo's requirements allow it, rather than Dedicated, because Starter needs no VPC networking setup on the TiDB Cloud side and no cluster-creation lead time. Concretely, this changed the Terraform in `infra/terraform/`:
- Removed: the NAT gateway/EIP and the private route table's default route (Aurora's subnets no longer need outbound internet access), and every Dedicated/PrivateLink/VPC-peering-specific resource and variable (there was no PrivateLink/peering Terraform in the prior draft to remove beyond the `tidb_traffic_filter_cidr` variable, which assumed a Dedicated cluster's traffic filter and has been deleted).
- Added: the DMS replication instance is now `publicly_accessible = true` in a public subnet, reaching TiDB Cloud Starter's public endpoint directly through an internet gateway - cheaper than a NAT gateway for a run measured in hours, since it avoids both the NAT gateway's hourly charge and its per-GB data processing charge, and this demo's DMS-to-TiDB traffic volume is too small for NAT's per-GB savings (if any existed) to matter. An `aws_dms_certificate` importing the public ISRG Root X1 root (committed at `infra/terraform/certs/isrg-root-x1.pem`) is referenced from the target endpoint's `certificate_arn` so `ssl_mode = "verify-full"` can validate the chain.
- Right-sized: `dms_instance_class` defaults to `dms.t3.small` (down from `dms.t3.large`), and Aurora now runs on Serverless v2 at a 0.5 ACU floor (`aws_rds_cluster_instance.instance_class = "db.serverless"`) instead of a provisioned `db.t4g.medium`, because a ~2 hour demo run is cheaper billed per-second at Serverless v2's floor than at a provisioned instance's flat hourly rate for phases (provision, schema-conversion) where the writer is mostly idle. Logical replication (`rds.logical_replication = 1` in the cluster parameter group) is unchanged and still required for CDC.
- Runner reachability fix: the demo's runner (writes, checksums, cutover against Aurora) runs on the coordinator's workstation, not inside this VPC, and this VPC has no bastion or VPN. Aurora's `aws_db_subnet_group` now uses the same public subnets as DMS, `aws_rds_cluster_instance.aurora_writer.publicly_accessible = true`, and the Aurora security group allows inbound 5432 from the DMS security group plus a new required variable `admin_cidr` (the runner workstation's public IP as a `/32`, e.g. `-var admin_cidr=$(curl -s https://checkip.amazonaws.com)/32`; no default, since an open CIDR would expose Aurora to the internet). Because Aurora is now reachable from the public internet, the cluster parameter group also sets `rds.force_ssl = 1` (applied immediately, no reboot) alongside `rds.logical_replication`, and the runner's `pg` connection (`runner/src/pg-client.ts`) sets `ssl: { rejectUnauthorized: false }` when `PG_SSL=true` (added to `.env.example`) - this encrypts the connection per `rds.force_ssl` without needing the RDS CA bundle bundled into the repo, which is an acceptable simplification for a short-lived demo cluster whose password rotates every run. `outputs.tf` adds `aurora_writer_endpoint` to fill `.env`'s `PG_HOST`.

- Accounts and access: an AWS account with permission to create RDS/Aurora, DMS, VPC, and IAM resources; a TiDB Cloud account with a Starter cluster in `us-west-2` (created by `infra/tidbcloud-starter`, not by this demo).
- Local tools: macOS, Docker Desktop (not required to run this demo locally since all data stores are cloud-hosted, but used for the relay/UI dev loop), Node 22, pnpm, terraform, aws cli, tiup (unused by this demo directly).
- Cost model: this demo bills for (1) the Aurora PostgreSQL Serverless v2 writer while it runs, billed per ACU-second at its 0.5 ACU floor, (2) the AWS DMS `dms.t3.small` replication instance while it runs, plus its allocated storage, (3) the TiDB Cloud Starter cluster's request-based charges, per the pricing pages linked in Section 4. There is no NAT gateway and no TiDB Cloud PrivateLink/VPC-peering charge in this build. No dollar figures are hardcoded; read the current rate from the linked pricing pages before recording cost in the README.
- Teardown: exact commands, run in this order:
  1. `pnpm lab run aws-dms` runner should already have exited or been Ctrl-C'd.
  2. `cd demos/aws-dms/infra/terraform && terraform destroy -auto-approve` - destroys the DMS replication instance, endpoints, certificate, task, Aurora PostgreSQL Serverless v2 cluster, and the VPC/subnets/security groups/IAM role created for this demo.
  3. Destroy the TiDB Cloud Starter cluster from the sibling `infra/tidbcloud-starter` module (`terraform destroy` there, or the TiDB Cloud console if it was created manually).
  4. Confirm nothing is still billing, in this exact order:
     - `aws dms describe-replication-instances --query 'ReplicationInstances[].ReplicationInstanceIdentifier'` returns an empty list.
     - `aws dms describe-replication-tasks --query 'ReplicationTasks[].ReplicationTaskIdentifier'` returns an empty list (a task can outlive its instance in some failure modes).
     - `aws rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier'` returns an empty list (or does not include this demo's cluster identifier).
     - `aws rds describe-db-cluster-snapshots --query 'DBClusterSnapshots[].DBClusterSnapshotIdentifier'` returns no snapshot for this demo (Terraform's `skip_final_snapshot = true`, set in Task 2, should prevent one, but confirm - a lingering snapshot bills storage even after the cluster is gone).
     - `aws logs describe-log-groups --log-group-name-prefix /aws/dms` shows no log group referencing this task's replication instance id (CloudWatch Logs for DMS are not deleted by `terraform destroy` unless explicitly managed as a resource; delete manually with `aws logs delete-log-group` if present).
     - The TiDB Cloud console's cluster list no longer shows the demo cluster.

## 6. File structure

```
demos/aws-dms/
  manifest.json                 DemoManifestSchema instance (id aws-dms, number 1); see Task 1
  package.json                  @lab/demo-aws-dms, deps @lab/contract + @lab/runner-kit (workspace:*), pg, @aws-sdk/client-database-migration-service, @aws-sdk/client-cloudwatch
  tsconfig.json                 extends ../../tsconfig.base.json
  README.md                     what it proves, prerequisites, run, record, teardown, cost notes (Task 12)
  TALK-TRACK.md                 presenter script per phase, discovery questions, objections (Task 12)
  .env.example                  standard TIDB_* block plus PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE, DMS_REPLICATION_INSTANCE_ARN, DMS_TASK_ARN, DMS_TASK_ID, AWS_REGION
  infra/terraform/versions.tf   terraform + provider version pins (Task 2)
  infra/terraform/main.tf       Aurora PostgreSQL, DMS replication instance/endpoints/task, VPC, security groups, IAM (Task 2)
  infra/terraform/variables.tf  region, instance classes, CIDR blocks, TiDB Cloud connection details as inputs
  infra/terraform/outputs.tf    Aurora endpoint, DMS ARNs, security group id
  infra/terraform/table-mappings.json  DMS table-mappings selection + transformation rules referenced by main.tf (Task 2)
  infra/sql/schema.sql           PostgreSQL source DDL (Task 3)
  infra/sql/schema-tidb.sql      Hand-written TiDB target DDL matching schema.sql (Task 3)
  runner/main.ts                 Entry point: wires phases, controls, emitter (Task 9)
  runner/src/checksum.ts          Pure per-table checksum SQL builder + canonical row encoding (Task 4, TDD)
  runner/src/row-count-diff.ts    Pure row-count-diff calculation (Task 4, TDD)
  runner/src/freshness.ts         Pure freshness-from-timestamps calculation (Task 5, TDD)
  runner/src/cutover-timer.ts     Pure elapsed-time-to-downtime-seconds calculation (Task 5, TDD)
  runner/src/table-stats.ts       Pure DescribeTableStatistics response parsing to per-table progress (Task 6, TDD)
  runner/src/cloudwatch-query.ts  Pure GetMetricData request builder + response parsing (Task 6, TDD)
  runner/src/cutover-state.ts     Pure cutover state machine (running -> draining -> verified -> flipped) (Task 7, TDD)
  runner/src/workload.ts          Pure workload-generator rate schedule (baseline/burst) (Task 7, TDD)
  runner/src/dms-poller.ts        I/O adapter: DescribeTableStatistics polling (Task 8, manual live-run)
  runner/src/cloudwatch-poller.ts I/O adapter: GetMetricData for CDCLatencySource/Target (Task 8, manual live-run)
  runner/src/pg-client.ts         I/O adapter: Aurora PostgreSQL connection + heartbeat insert (Task 9, manual live-run)
  runner/src/load-generator.ts    I/O adapter: baseline + burst write load against Aurora PostgreSQL (Task 9, manual live-run)
  test/manifest.test.ts           Parses manifest.json with DemoManifestSchema (Task 1)
  test/checksum.test.ts           Vitest for runner/src/checksum.ts (Task 4)
  test/row-count-diff.test.ts     Vitest for runner/src/row-count-diff.ts (Task 4)
  test/freshness.test.ts          Vitest for runner/src/freshness.ts (Task 5)
  test/cutover-timer.test.ts      Vitest for runner/src/cutover-timer.ts (Task 5)
  test/table-stats.test.ts        Vitest for runner/src/table-stats.ts (Task 6)
  test/cloudwatch-query.test.ts   Vitest for runner/src/cloudwatch-query.ts (Task 6)
  test/cutover-state.test.ts      Vitest for runner/src/cutover-state.ts (Task 7)
  test/workload.test.ts           Vitest for runner/src/workload.ts (Task 7)
  traces/featured.json            Recorded run, committed after capture (Task 13)
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
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "start": "node --import tsx runner/main.ts"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "pg": "^8.13.0",
    "@aws-sdk/client-database-migration-service": "^3.700.0",
    "@aws-sdk/client-cloudwatch": "^3.700.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "vitest": "^3.2.0",
    "typescript": "^5.9.0"
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

**Superseded by the Starter decision in Section 4/5:** the HCL blocks below this point in Task 2 are the original draft, written against a TiDB Cloud Dedicated cluster reached over PrivateLink/VPC peering. The delivered `infra/terraform/main.tf`, `variables.tf`, and `outputs.tf` differ from what is written here: no NAT gateway (the DMS replication instance is `publicly_accessible` in a public subnet instead), no Dedicated/PrivateLink/VPC-peering resources, `dms.t3.small` in place of `dms.t3.large`, Aurora Serverless v2 (0.5 ACU floor) in place of a provisioned `db.t4g.medium`, and an `aws_dms_certificate` importing ISRG Root X1 for the target endpoint's `verify-full` SSL mode. Treat the actual files in `infra/terraform/` and Section 4/5 as authoritative; this task's code blocks are left as originally drafted for history rather than rewritten line-by-line.

This task provisions a dedicated VPC rather than the account's default VPC, because DMS needs private subnets for the replication instance and Aurora needs a DB subnet group spanning at least two AZs; a dedicated VPC keeps this demo's security groups and routing fully isolated from anything else in the account, and `terraform destroy` cleanly removes all of it. If an existing default VPC with at least two private subnets is available and preferred, `variables.tf` accepts `existing_vpc_id`/`existing_subnet_ids` to skip VPC creation (see the `vpc` module toggle below); the default path in `main.tf` still creates a new VPC because that is safer for a repeatable demo environment that gets destroyed and recreated often.

- [ ] Write `demos/aws-dms/infra/terraform/versions.tf`:

```hcl
terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
```

- [ ] Write `demos/aws-dms/infra/terraform/variables.tf`:

```hcl
variable "aws_region" {
  description = "AWS region for all resources in this demo. Must match the TiDB Cloud Dedicated cluster's region."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to every resource name created by this demo, to make teardown and cost attribution unambiguous."
  type        = string
  default     = "tidb-lab-aws-dms"
}

variable "vpc_cidr" {
  description = "CIDR block for the demo VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for the two private subnets (Aurora + DMS replication instance)."
  type        = list(string)
  default     = ["10.42.1.0/24", "10.42.2.0/24"]
}

variable "public_subnet_cidr" {
  description = "CIDR block for the single public subnet (NAT gateway only; nothing in this demo is publicly reachable)."
  type        = string
  default     = "10.42.0.0/24"
}

variable "availability_zones" {
  description = "Two AZs in aws_region; Aurora and the DMS subnet group both need >= 2 AZs."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL engine version. Must be >= 2.2 (PostgreSQL 10.6-compatible) for CDC support (Section 4)."
  type        = string
  default     = "16.15"
}

variable "aurora_instance_class" {
  description = "Instance class for the single Aurora writer instance. db.t4g.medium is the smallest class this demo has validated for logical-replication CDC without falling behind under the demo's load profile."
  type        = string
  default     = "db.t4g.medium"
}

variable "aurora_master_username" {
  type    = string
  default = "labadmin"
}

variable "aurora_master_password" {
  description = "Master password for the Aurora cluster. Pass via TF_VAR_aurora_master_password or a .tfvars file that is gitignored; never commit a literal value."
  type        = string
  sensitive   = true
}

variable "aurora_database_name" {
  type    = string
  default = "lab"
}

variable "dms_instance_class" {
  description = "DMS replication instance class. dms.t3.large (2 vCPU / 8 GiB) is the minimum PingCAP recommends to avoid OOM during full load (Section 4)."
  type        = string
  default     = "dms.t3.large"
}

variable "dms_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "tidb_host" {
  description = "TiDB Cloud Dedicated cluster host, created out of band per Task 2's manual step. Used only to compute the security group egress rule and is not itself provisioned by Terraform."
  type        = string
}

variable "tidb_port" {
  type    = number
  default = 4000
}

variable "tidb_traffic_filter_cidr" {
  description = "CIDR to add to the TiDB Cloud Dedicated cluster's traffic filter, computed from this VPC's private subnets and passed to the manual traffic-filter step in the README; not applied by Terraform (TiDB Cloud Terraform provider is optional, see the note below the outputs)."
  type        = string
  default     = null
}
```

- [ ] Write `demos/aws-dms/infra/terraform/main.tf`:

```hcl
data "aws_caller_identity" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = "${var.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = var.availability_zones[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name_prefix}-public" }
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  tags              = { Name = "${var.name_prefix}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.name_prefix}-nat-eip" }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "${var.name_prefix}-nat" }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name_prefix}-public-rt" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
  tags = { Name = "${var.name_prefix}-private-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "aurora" {
  name        = "${var.name_prefix}-aurora-sg"
  description = "Aurora PostgreSQL source: inbound 5432 from DMS and the runner's egress, outbound to NAT for patching only."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "PostgreSQL from DMS replication instance"
    from_port        = 5432
    to_port          = 5432
    protocol         = "tcp"
    security_groups  = [aws_security_group.dms.id]
  }

  ingress {
    description = "PostgreSQL from the demo runner (public egress via NAT for local development)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-aurora-sg" }
}

resource "aws_security_group" "dms" {
  name        = "${var.name_prefix}-dms-sg"
  description = "DMS replication instance: outbound to Aurora (5432) and TiDB Cloud (4000), inbound none required."
  vpc_id      = aws_vpc.this.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-dms-sg" }
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.name_prefix}-aurora-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${var.name_prefix}-aurora-subnets" }
}

resource "aws_rds_cluster_parameter_group" "aurora_logical_replication" {
  name        = "${var.name_prefix}-aurora-pg-cpg"
  family      = "aurora-postgresql16"
  description = "Enables logical replication so DMS CDC can use pglogical or test_decoding (Section 4)."

  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier              = "${var.name_prefix}-aurora"
  engine                          = "aurora-postgresql"
  engine_version                  = var.aurora_engine_version
  master_username                 = var.aurora_master_username
  master_password                 = var.aurora_master_password
  database_name                   = var.aurora_database_name
  db_subnet_group_name            = aws_db_subnet_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora_logical_replication.name
  skip_final_snapshot             = true
  apply_immediately                = true
}

resource "aws_rds_cluster_instance" "aurora_writer" {
  identifier           = "${var.name_prefix}-aurora-writer"
  cluster_identifier   = aws_rds_cluster.aurora.id
  engine               = aws_rds_cluster.aurora.engine
  engine_version       = aws_rds_cluster.aurora.engine_version
  instance_class       = var.aurora_instance_class
  publicly_accessible  = false
  apply_immediately    = true
}

resource "aws_dms_replication_subnet_group" "this" {
  replication_subnet_group_id          = "${var.name_prefix}-dms-subnets"
  replication_subnet_group_description = "Private subnets for the DMS replication instance."
  subnet_ids                           = aws_subnet.private[*].id
}

resource "aws_dms_replication_instance" "this" {
  replication_instance_id     = "${var.name_prefix}-repl"
  replication_instance_class  = var.dms_instance_class
  allocated_storage           = var.dms_allocated_storage_gb
  vpc_security_group_ids      = [aws_security_group.dms.id]
  replication_subnet_group_id = aws_dms_replication_subnet_group.this.id
  publicly_accessible         = false
  multi_az                    = false
  depends_on                  = [aws_iam_role_policy_attachment.dms_vpc_role, aws_iam_role_policy_attachment.dms_cloudwatch_logs_role]
}

resource "aws_dms_endpoint" "source_aurora" {
  endpoint_id   = "${var.name_prefix}-source-aurora"
  endpoint_type = "source"
  engine_name   = "aurora-postgresql"
  server_name   = aws_rds_cluster.aurora.endpoint
  port          = 5432
  username      = var.aurora_master_username
  password      = var.aurora_master_password
  database_name = var.aurora_database_name
}

resource "aws_dms_endpoint" "target_tidb" {
  endpoint_id                 = "${var.name_prefix}-target-tidb"
  endpoint_type               = "target"
  engine_name                 = "mysql"
  server_name                 = var.tidb_host
  port                        = var.tidb_port
  username                    = "root"
  password                    = "REPLACE_BEFORE_APPLY"
  database_name               = var.aurora_database_name
  ssl_mode                    = "verify-full"
  extra_connection_attributes = "Initstmt=SET FOREIGN_KEY_CHECKS=0;"

  lifecycle {
    ignore_changes = [password]
  }
}

resource "aws_dms_replication_task" "this" {
  replication_task_id      = "${var.name_prefix}-task"
  replication_instance_arn = aws_dms_replication_instance.this.replication_instance_arn
  source_endpoint_arn      = aws_dms_endpoint.source_aurora.endpoint_arn
  target_endpoint_arn      = aws_dms_endpoint.target_tidb.endpoint_arn
  migration_type           = "full-load-and-cdc"
  table_mappings           = file("${path.module}/table-mappings.json")

  replication_task_settings = jsonencode({
    ValidationSettings = {
      EnableValidation = true
      ThreadCount       = 5
    }
    Logging = {
      EnableLogging = true
    }
  })
}

resource "aws_iam_role" "dms_vpc_role" {
  name = "dms-vpc-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "dms.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dms_vpc_role" {
  role       = aws_iam_role.dms_vpc_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole"
}

resource "aws_iam_role" "dms_cloudwatch_logs_role" {
  name = "dms-cloudwatch-logs-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "dms.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dms_cloudwatch_logs_role" {
  role       = aws_iam_role.dms_cloudwatch_logs_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonDMSCloudWatchLogsRole"
}
```

Notes on this file:

- The IAM roles `dms-vpc-role` and `dms-cloudwatch-logs-role` are fixed names DMS looks for by convention in an account (Section 4); if a previous DMS setup in this account already created them, `terraform apply` fails with "already exists" and the fix is `terraform import aws_iam_role.dms_vpc_role dms-vpc-role` (and the same for the CloudWatch logs role) before re-applying, not renaming the resource.
- `aws_dms_endpoint.target_tidb.password` is a placeholder; replace it with the TiDB Cloud Dedicated cluster's root (or a dedicated migration user's) password via `TF_VAR`-style injection before `terraform apply`, and never commit the real value - the `lifecycle.ignore_changes` block exists so a manual console password rotation is not clobbered by a later `apply`.
- `table_mappings` is loaded from a sibling JSON file instead of being inlined, so it can be edited without touching HCL.

- [ ] Write `demos/aws-dms/infra/terraform/table-mappings.json`:

```json
{
  "rules": [
    {
      "rule-type": "selection",
      "rule-id": "1",
      "rule-name": "select-lab-schema",
      "object-locator": { "schema-name": "public", "table-name": "%" },
      "rule-action": "include"
    },
    {
      "rule-type": "transformation",
      "rule-id": "2",
      "rule-name": "rename-schema-to-lab",
      "rule-target": "schema",
      "object-locator": { "schema-name": "public" },
      "rule-action": "rename",
      "value": "lab"
    }
  ]
}
```

- [ ] Write `demos/aws-dms/infra/terraform/outputs.tf`:

```hcl
output "aurora_cluster_endpoint" {
  value = aws_rds_cluster.aurora.endpoint
}

output "aurora_cluster_reader_endpoint" {
  value = aws_rds_cluster.aurora.reader_endpoint
}

output "dms_replication_instance_arn" {
  value = aws_dms_replication_instance.this.replication_instance_arn
}

output "dms_replication_task_arn" {
  value = aws_dms_replication_task.this.replication_task_arn
}

output "dms_replication_task_id" {
  value = aws_dms_replication_task.this.replication_task_id
}

output "dms_security_group_id" {
  value       = aws_security_group.dms.id
  description = "Add this security group's associated ENI IPs (or the NAT gateway's public IP, if using a public TiDB Cloud endpoint) to the TiDB Cloud Dedicated cluster's traffic filter."
}

output "vpc_id" {
  value = aws_vpc.this.id
}
```

TiDB Cloud itself is not created by this Terraform (the TiDB Cloud Terraform provider exists and can manage a Dedicated cluster, but wiring it is out of scope for this pass to keep the demo's blast radius to AWS-only credentials); the cluster is created manually per the next step, and its host is fed back into `variables.tf`'s `tidb_host` for the `aws_dms_endpoint.target_tidb` resource above.

- [ ] Manual live-run: `cd demos/aws-dms/infra/terraform && terraform init` - expected output ends with `Terraform has been successfully initialized!`.
- [ ] Manual step (console, not Terraform in this pass - mark as a documented manual step in README per Section 5): create the TiDB Cloud Dedicated cluster in the same AWS region as `var.aws_region`, note its host/port, and set `TF_VAR_tidb_host` before applying.
- [ ] Manual live-run: `TF_VAR_aurora_master_password="$(openssl rand -base64 24)" TF_VAR_tidb_host="<tidb-cloud-host>" terraform apply` - expected output: `Apply complete!` with `aurora_cluster_endpoint`, `dms_replication_instance_arn`, `dms_security_group_id` in the outputs.
- [ ] Manual live-run: add the DMS security group's ENI IP (or NAT gateway public IP for a public TiDB Cloud endpoint) to the TiDB Cloud Dedicated cluster's traffic filter, and download its CA certificate, per [Connect AWS DMS to TiDB Cloud](https://docs.pingcap.com/tidbcloud/tidb-cloud-connect-aws-dms/).
- [ ] Manual live-run: update the TiDB endpoint's real password: `aws dms modify-endpoint --endpoint-arn "$(terraform output -raw dms_replication_instance_arn | sed 's/repl-instance/endpoint/')" --password "<tidb-password>"` (or re-apply Terraform with the real password piped through `TF_VAR`), then in the AWS DMS console select the TiDB target endpoint and click **Run test** - expected: connection test status **successful**.
- [ ] Manual live-run: confirm the migration task is ready: `aws dms describe-replication-tasks --filters Name=replication-task-id,Values=$(terraform output -raw dms_replication_task_id) --query 'ReplicationTasks[0].Status'` - expected: `"ready"`.
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

Column-by-column type mapping applied above (Section 4's source table, restated per column for this schema):

| PostgreSQL column | PostgreSQL type | TiDB column | TiDB type | Why |
|---|---|---|---|---|
| `accounts.account_id` | `SERIAL` | `account_id` | `INT AUTO_INCREMENT` | DMS migrates the underlying `INT4`, not the sequence; auto-increment is hand-added. |
| `accounts.external_ref` | `UUID` | `external_ref` | `VARCHAR(36)` | DMS's internal UUID mapping is `STRING`; 36 chars fits the canonical hyphenated form exactly. |
| `accounts.display_name` | `TEXT` | `display_name` | `TEXT` | Direct MySQL-compatible equivalent. |
| `accounts.is_active` | `BOOLEAN` | `is_active` | `BOOLEAN` (TiDB alias for `TINYINT(1)`) | DMS's internal boolean mapping is a 5-char string; hand-declaring avoids trusting that default. |
| `accounts.risk_tags` | `TEXT[]` (array) | `risk_tags` | `TEXT` | DMS's internal array mapping is `NCLOB` (migrated as text); TiDB has no native array type, so the demo stores it as a comma-joined string and documents this as a known lossy conversion, not silently. |
| `accounts.metadata` | `JSONB` | `metadata` | `JSON` | DMS's internal JSONB mapping is also `NCLOB`; hand-declared as TiDB's native `JSON` type since MySQL/TiDB support it directly. |
| `accounts.opened_at` | `TIMESTAMPTZ` | `opened_at` | `DATETIME` | Zone is not preserved by DMS; the runner and load generator always write/read in UTC so the demo's own comparison stays correct without relying on zone data DMS drops. |
| `orders.amount` | `NUMERIC(18,2)` | `amount` | `NUMERIC(18,2)` | Explicit precision/scale on both sides avoids the default-`NUMERIC(28,6)` truncation risk documented in Section 4. |
| `orders.currency` | `CHAR(3)` | `currency` | `CHAR(3)` | Direct equivalent. |
| `orders.placed_at` | `TIMESTAMPTZ` | `placed_at` | `DATETIME` | Same UTC-normalization note as `opened_at`. |

- [ ] Manual live-run: `psql "$PG_CONN_STRING" -f demos/aws-dms/infra/sql/schema.sql` - expected output: three `CREATE TABLE` confirmations.
- [ ] Manual live-run: `mysql -h "$TIDB_HOST" -P "$TIDB_PORT" -u "$TIDB_USER" -p"$TIDB_PASSWORD" "$TIDB_DATABASE" < demos/aws-dms/infra/sql/schema-tidb.sql` - expected: no output on success (or `Query OK` per statement with `-v`).
- [ ] Commit: `git add demos/aws-dms/infra/sql && git commit -m "aws-dms: add PostgreSQL source and TiDB target DDL"`

### Task 4: Pure logic - checksum with canonical row encoding, and row-count-diff

The checksum must produce the **same number** on PostgreSQL and TiDB for the same logical rows, even though the two engines format values differently (PostgreSQL's `NUMERIC` prints trailing zeros differently than MySQL/TiDB's, timestamps carry a time zone on one side and not the other, booleans print as `t`/`f` on PostgreSQL versus `1`/`0` on TiDB). The canonical row encoding fixes this by normalizing every value to one text form before hashing:

- **Ordering:** rows are implicitly ordered by primary key ascending (both `SELECT` statements below add `ORDER BY <pk>` so `CONCAT_WS`-per-row hashing is deterministic per row; the checksum itself is a `SUM()` so cross-row order does not actually affect the aggregate, but the per-row encoding order of columns must match exactly between the two queries).
- **NULL handling:** every column is wrapped so `NULL` normalizes to the fixed 4-character token `\N` (matching the MySQL `LOAD DATA` NULL convention) rather than an empty string, so `NULL` and `''` never collide.
- **Timestamps:** both queries convert to UTC and format as `YYYY-MM-DD HH:MM:SS` with no time zone suffix (PostgreSQL: `to_char(col AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`; TiDB: the column is already zone-naive `DATETIME` written in UTC by the runner, so `DATE_FORMAT(col, '%Y-%m-%d %H:%i:%s')` is sufficient).
- **Numeric scale:** `NUMERIC(p,s)` columns are cast to a fixed-scale text form on both sides (`CAST(col AS NUMERIC(18,2))::text` on PostgreSQL, `CAST(col AS DECIMAL(18,2))` on TiDB) so trailing-zero formatting differences never cause a mismatch.
- **Booleans:** normalized to `'0'`/`'1'` text on both sides (`CASE WHEN col THEN '1' ELSE '0' END` on PostgreSQL; TiDB's `BOOLEAN` already prints as `0`/`1` from `CAST(col AS CHAR)`).
- **JSON:** normalized with each engine's own canonical-JSON function so key order and whitespace do not cause false mismatches (PostgreSQL: `jsonb_col::jsonb::text` - `jsonb` already normalizes whitespace and key type coercion, though it does not sort object keys, so this demo's `metadata` column is written by the load generator with keys always inserted in the same fixed order to keep the comparison valid; TiDB: `CAST(col AS JSON)` similarly re-serializes canonically for the same fixed key order).

- [ ] Write `demos/aws-dms/test/checksum.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildChecksumQuery, normalizedColumnExpression } from '../runner/src/checksum';

describe('normalizedColumnExpression', () => {
  it('wraps a boolean column with dialect-specific 0/1 normalization and NULL handling', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'is_active', type: 'boolean' })).toBe(
      "COALESCE(CASE WHEN is_active THEN '1' ELSE '0' END, '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'is_active', type: 'boolean' })).toBe(
      "COALESCE(CAST(is_active AS CHAR), '\\N')",
    );
  });

  it('wraps a timestamp column normalized to UTC with no zone suffix', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'opened_at', type: 'timestamptz' })).toBe(
      "COALESCE(to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'opened_at', type: 'timestamptz' })).toBe(
      "COALESCE(DATE_FORMAT(opened_at, '%Y-%m-%d %H:%i:%s'), '\\N')",
    );
  });

  it('wraps a numeric column with a fixed precision/scale cast', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'amount', type: 'numeric', precision: 18, scale: 2 })).toBe(
      "COALESCE(CAST(amount AS NUMERIC(18,2))::text, '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'amount', type: 'numeric', precision: 18, scale: 2 })).toBe(
      "COALESCE(CAST(CAST(amount AS DECIMAL(18,2)) AS CHAR), '\\N')",
    );
  });

  it('wraps a plain text/json/uuid column with a simple NULL-safe cast', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'metadata', type: 'json' })).toBe(
      "COALESCE(metadata::jsonb::text, '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'metadata', type: 'json' })).toBe(
      "COALESCE(CAST(metadata AS JSON), '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'external_ref', type: 'text' })).toBe(
      "COALESCE(external_ref::text, '\\N')",
    );
  });
});

describe('buildChecksumQuery', () => {
  it('builds a postgres checksum query over normalized, order-by-pk columns', () => {
    const query = buildChecksumQuery({
      dialect: 'postgres',
      table: 'orders',
      primaryKey: 'order_id',
      columns: [
        { column: 'order_id', type: 'text' },
        { column: 'amount', type: 'numeric', precision: 18, scale: 2 },
        { column: 'status', type: 'text' },
      ],
    });
    expect(query).toBe(
      "SELECT COALESCE(SUM(('x' || substr(md5(CONCAT_WS('|', " +
        "COALESCE(order_id::text, '\\N'), " +
        "COALESCE(CAST(amount AS NUMERIC(18,2))::text, '\\N'), " +
        "COALESCE(status::text, '\\N'))), 1, 8))::bit(32)::bigint), 0) AS checksum " +
        'FROM orders ORDER BY order_id',
    );
  });

  it('builds a mysql-compatible checksum query using the same hash shape', () => {
    const query = buildChecksumQuery({
      dialect: 'mysql',
      table: 'orders',
      primaryKey: 'order_id',
      columns: [
        { column: 'order_id', type: 'text' },
        { column: 'amount', type: 'numeric', precision: 18, scale: 2 },
        { column: 'status', type: 'text' },
      ],
    });
    expect(query).toBe(
      "SELECT COALESCE(SUM(CONV(SUBSTRING(MD5(CONCAT_WS('|', " +
        "COALESCE(CAST(order_id AS CHAR), '\\N'), " +
        "COALESCE(CAST(CAST(amount AS DECIMAL(18,2)) AS CHAR), '\\N'), " +
        "COALESCE(CAST(status AS CHAR), '\\N'))), 1, 8), 16, 10)), 0) AS checksum " +
        'FROM orders ORDER BY order_id',
    );
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/checksum.test.ts` - expected FAIL (`runner/src/checksum.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/checksum.ts`:

```ts
export type ChecksumDialect = 'postgres' | 'mysql';

export type ColumnType = 'text' | 'boolean' | 'timestamptz' | 'numeric' | 'json';

export type ChecksumColumn = {
  readonly column: string;
  readonly type: ColumnType;
  readonly precision?: number;
  readonly scale?: number;
};

export type NormalizedColumnOptions = ChecksumColumn & {
  readonly dialect: ChecksumDialect;
};

const NULL_TOKEN = "'\\N'";

export const normalizedColumnExpression = (options: NormalizedColumnOptions): string => {
  const { dialect, column, type, precision, scale } = options;

  if (type === 'boolean') {
    const raw =
      dialect === 'postgres'
        ? `CASE WHEN ${column} THEN '1' ELSE '0' END`
        : `CAST(${column} AS CHAR)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'timestamptz') {
    const raw =
      dialect === 'postgres'
        ? `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
        : `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s')`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'numeric') {
    const p = precision ?? 18;
    const s = scale ?? 2;
    const raw =
      dialect === 'postgres'
        ? `CAST(${column} AS NUMERIC(${p},${s}))::text`
        : `CAST(CAST(${column} AS DECIMAL(${p},${s})) AS CHAR)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'json') {
    const raw = dialect === 'postgres' ? `${column}::jsonb::text` : `CAST(${column} AS JSON)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  const raw = dialect === 'postgres' ? `${column}::text` : `CAST(${column} AS CHAR)`;
  return `COALESCE(${raw}, ${NULL_TOKEN})`;
};

export type ChecksumQueryOptions = {
  readonly dialect: ChecksumDialect;
  readonly table: string;
  readonly primaryKey: string;
  readonly columns: readonly ChecksumColumn[];
};

export const buildChecksumQuery = (options: ChecksumQueryOptions): string => {
  const normalizedColumns = options.columns
    .map((column) => normalizedColumnExpression({ ...column, dialect: options.dialect }))
    .join(', ');
  const concatExpression = `CONCAT_WS('|', ${normalizedColumns})`;

  const hashExpression =
    options.dialect === 'postgres'
      ? `('x' || substr(md5(${concatExpression}), 1, 8))::bit(32)::bigint`
      : `CONV(SUBSTRING(MD5(${concatExpression}), 1, 8), 16, 10)`;

  return (
    `SELECT COALESCE(SUM(${hashExpression}), 0) AS checksum ` +
    `FROM ${options.table} ORDER BY ${options.primaryKey}`
  );
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
- [ ] Commit: `git add demos/aws-dms/runner/src/checksum.ts demos/aws-dms/runner/src/row-count-diff.ts demos/aws-dms/test/checksum.test.ts demos/aws-dms/test/row-count-diff.test.ts && git commit -m "aws-dms: add checksum canonical encoding and row-count-diff pure logic"`

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

### Task 6: Pure logic - DescribeTableStatistics parsing and CloudWatch GetMetricData

`runner/src/table-stats.ts` parses the AWS DMS `DescribeTableStatistics` response shape into a per-table progress record the emitter can turn into metrics. The field names below (`FullLoadRows`, `AppliedInserts`, `AppliedUpdates`, `AppliedDeletes`, `ValidationFailedRecords`, `TableState`) are the **UNVERIFIED** item from Section 4 - they match the AWS SDK v3 `TableStatistics` shape from general API familiarity, but Task 8's manual live-run step must confirm them against a real response before this parser is trusted in a recording.

- [ ] Write `demos/aws-dms/test/table-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseTableStatistics, tableProgressPercent } from '../runner/src/table-stats';

const sampleResponse = {
  TableStatistics: [
    {
      TableName: 'orders',
      SchemaName: 'lab',
      FullLoadRows: 8000,
      AppliedInserts: 120,
      AppliedUpdates: 4,
      AppliedDeletes: 0,
      ValidationFailedRecords: 0,
      TableState: 'Table completed',
    },
    {
      TableName: 'accounts',
      SchemaName: 'lab',
      FullLoadRows: 500,
      AppliedInserts: 2,
      AppliedUpdates: 0,
      AppliedDeletes: 0,
      ValidationFailedRecords: 1,
      TableState: 'Full load',
    },
  ],
};

describe('parseTableStatistics', () => {
  it('extracts a normalized per-table progress record for every table', () => {
    const parsed = parseTableStatistics(sampleResponse);
    expect(parsed).toEqual([
      {
        tableName: 'orders',
        fullLoadRows: 8000,
        appliedInserts: 120,
        appliedUpdates: 4,
        appliedDeletes: 0,
        validationFailedRecords: 0,
        tableState: 'Table completed',
        isFullLoadComplete: true,
      },
      {
        tableName: 'accounts',
        fullLoadRows: 500,
        appliedInserts: 2,
        appliedUpdates: 0,
        appliedDeletes: 0,
        validationFailedRecords: 1,
        tableState: 'Full load',
        isFullLoadComplete: false,
      },
    ]);
  });

  it('returns an empty array for a response with no TableStatistics field', () => {
    expect(parseTableStatistics({})).toEqual([]);
  });

  it('defaults missing numeric fields to zero rather than throwing', () => {
    const parsed = parseTableStatistics({ TableStatistics: [{ TableName: 'heartbeat', TableState: 'Table completed' }] });
    expect(parsed[0]).toEqual({
      tableName: 'heartbeat',
      fullLoadRows: 0,
      appliedInserts: 0,
      appliedUpdates: 0,
      appliedDeletes: 0,
      validationFailedRecords: 0,
      tableState: 'Table completed',
      isFullLoadComplete: true,
    });
  });
});

describe('tableProgressPercent', () => {
  it('computes percent complete against a known source row count', () => {
    expect(tableProgressPercent({ fullLoadRows: 250, sourceRowCount: 1000 })).toBe(25);
  });

  it('caps at 100 when fullLoadRows exceeds sourceRowCount (late-arriving CDC rows during full load)', () => {
    expect(tableProgressPercent({ fullLoadRows: 1050, sourceRowCount: 1000 })).toBe(100);
  });

  it('returns 0 when sourceRowCount is 0 rather than dividing by zero', () => {
    expect(tableProgressPercent({ fullLoadRows: 0, sourceRowCount: 0 })).toBe(0);
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/table-stats.test.ts` - expected FAIL (`runner/src/table-stats.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/table-stats.ts`:

```ts
export type TableProgress = {
  readonly tableName: string;
  readonly fullLoadRows: number;
  readonly appliedInserts: number;
  readonly appliedUpdates: number;
  readonly appliedDeletes: number;
  readonly validationFailedRecords: number;
  readonly tableState: string;
  readonly isFullLoadComplete: boolean;
};

type RawTableStatistic = {
  readonly TableName?: string;
  readonly FullLoadRows?: number;
  readonly AppliedInserts?: number;
  readonly AppliedUpdates?: number;
  readonly AppliedDeletes?: number;
  readonly ValidationFailedRecords?: number;
  readonly TableState?: string;
};

type RawDescribeTableStatisticsResponse = {
  readonly TableStatistics?: readonly RawTableStatistic[];
};

const FULL_LOAD_COMPLETE_STATES = new Set(['Table completed']);

export const parseTableStatistics = (response: RawDescribeTableStatisticsResponse): readonly TableProgress[] =>
  (response.TableStatistics ?? []).map((raw) => ({
    tableName: raw.TableName ?? '',
    fullLoadRows: raw.FullLoadRows ?? 0,
    appliedInserts: raw.AppliedInserts ?? 0,
    appliedUpdates: raw.AppliedUpdates ?? 0,
    appliedDeletes: raw.AppliedDeletes ?? 0,
    validationFailedRecords: raw.ValidationFailedRecords ?? 0,
    tableState: raw.TableState ?? '',
    isFullLoadComplete: FULL_LOAD_COMPLETE_STATES.has(raw.TableState ?? ''),
  }));

export type TableProgressPercentOptions = {
  readonly fullLoadRows: number;
  readonly sourceRowCount: number;
};

export const tableProgressPercent = (options: TableProgressPercentOptions): number => {
  if (options.sourceRowCount === 0) return 0;
  return Math.min(100, Math.round((options.fullLoadRows / options.sourceRowCount) * 100));
};
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/table-stats.test.ts` - expected PASS.
- [ ] Write `demos/aws-dms/test/cloudwatch-query.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildCdcLatencyQuery, parseGetMetricDataResponse } from '../runner/src/cloudwatch-query';

describe('buildCdcLatencyQuery', () => {
  it('builds a GetMetricData request for both CDC latency metrics scoped to one replication task', () => {
    const request = buildCdcLatencyQuery({
      replicationInstanceId: 'tidb-lab-aws-dms-repl',
      replicationTaskId: 'tidb-lab-aws-dms-task',
      startTime: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-01-01T00:05:00Z'),
    });
    expect(request).toEqual({
      StartTime: new Date('2026-01-01T00:00:00Z'),
      EndTime: new Date('2026-01-01T00:05:00Z'),
      MetricDataQueries: [
        {
          Id: 'cdc_latency_source',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/DMS',
              MetricName: 'CDCLatencySource',
              Dimensions: [
                { Name: 'ReplicationInstanceIdentifier', Value: 'tidb-lab-aws-dms-repl' },
                { Name: 'ReplicationTaskIdentifier', Value: 'tidb-lab-aws-dms-task' },
              ],
            },
            Period: 60,
            Stat: 'Average',
          },
          ReturnData: true,
        },
        {
          Id: 'cdc_latency_target',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/DMS',
              MetricName: 'CDCLatencyTarget',
              Dimensions: [
                { Name: 'ReplicationInstanceIdentifier', Value: 'tidb-lab-aws-dms-repl' },
                { Name: 'ReplicationTaskIdentifier', Value: 'tidb-lab-aws-dms-task' },
              ],
            },
            Period: 60,
            Stat: 'Average',
          },
          ReturnData: true,
        },
      ],
    });
  });
});

describe('parseGetMetricDataResponse', () => {
  it('extracts the most recent datapoint per metric id', () => {
    const parsed = parseGetMetricDataResponse({
      MetricDataResults: [
        { Id: 'cdc_latency_source', Timestamps: [new Date('2026-01-01T00:04:00Z'), new Date('2026-01-01T00:03:00Z')], Values: [2, 5] },
        { Id: 'cdc_latency_target', Timestamps: [new Date('2026-01-01T00:04:00Z')], Values: [3] },
      ],
    });
    expect(parsed).toEqual({ cdc_latency_source: 2, cdc_latency_target: 3 });
  });

  it('omits a metric id with no datapoints instead of defaulting to zero', () => {
    const parsed = parseGetMetricDataResponse({
      MetricDataResults: [{ Id: 'cdc_latency_source', Timestamps: [], Values: [] }],
    });
    expect(parsed).toEqual({});
  });

  it('returns an empty object for a response with no MetricDataResults field', () => {
    expect(parseGetMetricDataResponse({})).toEqual({});
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/cloudwatch-query.test.ts` - expected FAIL (`runner/src/cloudwatch-query.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/cloudwatch-query.ts`:

```ts
export type CdcLatencyQueryOptions = {
  readonly replicationInstanceId: string;
  readonly replicationTaskId: string;
  readonly startTime: Date;
  readonly endTime: Date;
};

type MetricDataQuery = {
  readonly Id: string;
  readonly MetricStat: {
    readonly Metric: {
      readonly Namespace: string;
      readonly MetricName: string;
      readonly Dimensions: readonly { readonly Name: string; readonly Value: string }[];
    };
    readonly Period: number;
    readonly Stat: string;
  };
  readonly ReturnData: boolean;
};

export type GetMetricDataRequest = {
  readonly StartTime: Date;
  readonly EndTime: Date;
  readonly MetricDataQueries: readonly MetricDataQuery[];
};

const buildMetricQuery = (options: {
  readonly id: string;
  readonly metricName: string;
  readonly replicationInstanceId: string;
  readonly replicationTaskId: string;
}): MetricDataQuery => ({
  Id: options.id,
  MetricStat: {
    Metric: {
      Namespace: 'AWS/DMS',
      MetricName: options.metricName,
      Dimensions: [
        { Name: 'ReplicationInstanceIdentifier', Value: options.replicationInstanceId },
        { Name: 'ReplicationTaskIdentifier', Value: options.replicationTaskId },
      ],
    },
    Period: 60,
    Stat: 'Average',
  },
  ReturnData: true,
});

export const buildCdcLatencyQuery = (options: CdcLatencyQueryOptions): GetMetricDataRequest => ({
  StartTime: options.startTime,
  EndTime: options.endTime,
  MetricDataQueries: [
    buildMetricQuery({
      id: 'cdc_latency_source',
      metricName: 'CDCLatencySource',
      replicationInstanceId: options.replicationInstanceId,
      replicationTaskId: options.replicationTaskId,
    }),
    buildMetricQuery({
      id: 'cdc_latency_target',
      metricName: 'CDCLatencyTarget',
      replicationInstanceId: options.replicationInstanceId,
      replicationTaskId: options.replicationTaskId,
    }),
  ],
});

type RawMetricDataResult = {
  readonly Id?: string;
  readonly Timestamps?: readonly Date[];
  readonly Values?: readonly number[];
};

type RawGetMetricDataResponse = {
  readonly MetricDataResults?: readonly RawMetricDataResult[];
};

export type LatestMetricValues = Readonly<Record<string, number>>;

export const parseGetMetricDataResponse = (response: RawGetMetricDataResponse): LatestMetricValues => {
  const results: Record<string, number> = {};
  for (const result of response.MetricDataResults ?? []) {
    const timestamps = result.Timestamps ?? [];
    const values = result.Values ?? [];
    if (result.Id === undefined || timestamps.length === 0 || values.length === 0) continue;
    let latestIndex = 0;
    for (let i = 1; i < timestamps.length; i += 1) {
      if (timestamps[i].getTime() > timestamps[latestIndex].getTime()) latestIndex = i;
    }
    results[result.Id] = values[latestIndex];
  }
  return results;
};
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/cloudwatch-query.test.ts` - expected PASS.
- [ ] Commit: `git add demos/aws-dms/runner/src/table-stats.ts demos/aws-dms/runner/src/cloudwatch-query.ts demos/aws-dms/test/table-stats.test.ts demos/aws-dms/test/cloudwatch-query.test.ts && git commit -m "aws-dms: add DescribeTableStatistics and GetMetricData pure parsers"`

### Task 7: Pure logic - cutover state machine and workload generator schedule

The cutover state machine has four states: `running` (load generator active, CDC live) to `draining` (load generator stopped, waiting for CDC latency to hit zero) to `verified` (row-count-match and checksum-match both passed) to `flipped` (app connection string pointed at TiDB). Each transition has a guard so an invalid call is rejected rather than silently corrupting state - this matters because the runner's `start-cutover` control, a stale retry, or a UI double-click must not be able to skip verification.

- [ ] Write `demos/aws-dms/test/cutover-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createCutoverStateMachine } from '../runner/src/cutover-state';

describe('createCutoverStateMachine', () => {
  it('starts in the running state', () => {
    const machine = createCutoverStateMachine();
    expect(machine.getState()).toBe('running');
  });

  it('advances running -> draining -> verified -> flipped in order', () => {
    const machine = createCutoverStateMachine();
    expect(machine.beginDraining()).toEqual({ ok: true, state: 'draining' });
    expect(machine.markVerified()).toEqual({ ok: true, state: 'verified' });
    expect(machine.markFlipped()).toEqual({ ok: true, state: 'flipped' });
    expect(machine.getState()).toBe('flipped');
  });

  it('rejects markVerified before beginDraining', () => {
    const machine = createCutoverStateMachine();
    expect(machine.markVerified()).toEqual({
      ok: false,
      state: 'running',
      reason: 'cannot markVerified from running, expected draining',
    });
  });

  it('rejects markFlipped before markVerified', () => {
    const machine = createCutoverStateMachine();
    machine.beginDraining();
    expect(machine.markFlipped()).toEqual({
      ok: false,
      state: 'draining',
      reason: 'cannot markFlipped from draining, expected verified',
    });
  });

  it('rejects a second beginDraining once already draining', () => {
    const machine = createCutoverStateMachine();
    machine.beginDraining();
    expect(machine.beginDraining()).toEqual({
      ok: false,
      state: 'draining',
      reason: 'cannot beginDraining from draining, expected running',
    });
  });

  it('rejects any transition once flipped (terminal state)', () => {
    const machine = createCutoverStateMachine();
    machine.beginDraining();
    machine.markVerified();
    machine.markFlipped();
    expect(machine.beginDraining()).toEqual({
      ok: false,
      state: 'flipped',
      reason: 'cannot beginDraining from flipped, expected running',
    });
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/cutover-state.test.ts` - expected FAIL (`runner/src/cutover-state.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/cutover-state.ts`:

```ts
export type CutoverState = 'running' | 'draining' | 'verified' | 'flipped';

export type TransitionResult =
  | { readonly ok: true; readonly state: CutoverState }
  | { readonly ok: false; readonly state: CutoverState; readonly reason: string };

export type CutoverStateMachine = {
  readonly getState: () => CutoverState;
  readonly beginDraining: () => TransitionResult;
  readonly markVerified: () => TransitionResult;
  readonly markFlipped: () => TransitionResult;
};

const attemptTransition = (
  current: CutoverState,
  requiredFrom: CutoverState,
  next: CutoverState,
  actionName: string,
): { readonly next: CutoverState; readonly result: TransitionResult } => {
  if (current !== requiredFrom) {
    return {
      next: current,
      result: { ok: false, state: current, reason: `cannot ${actionName} from ${current}, expected ${requiredFrom}` },
    };
  }
  return { next, result: { ok: true, state: next } };
};

export const createCutoverStateMachine = (): CutoverStateMachine => {
  let state: CutoverState = 'running';

  const beginDraining = (): TransitionResult => {
    const { next, result } = attemptTransition(state, 'running', 'draining', 'beginDraining');
    state = next;
    return result;
  };

  const markVerified = (): TransitionResult => {
    const { next, result } = attemptTransition(state, 'draining', 'verified', 'markVerified');
    state = next;
    return result;
  };

  const markFlipped = (): TransitionResult => {
    const { next, result } = attemptTransition(state, 'verified', 'flipped', 'markFlipped');
    state = next;
    return result;
  };

  return { getState: () => state, beginDraining, markVerified, markFlipped };
};
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/cutover-state.test.ts` - expected PASS.
- [ ] Write `demos/aws-dms/test/workload.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { currentWriteRate, isBurstActive } from '../runner/src/workload';

describe('currentWriteRate', () => {
  it('returns the baseline rate when no burst is active', () => {
    expect(
      currentWriteRate({ baselineRowsPerTick: 5, burstUntilMs: undefined, burstMultiplier: 10, nowMs: 1000 }),
    ).toBe(5);
  });

  it('returns the multiplied rate while a burst window is active', () => {
    expect(
      currentWriteRate({ baselineRowsPerTick: 5, burstUntilMs: 5000, burstMultiplier: 10, nowMs: 1000 }),
    ).toBe(50);
  });

  it('returns the baseline rate once the burst window has elapsed', () => {
    expect(
      currentWriteRate({ baselineRowsPerTick: 5, burstUntilMs: 5000, burstMultiplier: 10, nowMs: 6000 }),
    ).toBe(5);
  });

  it('treats the exact burst end tick as no longer bursting', () => {
    expect(
      currentWriteRate({ baselineRowsPerTick: 5, burstUntilMs: 5000, burstMultiplier: 10, nowMs: 5000 }),
    ).toBe(5);
  });
});

describe('isBurstActive', () => {
  it('is false with no burst window set', () => {
    expect(isBurstActive({ burstUntilMs: undefined, nowMs: 1000 })).toBe(false);
  });

  it('is true strictly before the burst window ends', () => {
    expect(isBurstActive({ burstUntilMs: 5000, nowMs: 4999 })).toBe(true);
  });

  it('is false at or after the burst window ends', () => {
    expect(isBurstActive({ burstUntilMs: 5000, nowMs: 5000 })).toBe(false);
  });
});
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/workload.test.ts` - expected FAIL (`runner/src/workload.ts` does not exist).
- [ ] Write `demos/aws-dms/runner/src/workload.ts`:

```ts
export type IsBurstActiveOptions = {
  readonly burstUntilMs: number | undefined;
  readonly nowMs: number;
};

export const isBurstActive = (options: IsBurstActiveOptions): boolean =>
  options.burstUntilMs !== undefined && options.nowMs < options.burstUntilMs;

export type CurrentWriteRateOptions = {
  readonly baselineRowsPerTick: number;
  readonly burstUntilMs: number | undefined;
  readonly burstMultiplier: number;
  readonly nowMs: number;
};

export const currentWriteRate = (options: CurrentWriteRateOptions): number =>
  isBurstActive({ burstUntilMs: options.burstUntilMs, nowMs: options.nowMs })
    ? options.baselineRowsPerTick * options.burstMultiplier
    : options.baselineRowsPerTick;
```

- [ ] Run: `cd demos/aws-dms && pnpm vitest run test/workload.test.ts` - expected PASS.
- [ ] Commit: `git add demos/aws-dms/runner/src/cutover-state.ts demos/aws-dms/runner/src/workload.ts demos/aws-dms/test/cutover-state.test.ts demos/aws-dms/test/workload.test.ts && git commit -m "aws-dms: add cutover state machine and workload rate schedule pure logic"`

### Task 8: I/O adapters - DMS and CloudWatch pollers (manual live-run)

- [ ] Manual live-run, capture a real response before trusting the parser: `aws dms describe-table-statistics --replication-task-arn "$DMS_TASK_ARN" --region "$AWS_REGION" | tee /tmp/dms-table-stats-sample.json` - expected output: a JSON object with a `TableStatistics` array; compare every field name used in `runner/src/table-stats.ts` (`FullLoadRows`, `AppliedInserts`, `AppliedUpdates`, `AppliedDeletes`, `ValidationFailedRecords`, `TableState`) against this real output. If any field name or casing differs, fix `table-stats.ts` and its test now, before wiring the adapter below - do not guess ahead of this step (this closes the Section 4 **UNVERIFIED** item).
- [ ] Write `demos/aws-dms/runner/src/dms-poller.ts`:

```ts
import {
  DatabaseMigrationServiceClient,
  DescribeTableStatisticsCommand,
} from '@aws-sdk/client-database-migration-service';
import { parseTableStatistics, type TableProgress } from './table-stats';

export type DmsPoller = {
  readonly pollTableStatistics: () => Promise<readonly TableProgress[]>;
};

export type CreateDmsPollerOptions = {
  readonly region: string;
  readonly replicationTaskArn: string;
};

export const createDmsPoller = (options: CreateDmsPollerOptions): DmsPoller => {
  const client = new DatabaseMigrationServiceClient({ region: options.region });

  const pollTableStatistics = async (): Promise<readonly TableProgress[]> => {
    const response = await client.send(
      new DescribeTableStatisticsCommand({ ReplicationTaskArn: options.replicationTaskArn }),
    );
    return parseTableStatistics(response);
  };

  return { pollTableStatistics };
};
```

- [ ] Manual live-run, capture the CloudWatch dimension names before trusting the query builder: `aws cloudwatch list-metrics --namespace AWS/DMS --metric-name CDCLatencySource --region "$AWS_REGION"` - expected output: a `Metrics` array whose `Dimensions` show the exact dimension names (`ReplicationInstanceIdentifier`, `ReplicationTaskIdentifier`, or both) in use; compare against `buildCdcLatencyQuery` in `runner/src/cloudwatch-query.ts` and fix the dimension names/order there and in its test if they differ (this closes the second Section 4 **UNVERIFIED** item).
- [ ] Manual live-run: `aws cloudwatch get-metric-data --metric-data-queries file://demos/aws-dms/infra/cloudwatch-query-sample.json --start-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --region "$AWS_REGION"` - expected output: `MetricDataResults` with non-empty `Values` once the task is in CDC; save this response as `/tmp/dms-metric-data-sample.json` and compare its shape against `parseGetMetricDataResponse`.
- [ ] Write `demos/aws-dms/infra/cloudwatch-query-sample.json` (a static copy of `buildCdcLatencyQuery`'s output, used only for the manual CLI verification step above, kept in sync by hand since the CLI does not import TypeScript):

```json
[
  {
    "Id": "cdc_latency_source",
    "MetricStat": {
      "Metric": {
        "Namespace": "AWS/DMS",
        "MetricName": "CDCLatencySource",
        "Dimensions": [
          { "Name": "ReplicationInstanceIdentifier", "Value": "tidb-lab-aws-dms-repl" },
          { "Name": "ReplicationTaskIdentifier", "Value": "tidb-lab-aws-dms-task" }
        ]
      },
      "Period": 60,
      "Stat": "Average"
    },
    "ReturnData": true
  },
  {
    "Id": "cdc_latency_target",
    "MetricStat": {
      "Metric": {
        "Namespace": "AWS/DMS",
        "MetricName": "CDCLatencyTarget",
        "Dimensions": [
          { "Name": "ReplicationInstanceIdentifier", "Value": "tidb-lab-aws-dms-repl" },
          { "Name": "ReplicationTaskIdentifier", "Value": "tidb-lab-aws-dms-task" }
        ]
      },
      "Period": 60,
      "Stat": "Average"
    },
    "ReturnData": true
  }
]
```

- [ ] Write `demos/aws-dms/runner/src/cloudwatch-poller.ts`:

```ts
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { buildCdcLatencyQuery, parseGetMetricDataResponse, type LatestMetricValues } from './cloudwatch-query';

export type CloudwatchPoller = {
  readonly pollCdcLatency: () => Promise<LatestMetricValues>;
};

export type CreateCloudwatchPollerOptions = {
  readonly region: string;
  readonly replicationInstanceId: string;
  readonly replicationTaskId: string;
  readonly windowMs: number;
};

export const createCloudwatchPoller = (options: CreateCloudwatchPollerOptions): CloudwatchPoller => {
  const client = new CloudWatchClient({ region: options.region });

  const pollCdcLatency = async (): Promise<LatestMetricValues> => {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - options.windowMs);
    const request = buildCdcLatencyQuery({
      replicationInstanceId: options.replicationInstanceId,
      replicationTaskId: options.replicationTaskId,
      startTime,
      endTime,
    });
    const response = await client.send(new GetMetricDataCommand(request));
    return parseGetMetricDataResponse(response);
  };

  return { pollCdcLatency };
};
```

- [ ] Manual live-run: `AWS_REGION=... DMS_TASK_ARN=... node --import tsx -e "import('./demos/aws-dms/runner/src/dms-poller.ts').then(m => m.createDmsPoller({region: process.env.AWS_REGION, replicationTaskArn: process.env.DMS_TASK_ARN}).pollTableStatistics()).then(console.log)"` - expected output: an array of `TableProgress` objects matching the shape asserted in `test/table-stats.test.ts`.
- [ ] Commit: `git add demos/aws-dms/runner/src/dms-poller.ts demos/aws-dms/runner/src/cloudwatch-poller.ts demos/aws-dms/infra/cloudwatch-query-sample.json && git commit -m "aws-dms: add DMS and CloudWatch polling adapters"`

### Task 9: I/O adapters - PostgreSQL client, load generator, heartbeat (manual live-run)

- [ ] Write `demos/aws-dms/runner/src/pg-client.ts`:

```ts
import { Pool } from 'pg';
import { buildChecksumQuery, type ChecksumColumn } from './checksum';

export type PgClient = {
  readonly insertHeartbeat: () => Promise<{ readonly heartbeatId: number; readonly insertedAtMs: number }>;
  readonly countRows: (table: string) => Promise<number>;
  readonly runChecksum: (options: { readonly table: string; readonly primaryKey: string; readonly columns: readonly ChecksumColumn[] }) => Promise<number>;
  readonly insertAccountsAndOrders: (rowsPerTick: number) => Promise<void>;
  readonly close: () => Promise<void>;
};

export const createPgClient = (env: NodeJS.ProcessEnv = process.env): PgClient => {
  const pool = new Pool({
    host: env.PG_HOST,
    port: Number(env.PG_PORT ?? 5432),
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE,
  });

  const insertHeartbeat = async (): Promise<{ readonly heartbeatId: number; readonly insertedAtMs: number }> => {
    const result = await pool.query<{ heartbeat_id: number; inserted_at: Date }>(
      'INSERT INTO heartbeat (inserted_at) VALUES (now()) RETURNING heartbeat_id, inserted_at',
    );
    const row = result.rows[0];
    return { heartbeatId: row.heartbeat_id, insertedAtMs: row.inserted_at.getTime() };
  };

  const countRows = async (table: string): Promise<number> => {
    const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
    return Number(result.rows[0].count);
  };

  const runChecksum = async (options: {
    readonly table: string;
    readonly primaryKey: string;
    readonly columns: readonly ChecksumColumn[];
  }): Promise<number> => {
    const query = buildChecksumQuery({ dialect: 'postgres', table: options.table, primaryKey: options.primaryKey, columns: options.columns });
    const result = await pool.query<{ checksum: string }>(query);
    return Number(result.rows[0].checksum);
  };

  const insertAccountsAndOrders = async (rowsPerTick: number): Promise<void> => {
    await pool.query(
      `INSERT INTO accounts (display_name, is_active, risk_tags, metadata)
       SELECT 'acct-' || g, true, '{}', '{}'::jsonb FROM generate_series(1, $1) AS g`,
      [Math.max(1, Math.floor(rowsPerTick / 5))],
    );
    await pool.query(
      `INSERT INTO orders (account_id, amount, currency, status)
       SELECT (SELECT account_id FROM accounts ORDER BY random() LIMIT 1), (random() * 500)::numeric(18,2), 'USD', 'placed'
       FROM generate_series(1, $1) AS g`,
      [rowsPerTick],
    );
  };

  const close = async (): Promise<void> => {
    await pool.end();
  };

  return { insertHeartbeat, countRows, runChecksum, insertAccountsAndOrders, close };
};
```

- [ ] Write `demos/aws-dms/runner/src/load-generator.ts`:

```ts
import { every } from '@lab/runner-kit';
import { currentWriteRate } from './workload';
import type { PgClient } from './pg-client';

export type LoadGenerator = {
  readonly start: (signal: AbortSignal) => Promise<void>;
  readonly burst: () => void;
  readonly stop: () => void;
};

export type CreateLoadGeneratorOptions = {
  readonly pgClient: PgClient;
  readonly baselineRowsPerTick: number;
  readonly burstMultiplier: number;
  readonly burstDurationMs: number;
  readonly onTick?: (rowsInserted: number) => void;
};

export const createLoadGenerator = (options: CreateLoadGeneratorOptions): LoadGenerator => {
  let burstUntilMs: number | undefined;
  let stopped = false;

  const burst = (): void => {
    burstUntilMs = Date.now() + options.burstDurationMs;
  };

  const stop = (): void => {
    stopped = true;
  };

  const start = async (signal: AbortSignal): Promise<void> => {
    await every({
      intervalMs: 1000,
      signal,
      task: async () => {
        if (stopped) return;
        const rate = currentWriteRate({
          baselineRowsPerTick: options.baselineRowsPerTick,
          burstUntilMs,
          burstMultiplier: options.burstMultiplier,
          nowMs: Date.now(),
        });
        await options.pgClient.insertAccountsAndOrders(rate);
        options.onTick?.(rate);
      },
    });
  };

  return { start, burst, stop };
};
```

- [ ] Manual live-run: `PG_HOST=... PG_PORT=... PG_USER=... PG_PASSWORD=... PG_DATABASE=... node --import tsx -e "import('./demos/aws-dms/runner/src/pg-client.ts').then(m => m.createPgClient().insertHeartbeat()).then(console.log)"` - expected output: the inserted heartbeat row's `heartbeatId` and `insertedAtMs`.
- [ ] Manual live-run: same pattern calling `countRows('orders')` - expected output: a number matching `psql -c 'SELECT COUNT(*) FROM orders'` run independently.
- [ ] Manual live-run: same pattern calling `runChecksum({ table: 'orders', primaryKey: 'order_id', columns: [{ column: 'order_id', type: 'text' }, { column: 'amount', type: 'numeric', precision: 18, scale: 2 }, { column: 'status', type: 'text' }] })` - expected output: a single integer; re-run the equivalent `buildChecksumQuery({ dialect: 'mysql', ... })` output against TiDB once rows exist there (Task 10) and confirm the two integers are equal for a fully-synced table.
- [ ] Commit: `git add demos/aws-dms/runner/src/pg-client.ts demos/aws-dms/runner/src/load-generator.ts && git commit -m "aws-dms: add PostgreSQL client and load generator adapters"`

### Task 10: Runner main and control wiring

- [ ] Write `demos/aws-dms/runner/main.ts`:

```ts
import { createEmitter, onControl, createTidbPool, every } from '@lab/runner-kit';
import { createDmsPoller } from './src/dms-poller';
import { createCloudwatchPoller } from './src/cloudwatch-poller';
import { createPgClient } from './src/pg-client';
import { createLoadGenerator } from './src/load-generator';
import { createCutoverStateMachine } from './src/cutover-state';
import { rowCountDiff } from './src/row-count-diff';
import { freshnessMs } from './src/freshness';
import { cutoverDowntimeSeconds } from './src/cutover-timer';
import { tableProgressPercent } from './src/table-stats';

const env = process.env;
const emitter = createEmitter();
const tidbPool = createTidbPool(env);
const pgClient = createPgClient(env);
const dmsPoller = createDmsPoller({ region: env.AWS_REGION ?? 'us-east-1', replicationTaskArn: env.DMS_TASK_ARN ?? '' });
const cloudwatchPoller = createCloudwatchPoller({
  region: env.AWS_REGION ?? 'us-east-1',
  replicationInstanceId: env.DMS_REPLICATION_INSTANCE_ID ?? '',
  replicationTaskId: env.DMS_TASK_ID ?? '',
  windowMs: 10 * 60 * 1000,
});
const loadGenerator = createLoadGenerator({
  pgClient,
  baselineRowsPerTick: 5,
  burstMultiplier: 10,
  burstDurationMs: 30_000,
  onTick: (rows) => emitter.metric('full_load_rows_sec', rows),
});
const cutover = createCutoverStateMachine();
const controller = new AbortController();

const orderColumns = [
  { column: 'order_id', type: 'text' as const },
  { column: 'amount', type: 'numeric' as const, precision: 18, scale: 2 },
  { column: 'status', type: 'text' as const },
];

let sourceRowCountsAtPhaseStart: Record<string, number> = {};
let lastTableStatsTickMs = Date.now();
let lastAppliedTotal = 0;

const runValidation = async (): Promise<{ readonly rowDiff: number; readonly checksumMatch: boolean }> => {
  const pgCount = await pgClient.countRows('orders');
  const [tidbCountRows] = await tidbPool.query('SELECT COUNT(*) AS count FROM orders');
  const tidbCount = Number((tidbCountRows as { count: number }[])[0].count);
  const rowDiff = rowCountDiff({ sourceCount: pgCount, targetCount: tidbCount });
  emitter.metric('row_count_diff', rowDiff);
  emitter.check('row-count-match', rowDiff === 0 ? 'pass' : 'fail');

  const pgChecksum = await pgClient.runChecksum({ table: 'orders', primaryKey: 'order_id', columns: orderColumns });
  const [tidbChecksumRows] = await tidbPool.query(
    "SELECT COALESCE(SUM(CONV(SUBSTRING(MD5(CONCAT_WS('|', COALESCE(CAST(order_id AS CHAR), '\\\\N'), COALESCE(CAST(CAST(amount AS DECIMAL(18,2)) AS CHAR), '\\\\N'), COALESCE(CAST(status AS CHAR), '\\\\N'))), 1, 8), 16, 10)), 0) AS checksum FROM orders ORDER BY order_id",
  );
  const tidbChecksum = Number((tidbChecksumRows as { checksum: number }[])[0].checksum);
  const checksumMatch = pgChecksum === tidbChecksum;
  emitter.check('checksum-match', checksumMatch ? 'pass' : 'fail');

  return { rowDiff, checksumMatch };
};

onControl(async (id) => {
  if (id === 'burst-writes') loadGenerator.burst();

  if (id === 'run-validation') {
    await runValidation();
  }

  if (id === 'start-cutover') {
    loadGenerator.stop();
    const stoppedAtMs = Date.now();
    cutover.beginDraining();
    emitter.phase('cutover');

    await every({
      intervalMs: 2000,
      signal: controller.signal,
      task: async () => {
        if (cutover.getState() !== 'draining') return;
        const latest = await cloudwatchPoller.pollCdcLatency();
        const targetLatency = latest.cdc_latency_target ?? Number.POSITIVE_INFINITY;
        emitter.metric('cdc_latency_target_s', targetLatency);
        if (targetLatency === 0) {
          const { rowDiff, checksumMatch } = await runValidation();
          if (rowDiff === 0 && checksumMatch) {
            cutover.markVerified();
            emitter.check('cutover-clean', 'pass');
          }
        }
      },
    });

    if (cutover.getState() === 'verified') {
      await tidbPool.query('SELECT 1');
      cutover.markFlipped();
      const confirmedAtMs = Date.now();
      emitter.metric('cutover_downtime_s', cutoverDowntimeSeconds({ stoppedAtMs, confirmedAtMs }));
      emitter.log('info', 'cutover complete, app connection flipped to TiDB');
    }
  }
});

const runTableStatsTick = async (): Promise<void> => {
  const progress = await dmsPoller.pollTableStatistics();
  const nowMs = Date.now();
  const tickSeconds = (nowMs - lastTableStatsTickMs) / 1000;
  lastTableStatsTickMs = nowMs;

  let appliedTotal = 0;
  for (const table of progress) {
    if (sourceRowCountsAtPhaseStart[table.tableName] === undefined) {
      sourceRowCountsAtPhaseStart[table.tableName] = table.fullLoadRows || 1;
    }
    emitter.metric(
      'full_load_pct',
      tableProgressPercent({ fullLoadRows: table.fullLoadRows, sourceRowCount: sourceRowCountsAtPhaseStart[table.tableName] }),
    );
    emitter.metric('validation_failed_rows', table.validationFailedRecords);
    appliedTotal += table.appliedInserts + table.appliedUpdates + table.appliedDeletes;
  }
  if (tickSeconds > 0) {
    emitter.metric('cdc_apply_rows_sec', (appliedTotal - lastAppliedTotal) / tickSeconds);
  }
  lastAppliedTotal = appliedTotal;
};

const runCdcLatencyTick = async (): Promise<void> => {
  const latest = await cloudwatchPoller.pollCdcLatency();
  if (latest.cdc_latency_source !== undefined) emitter.metric('cdc_latency_source_s', latest.cdc_latency_source);
  if (latest.cdc_latency_target !== undefined) emitter.metric('cdc_latency_target_s', latest.cdc_latency_target);
};

const runHeartbeatTick = async (): Promise<void> => {
  const { heartbeatId, insertedAtMs } = await pgClient.insertHeartbeat();
  const started = Date.now();
  const deadlineMs = started + 5000;
  while (Date.now() < deadlineMs) {
    const [rows] = await tidbPool.query('SELECT heartbeat_id FROM heartbeat WHERE heartbeat_id = ?', [heartbeatId]);
    if (Array.isArray(rows) && rows.length > 0) {
      emitter.metric('heartbeat_freshness_ms', freshnessMs({ insertedAtMs, visibleAtMs: Date.now() }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

emitter.phase('provision');
void loadGenerator.start(controller.signal);
void every({ intervalMs: 1000, task: runTableStatsTick, signal: controller.signal });
void every({ intervalMs: 5000, task: runCdcLatencyTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runHeartbeatTick, signal: controller.signal });
```

- [ ] Manual live-run: `pnpm lab run aws-dms --record` with the Terraform infra from Task 2 up and DMS task running - expected: the relay's `/health` returns `{"ok":true,"demo":"aws-dms"}`, and `curl -N http://localhost:7070/events` streams `phase` events advancing through all six phases without a `log` event at `error` level.
- [ ] Manual live-run: `curl -X POST http://localhost:7070/control/burst-writes` during the `cdc-live` phase - expected: `cdc_apply_rows_sec` visibly rises in the next few `metric` events.
- [ ] Manual live-run: `curl -X POST http://localhost:7070/control/run-validation` - expected: `check` events for `row-count-match` and `checksum-match` both reach `pass`.
- [ ] Manual live-run: `curl -X POST http://localhost:7070/control/start-cutover` - expected: `cdc_latency_target_s` reaches `0`, `check` event `cutover-clean` reaches `pass`, and a final `metric` event for `cutover_downtime_s` is emitted.
- [ ] Commit: `git add demos/aws-dms/runner/main.ts && git commit -m "aws-dms: wire runner phases and controls"`

### Task 11: README and TALK-TRACK

- [ ] Write `demos/aws-dms/README.md`:

```markdown
# AWS DMS + TiDB: Aurora PostgreSQL migration

Aurora PostgreSQL feeds AWS DMS, which full-loads existing rows into TiDB
Cloud and then switches to CDC via PostgreSQL logical replication, while the
app keeps writing. A validated cutover flips the app's connection string
once CDC latency drains to zero and row counts/checksums match.

## What it proves

- TiDB Cloud is a supported AWS DMS target using the standard MySQL endpoint type.
- Full load and CDC run concurrently with live writes, and CDC lag is measured, not assumed.
- Cutover is driven from measured signals, and the downtime window is reported, not estimated.

## Prerequisites

- AWS account with permission to create RDS/Aurora, DMS, VPC, and IAM resources.
- TiDB Cloud account with permission to create a Dedicated cluster.
- terraform, aws cli, Node 22, pnpm.

## Run

1. `cd infra/terraform && terraform init && TF_VAR_aurora_master_password=... TF_VAR_tidb_host=... terraform apply` (Plan section, Task 2).
2. Create the TiDB Cloud Dedicated cluster, add the DMS security group to its traffic filter, load `infra/sql/schema-tidb.sql` (Task 3).
3. Create the DMS TiDB target endpoint and the full-load-and-cdc replication task (Task 2's manual steps).
4. `cp .env.example .env` and fill in `TIDB_*`, `PG_*`, `DMS_REPLICATION_INSTANCE_ARN`, `DMS_TASK_ARN`, `AWS_REGION`.
5. `pnpm lab run aws-dms --record` and open the UI pointed at the relay port.

## Record

`pnpm lab run aws-dms --record` writes `demos/aws-dms/traces/<timestamp>.json`.
Promote a good run: `cp demos/aws-dms/traces/<timestamp>.json demos/aws-dms/traces/featured.json`.

## Teardown

See Section 5 of the plan for the exact commands and the four `aws`/console
checks that confirm nothing is still billing.

## Cost notes

Bills for the Aurora PostgreSQL instance, the DMS replication instance, and
the TiDB Cloud Dedicated cluster, each at its documented hourly rate, plus
PrivateLink/VPC peering hourly charges if used. See
https://aws.amazon.com/dms/pricing/, https://www.pingcap.com/tidb-cloud-pricing/,
and https://aws.amazon.com/rds/aurora/pricing/ for current rates - no price
is hardcoded here because it changes independently of this plan.
```

- [ ] Write `demos/aws-dms/TALK-TRACK.md`:

```markdown
# Talk track: AWS DMS + TiDB

## Provision and verify
"Aurora PostgreSQL, AWS DMS, and TiDB Cloud are up. This is the same DMS you
already use for other migrations."

## Schema conversion
"DMS creates tables and primary keys. Everything else in the type
conversion is explicit, and we show you exactly what changed - look at the
mapping table, nothing here is a black box."

## Full load
"DMS full-loads the existing orders and accounts tables while the app keeps
taking traffic. Watch the per-table completion percentage."

## CDC under live load
"Now every insert, update, and delete on Aurora flows through logical
replication into TiDB, live. We can burst the write rate and DMS keeps up."

## Validate
"We don't just trust DMS's validation state, we recompute row counts and
checksums ourselves on both databases, with a canonical row encoding so
formatting differences between PostgreSQL and TiDB never cause a false
mismatch."

## Cutover
"Writes stop, CDC drains to zero lag, we verify one more time, then the app
points at TiDB. That whole window is the downtime we measure - seconds, not
an estimate."

## Discovery questions

1. "You're on Aurora PostgreSQL today - what's driving the evaluation of TiDB?"
2. "Have you used AWS DMS for a migration before, and what went wrong or right?"
3. "What's your tolerance for a cutover downtime window - seconds, minutes, longer?"
4. "How do you validate a migration today - do you trust the vendor's validation state, or recompute it yourself?"
5. "Which PostgreSQL-specific features (arrays, JSONB, custom types) does your schema depend on?"

## Objections and honest answers

1. "Doesn't DMS just handle schema conversion for us?"
   No - DMS creates tables and primary keys only. Secondary indexes, foreign
   keys, sequences, and check constraints are hand-written, and this demo
   shows exactly which ones and why.
2. "Is this zero-downtime?"
   No. There's a real cutover window while writes are stopped and the final
   checks run. This demo measures that window in seconds rather than
   assuming it away.
3. "PostgreSQL to a MySQL-compatible target - what data types actually survive?"
   The mapping table in the plan documents every column: UUID becomes a
   36-char string, arrays become text, JSONB becomes native JSON, NUMERIC
   keeps explicit precision/scale to avoid DMS's default-precision truncation.
4. "What if our tables don't have primary keys?"
   DMS CDC requires one - UPDATE/DELETE without a primary key are otherwise
   silently ignored. This is a hard constraint to flag early with a
   customer, not something to discover mid-migration.
5. "Does this work with DMS Serverless instead of a replication instance?"
   Unverified end-to-end against TiDB Cloud specifically at the time of
   writing (Section 4) - this plan defaults to a classic replication
   instance because that is the path PingCAP's own docs verify.
```

- [ ] Commit: `git add demos/aws-dms/README.md demos/aws-dms/TALK-TRACK.md && git commit -m "aws-dms: add README and talk track"`

### Task 12: Validation and public-content gate

- [ ] Manual live-run: `pnpm lab validate aws-dms` - expected: `manifest valid`, and once `traces/featured.json` exists (Task 13), `trace valid, 0 eventReferenceErrors`.
- [ ] Manual live-run: `pnpm lab check-public` - expected: no denylisted terms found in `demos/aws-dms/**`.
- [ ] Manual live-run: `grep -rn $'\u2014' demos/aws-dms` - expected: no matches (em dash guard); if any file has one, replace it with a regular hyphen and re-run.
- [ ] Commit only if this step required fixes: `git add demos/aws-dms && git commit -m "aws-dms: fix validation/public-content findings"`

## 8. Recording the featured trace

1. Bring up infra (Task 2) and confirm the DMS task is `Ready` with an empty target schema freshly loaded from Task 3.
2. Set `.env` (`cp .env.example .env` and fill in `TIDB_*`, `PG_*`, `DMS_REPLICATION_INSTANCE_ARN`, `DMS_TASK_ARN`, `DMS_REPLICATION_INSTANCE_ID`, `DMS_TASK_ID`, `AWS_REGION`), and set `LAB_ENV_TIDB` to the TiDB Cloud version shown in the cluster's console overview page, `LAB_ENV_NOTES` to the AWS region and DMS instance class used.
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
- **TiDB system databases must be filtered out of DMS table mappings.** `table-mappings.json` scopes selection to the `public`/`lab` schema explicitly, never `%`, per Section 4, or the task fails trying to migrate `mysql`/`sys`/`INFORMATION_SCHEMA`.
- **CloudWatch metric propagation lag.** `CDCLatencySource`/`CDCLatencyTarget` can take up to a minute to appear after CDC starts; the `cutover` phase's "poll until zero" logic in `main.ts` re-validates on every zero reading rather than trusting a single stale/missing datapoint.
- **DMS Serverless is unverified for this pairing end-to-end (Section 4).** Default to a classic replication instance; only try DMS Serverless as a follow-up experiment once the base demo is recorded.
- **`DescribeTableStatistics` and CloudWatch dimension field names were UNVERIFIED against the live API when this plan was written.** Task 8 requires running the raw `aws dms describe-table-statistics` and `aws cloudwatch list-metrics` CLI calls and fixing `table-stats.ts`/`cloudwatch-query.ts` (and their tests) against the real response before trusting either parser in a recording; do not skip this step even though the pure-logic tests in Task 6 pass against hand-written fixtures.
- **Checksum canonical encoding depends on the load generator's own write discipline.** The JSON `metadata` column's key-order-must-match-between-engines assumption (Section 7, Task 4) only holds if `pg-client.ts`'s `insertAccountsAndOrders` always writes `metadata` with the same fixed key order; if the load generator is extended to write richer JSON, re-verify `checksum-match` still passes after a full sync.
- **Terraform's fixed IAM role names.** `dms-vpc-role` and `dms-cloudwatch-logs-role` are account-wide DMS conventions (Section 4); if a prior DMS setup in the same account already created them, `terraform apply` fails and the fix is `terraform import`, not renaming the Terraform resource.
- **Cost creep from an idle Aurora/DMS/TiDB Cloud stack.** Follow the exact teardown commands in Section 5 immediately after recording; re-verify with the listed `aws dms`/`aws rds`/`aws logs` describe calls and the TiDB Cloud console before ending the work session.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 01-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/01-aws-dms.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - | AWS DMS Serverless (the auto-provisioned-capacity replication mode, billed in DMS Capacity Units/DCUs of 2 GiB RAM each) lists "PostgreSQL-compatible databases" as a supported source and "MySQL-compatible databases" as a supported target, so this pair is supported in principle. | [AWS DMS Serverle
  - | CloudWatch metric `CDCLatencySource` measures delay (seconds) between the last captured source commit and the replication instance's current time; `CDCLatencyTarget` measures delay between the first unapplied change's source commit time and current time, and is always >= `CDCLatencySource`. | [AWS
  - | `DescribeTableStatistics` returns per-table `FullLoadRows`, `AppliedInserts`, `AppliedUpdates`, `AppliedDeletes`, `ValidationFailedRecords`, and `TableState`. | Prior knowledge of the AWS DMS API, not fetched from `docs.aws.amazon.com/dms/latest/APIReference` in this session. | **UNVERIFIED**: con
  - | AWS DMS data validation (`Turn on validation` at task creation) independently re-reads source and target rows and reports per-table failures; this demo turns it on and also computes its own row-count and checksum comparisons rather than only trusting the vendor's validation state. | [Migrate from 
  - | AWS DMS pricing (replication instance hourly rate by instance class, plus storage) is on the DMS pricing page; there is no fixed dollar figure recorded in this plan. | [AWS DMS pricing](https://aws.amazon.com/dms/pricing/) | Not fetched this session; URL given for the runner/README to link to. **U
  - | TiDB Cloud pricing (Dedicated node-hour rate, or Essential/Serverless request-based pricing) is on the TiDB Cloud pricing page; no fixed dollar figure is recorded in this plan. | [TiDB Cloud pricing](https://www.pingcap.com/tidb-cloud-pricing/) | Not fetched this session; URL given for the runner/
  - | Aurora PostgreSQL pricing (instance hour by class, storage, I/O) is on the Amazon Aurora pricing page. | [Amazon Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/) | Not fetched this session; URL given for teardown/cost section. **UNVERIFIED**: confirm current instance-class rate at build
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/01-aws-dms.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 01-P1: Manifest
- Tasks: 1
- Depends on: 01-V1   Shared runtime: none
- Files owned: `integrations/demos/aws-dms/manifest.json`, `integrations/demos/aws-dms/package.json`, `integrations/demos/aws-dms/test/manifest.test.ts`, `integrations/demos/aws-dms/tsconfig.json`
- Model: sonnet   Effort: M
- Gate:
  - `cd demos/aws-dms && pnpm install && pnpm vitest run test/manifest.test.ts` -> PASS
  - `pnpm --filter @lab/demo-aws-dms typecheck` -> exit 0
- Done when: Task 1's steps are all checked off and the gate output matches.

### Packet 01-P2: Infrastructure (manual live-run, I/O-heavy Terraform, no unit tests)
- Tasks: 2
- Depends on: 01-P1   Shared runtime: cloud-account
- Files owned: `integrations/demos/aws-dms/infra/terraform/main.tf`, `integrations/demos/aws-dms/infra/terraform/outputs.tf`, `integrations/demos/aws-dms/infra/terraform/table-mappings.json`, `integrations/demos/aws-dms/infra/terraform/variables.tf`, `integrations/demos/aws-dms/infra/terraform/versions.tf`
- Model: sonnet   Effort: L
- Gate:
  - `TF_VAR_aurora_master_password="$(openssl rand -base64 24)" TF_VAR_tidb_host="<tidb-cloud-host>" terraform apply` -> `Apply complete!` with `aurora_cluster_endpoint`, `dms_replication_instance_arn`, `dms_security_group_id` in the outputs
  - `aws dms modify-endpoint --endpoint-arn "$(terraform output -raw dms_replication_instance_arn | sed 's/repl-instance/endpoint/')" --password "<tidb-password>"` -> connection test status **successful**
  - `aws dms describe-replication-tasks --filters Name=replication-task-id,Values=$(terraform output -raw dms_replication_task_id) --query 'ReplicationTasks[0].Status'` -> `"ready"`
  - `terraform -chdir=integrations/demos/aws-dms/infra/terraform init -backend=false && terraform -chdir=integrations/demos/aws-dms/infra/terraform validate` -> `Success! The configuration is valid.`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 2's steps are all checked off and the gate output matches.

### Packet 01-P3: Schema (manual live-run, DDL has no pure logic to unit test)
- Tasks: 3
- Depends on: 01-P2   Shared runtime: cloud-account (Aurora PostgreSQL + TiDB Cloud)
- Files owned: `integrations/demos/aws-dms/infra/sql/schema-tidb.sql`, `integrations/demos/aws-dms/infra/sql/schema.sql`
- Model: sonnet   Effort: M
- Gate:
  - `psql "$PG_CONN_STRING" -f demos/aws-dms/infra/sql/schema.sql` -> three `CREATE TABLE` confirmations
  - `mysql -h "$TIDB_HOST" -P "$TIDB_PORT" -u "$TIDB_USER" -p"$TIDB_PASSWORD" "$TIDB_DATABASE" < demos/aws-dms/infra/sql/schema-tidb.sql` -> no output on success (or `Query OK` per statement with `-v`)
- Done when: Task 3's steps are all checked off and the gate output matches.

### Packet 01-P4: Pure logic - checksum with canonical row encoding, and row-count-diff
- Tasks: 4
- Depends on: 01-P3   Shared runtime: none
- Files owned: `integrations/demos/aws-dms/runner/src/checksum.ts`, `integrations/demos/aws-dms/runner/src/row-count-diff.ts`, `integrations/demos/aws-dms/test/checksum.test.ts`, `integrations/demos/aws-dms/test/row-count-diff.test.ts`
- Model: sonnet   Effort: L
- Gate:
  - `cd demos/aws-dms && pnpm vitest run test/checksum.test.ts` -> PASS
  - `cd demos/aws-dms && pnpm vitest run test/row-count-diff.test.ts` -> PASS
  - `pnpm --filter @lab/demo-aws-dms typecheck` -> exit 0
- Done when: Task 4's steps are all checked off and the gate output matches.

### Packet 01-P5: Pure logic - freshness and cutover timer
- Tasks: 5
- Depends on: 01-P4   Shared runtime: none
- Files owned: `integrations/demos/aws-dms/runner/src/cutover-timer.ts`, `integrations/demos/aws-dms/runner/src/freshness.ts`, `integrations/demos/aws-dms/test/cutover-timer.test.ts`, `integrations/demos/aws-dms/test/freshness.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `cd demos/aws-dms && pnpm vitest run test/freshness.test.ts` -> PASS
  - `cd demos/aws-dms && pnpm vitest run test/cutover-timer.test.ts` -> PASS
  - `pnpm --filter @lab/demo-aws-dms typecheck` -> exit 0
- Done when: Task 5's steps are all checked off and the gate output matches.

### Packet 01-P6: Pure logic - DescribeTableStatistics parsing and CloudWatch GetMetricData
- Tasks: 6
- Depends on: 01-P5   Shared runtime: none
- Files owned: `integrations/demos/aws-dms/runner/src/cloudwatch-query.ts`, `integrations/demos/aws-dms/runner/src/table-stats.ts`, `integrations/demos/aws-dms/test/cloudwatch-query.test.ts`, `integrations/demos/aws-dms/test/table-stats.test.ts`
- Model: sonnet   Effort: L
- Gate:
  - `cd demos/aws-dms && pnpm vitest run test/table-stats.test.ts` -> PASS
  - `cd demos/aws-dms && pnpm vitest run test/cloudwatch-query.test.ts` -> PASS
  - `pnpm --filter @lab/demo-aws-dms typecheck` -> exit 0
- Done when: Task 6's steps are all checked off and the gate output matches.

### Packet 01-P7: Pure logic - cutover state machine and workload generator schedule
- Tasks: 7
- Depends on: 01-P6   Shared runtime: none
- Files owned: `integrations/demos/aws-dms/runner/src/cutover-state.ts`, `integrations/demos/aws-dms/runner/src/workload.ts`, `integrations/demos/aws-dms/test/cutover-state.test.ts`, `integrations/demos/aws-dms/test/workload.test.ts`
- Model: sonnet   Effort: L
- Gate:
  - `cd demos/aws-dms && pnpm vitest run test/cutover-state.test.ts` -> PASS
  - `cd demos/aws-dms && pnpm vitest run test/workload.test.ts` -> PASS
  - `pnpm --filter @lab/demo-aws-dms typecheck` -> exit 0
- Done when: Task 7's steps are all checked off and the gate output matches.

### Packet 01-P8: I/O adapters - DMS and CloudWatch pollers (manual live-run)
- Tasks: 8
- Depends on: 01-P7   Shared runtime: cloud-account
- Files owned: `integrations/demos/aws-dms/infra/cloudwatch-query-sample.json`, `integrations/demos/aws-dms/runner/src/cloudwatch-poller.ts`, `integrations/demos/aws-dms/runner/src/dms-poller.ts`
- Model: sonnet   Effort: M
- Gate:
  - `aws cloudwatch list-metrics --namespace AWS/DMS --metric-name CDCLatencySource --region "$AWS_REGION"` -> a `Metrics` array whose `Dimensions` show the exact dimension names (`ReplicationInstanceIdentifier`, `ReplicationTaskIdentifier`, or both) in use; compare against `buildCdcLatencyQuery` in `runner/src/cloudwatch-query.ts` and fix the dimension names/order there and in its test if they differ (this closes the second Section 4 **UNVERIFIED** item)
  - `aws cloudwatch get-metric-data --metric-data-queries file://demos/aws-dms/infra/cloudwatch-query-sample.json --start-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --region "$AWS_REGION"` -> `MetricDataResults` with non-empty `Values` once the task is in CDC; save this response as `/tmp/dms-metric-data-sample.json` and compare its shape against `parseGetMetricDataResponse`
  - `AWS_REGION=... DMS_TASK_ARN=... node --import tsx -e "import('./demos/aws-dms/runner/src/dms-poller.ts').then(m => m.createDmsPoller({region: process.env.AWS_REGION, replicationTaskArn: process.env.DMS_TASK_ARN}).pollTableStatistics()).then(console.log)"` -> an array of `TableProgress` objects matching the shape asserted in `test/table-stats.test.ts`
  - `pnpm --filter @lab/demo-aws-dms typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 8's steps are all checked off and the gate output matches.

### Packet 01-P9: I/O adapters - PostgreSQL client, load generator, heartbeat (manual live-run)
- Tasks: 9
- Depends on: 01-P8   Shared runtime: tidb-playground
- Files owned: `integrations/demos/aws-dms/runner/src/load-generator.ts`, `integrations/demos/aws-dms/runner/src/pg-client.ts`
- Model: sonnet   Effort: M
- Gate:
  - `PG_HOST=... PG_PORT=... PG_USER=... PG_PASSWORD=... PG_DATABASE=... node --import tsx -e "import('./demos/aws-dms/runner/src/pg-client.ts').then(m => m.createPgClient().insertHeartbeat()).then(console.log)"` -> the inserted heartbeat row's `heartbeatId` and `insertedAtMs`
  - `countRows('orders')` -> a number matching `psql -c 'SELECT COUNT(*) FROM orders'` run independently
  - `runChecksum({ table: 'orders', primaryKey: 'order_id', columns: [{ column: 'order_id', type: 'text' }, { column: 'amount', type: 'numeric', precision: 18, scale: 2 }, { column: 'status', type: 'text' }] })` -> a single integer; re-run the equivalent `buildChecksumQuery({ dialect: 'mysql', ... })` output against TiDB once rows exist there (Task 10) and confirm the two integers are equal for a fully-synced table
  - `pnpm --filter @lab/demo-aws-dms typecheck` -> exit 0
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 01-P10: Runner main and control wiring
- Tasks: 10
- Depends on: 01-P9   Shared runtime: tidb-playground
- Files owned: `integrations/demos/aws-dms/runner/main.ts`
- Model: sonnet   Effort: M
- Gate:
  - `curl -X POST http://localhost:7070/control/burst-writes` -> `cdc_apply_rows_sec` visibly rises in the next few `metric` events
  - `curl -X POST http://localhost:7070/control/run-validation` -> `check` events for `row-count-match` and `checksum-match` both reach `pass`
  - `curl -X POST http://localhost:7070/control/start-cutover` -> `cdc_latency_target_s` reaches `0`, `check` event `cutover-clean` reaches `pass`, and a final `metric` event for `cutover_downtime_s` is emitted
  - `pnpm --filter @lab/demo-aws-dms typecheck` -> exit 0
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 01-P11: README and TALK-TRACK
- Tasks: 11
- Depends on: 01-P10   Shared runtime: cloud-account
- Files owned: `integrations/demos/aws-dms/README.md`, `integrations/demos/aws-dms/TALK-TRACK.md`, `integrations/demos/aws-dms/traces/featured.json`
- Model: sonnet   Effort: M
- Gate:
  - `grep -c $'\u2014' integrations/demos/aws-dms/README.md integrations/demos/aws-dms/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 01-P12: Validation and public-content gate
- Tasks: 12
- Depends on: 01-P11   Shared runtime: none
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - `pnpm lab validate aws-dms` -> `manifest valid`, and once `traces/featured.json` exists (Task 13), `trace valid, 0 eventReferenceErrors`
  - `pnpm lab check-public` -> no denylisted terms found in `demos/aws-dms/**`
  - `grep -rn $'\u2014' demos/aws-dms` -> no matches (em dash guard); if any file has one, replace it with a regular hyphen and re-run
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 01-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 01-P12   Shared runtime: cloud-account
- Files owned: `integrations/demos/aws-dms/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate aws-dms` -> `aws-dms: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.

## Build notes (2026-09-27): what changed while building

The code in `demos/aws-dms/` is authoritative where it differs from the task code above.

| Area | Finding | Resolution |
|---|---|---|
| Manifest | Metric ids were snake_case, which `SlugSchema` rejects | Renamed to kebab-case (`full-load-rows-sec`, `cdc-latency-source-s`, `heartbeat-freshness-ms`, ...); `test/emitted-ids.test.ts` fails if `main.ts` emits an id the manifest lacks |
| AWS SDK field names (01-V1, partial) | `TableStatistics` (`TableName`, `FullLoadRows`, `AppliedInserts`, `AppliedUpdates`, `AppliedDeletes`, `ValidationFailedRecords`, `TableState`) and CloudWatch `GetMetricData` shapes | Confirmed against the installed SDK type definitions. The CloudWatch `AWS/DMS` dimension names and a real response still need a live capture (`infra/cloudwatch-query-sample.json`) |
| Cutover | The drain loop only stopped on the outer signal, so the flip and the downtime metric were unreachable | Dedicated `drainController`, aborted once verification passes |
| Full-load rate | Computed from the load generator | Computed from the `DescribeTableStatistics` `FullLoadRows` delta, as `howMeasured` says |
| Checksum | Proven on PostgreSQL 16 and TiDB (tiup playground): `ORDER BY` on the aggregate is invalid in PostgreSQL; `'\N'` is two characters in PostgreSQL and one in TiDB; `jsonb` key order and number formatting differ from TiDB JSON; a boolean NULL hashed like `false` | No `ORDER BY`; backslash-free NULL token; `lab_jsonb_canonical()` in `schema.sql`; explicit `IS NULL`; identifiers quoted per dialect; TiDB sessions `SET time_zone = '+00:00'`. `LAB_INTEGRATION=1 pnpm exec vitest run test/checksum.integration.test.ts` reproduces the proof |
| Terraform | Only Terraform 1.5.7 installed locally | `required_version = ">= 1.5.7"`; `terraform validate` and `fmt -check` pass. Never applied yet |
| Known gap | `TEXT[]` columns (for example `risk_tags`) are not part of the checksum | Add an `array` column type before relying on the checksum for array data |

## Build notes (2026-09-29): live recording, two real bugs found and fixed

Full `terraform apply` against a real AWS account (VPC, Aurora PostgreSQL 16.15 Serverless v2, DMS `dms.t3.small`, TiDB Cloud Starter target) and a live `pnpm lab run aws-dms --record` produced a passing `traces/featured.json` (6676 events, phases `provision -> schema -> full-load -> cdc-live -> validate -> cutover` in order, 0 error-level logs, `cutover-clean` pass, `cutover_downtime_s` measured at 3.5s). Two bugs surfaced only under a real DMS task and are recorded here with the exact live evidence.

| Area | Finding | Resolution |
|---|---|---|
| CloudWatch dimension (`runner/src/cloudwatch-query.ts`, `runner/main.ts`) | `main.ts` built the `ReplicationTaskIdentifier` CloudWatch dimension from `env.DMS_TASK_ID` (the human-readable task name, e.g. `tidb-lab-aws-dms-task`). Live run: `cdc-latency-source-s`/`cdc-latency-target-s` never appeared in the trace for 17+ minutes of a real `cdc-live` phase, while every other metric (including `heartbeat-freshness-ms` and `cdc-apply-rows-sec`) was flowing normally, so the data pipeline itself was healthy. `aws cloudwatch list-metrics --namespace AWS/DMS --metric-name CDCLatencyTarget` against the live account showed the true `ReplicationTaskIdentifier` dimension value is the task ARN's resource id (the last colon-separated segment, e.g. `6WOZGNMC4FER5N46WKKMXPC4RY`), not the task's identifier/name; a second, unrelated series in that same listing belonged to a previous day's already-destroyed task, confirming the id is per-task-instance, not per-name. | Added a pure `dmsResourceIdFromArn(arn: string): string` function to `runner/src/cloudwatch-query.ts` (test-first: `test/cloudwatch-query.test.ts` failed with `TypeError: ... is not a function` before the function existed, passed after). `main.ts` now derives the CloudWatch dimension from `dmsResourceIdFromArn(env.DMS_TASK_ARN)` instead of `env.DMS_TASK_ID`. Re-recorded from scratch and confirmed `cdc-latency-source-s`/`cdc-latency-target-s` both appear in the trace at value `0` once CDC catches up, matching a direct `aws cloudwatch get-metric-data` call for the same metric. |
| DMS native validation vs TiDB Cloud Starter target (`infra/terraform/main.tf`) | With `ValidationSettings.EnableValidation = true` (the setting this plan originally specified, matching the vendor's own recommendation), a live full-load-and-cdc run put the `orders` table into `TableState: "Table error"` a few minutes after CDC started, even though `AppliedInserts` matched `Inserts` (no reported error rows). Row counts confirmed real, silent data loss: Aurora `orders` grew to 725 rows while TiDB stayed frozen at 10 (the full-load count) - CDC had actually stopped applying to that table, not just misreporting state. `aws logs filter-log-events` on the DMS task's CloudWatch log group found the root cause: `VALIDATOR_TARGE E: Cannot get special table's id for owner : lab_01, name : awsdms_validation_failures_v1 [1021802]` followed by `Cannot create ValidationFailure table` and `pTargetEndpointShell validation_apply_handler failed` - DMS's validation feature tries to create its own control table inside the target database and this fails against TiDB Cloud Starter, and the failure silently suspends CDC apply for the affected table rather than only disabling validation. | Set `ValidationSettings.EnableValidation = false` in `infra/terraform/main.tf` (comment explains why, with the log line quoted). This is infrastructure configuration with no unit test surface (Task 2 already notes Terraform here is "manual live-run, I/O-heavy... no unit tests"), so the fix was verified by re-applying, truncating both databases, and confirming a fresh full-load-and-cdc run left every table `Table completed` with `orders`/`accounts` row counts equal on both sides for the rest of the run. This does not weaken the demo: it already computes and asserts its own row-count and checksum comparisons independently of DMS's vendor validation state (`run-validation` control, `row-count-match`/`checksum-match`/`cutover-clean` checks), which is the stronger guarantee `validation_failed_rows`'s `howMeasured` and this plan's Section 1 "what TiDB proves here" both describe. |
| Operational note | Truncating source/target tables directly while the runner's load generator was still running (to reset state between re-record attempts) crashed the runner: `insertAccountsAndOrders`'s `orders` insert picks a random existing `account_id` via a subquery, and truncating `accounts` mid-tick made that subquery return `NULL`, which violates `orders.account_id`'s `NOT NULL` constraint and threw an uncaught `error` that killed the whole Node process. | Not a code bug in the steady state (a fresh empty database always inserts into `accounts` before `orders` in the same tick, so this only happens if something external truncates concurrently); the practical fix is operational - stop the runner before truncating tables between recording attempts, which is what every re-record above did after this was found. |
