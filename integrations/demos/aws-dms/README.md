# AWS DMS + TiDB: Aurora PostgreSQL migration

Aurora PostgreSQL feeds AWS DMS, which full-loads existing rows into TiDB
Cloud and then switches to CDC via PostgreSQL logical replication, while the
app keeps writing. A validated cutover flips the app's connection string
once CDC latency drains to zero and row counts and checksums match.

**Pattern:** a fintech evaluating a move from Aurora PostgreSQL to TiDB,
testing AWS DMS full load plus CDC as the migration path. No customer names,
tickets, or internal links appear anywhere in this demo - only the
anonymized pattern.

## What it proves

- TiDB Cloud is a supported AWS DMS target using the standard MySQL endpoint
  type, over the same public/private connectivity options DMS already
  offers.
- Full load and CDC run concurrently with live writes on the source, and the
  CDC lag (`cdc-latency-source-s`, `cdc-latency-target-s`) is measured in
  real time rather than assumed.
- A cutover is driven from measured signals (`cutover-clean`: latency at
  zero, `row-count-match` and `checksum-match` both passing) instead of a
  fixed wait, and the downtime window (`cutover-downtime-s`) is measured,
  not estimated.
- The heterogeneous PostgreSQL-to-MySQL-dialect schema conversion is a
  known, bounded set of type changes (`schema-parity`), not a black box:
  DMS creates tables and primary keys only, everything else (secondary
  indexes, foreign keys, sequences, check constraints) is hand-written for
  this schema.

This demo does not claim AWS DMS Schema Conversion (or AWS SCT) auto-converts
every PostgreSQL feature, and it does not claim zero-downtime cutover - it
measures the downtime window and reports it, and that window here is
seconds, not zero.

## Prerequisites

- An AWS account with permission to create RDS/Aurora, DMS, VPC, and IAM
  resources.
- A TiDB Cloud account with permission to create a Dedicated cluster
  (Dedicated is required here for VPC peering/PrivateLink).
- Local tools: macOS, Docker Desktop (not required to run this demo locally
  since all data stores are cloud-hosted, but used for the relay/UI dev
  loop), Node 22, pnpm, terraform, aws cli.

## Cost model

This demo bills for, while it runs:

1. The Aurora PostgreSQL instance, at its documented hourly rate - see
   [Amazon Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/).
2. The AWS DMS replication instance, at its documented hourly rate plus
   storage - see [AWS DMS pricing](https://aws.amazon.com/dms/pricing/).
3. The TiDB Cloud Dedicated cluster, at its documented node-hour rate - see
   [TiDB Cloud pricing](https://www.pingcap.com/tidb-cloud-pricing/).
4. TiDB Cloud PrivateLink/VPC peering hourly charges, if used - same TiDB
   Cloud pricing page above.

No dollar figures are hardcoded anywhere in this demo, because rates change
independently of it. Read the current rate from the linked pricing pages
before quoting a cost to anyone.

## Run

1. `cd infra/terraform && terraform init && TF_VAR_aurora_master_password=... TF_VAR_tidb_host=... terraform apply`
2. Create the TiDB Cloud Dedicated cluster, add the DMS security group to
   its traffic filter, and load `infra/sql/schema-tidb.sql`.
3. Create the DMS TiDB target endpoint and the full-load-and-cdc
   replication task (see the terraform apply's manual follow-up steps).
4. `cp .env.example .env` and fill in `TIDB_*`, `PG_*`,
   `DMS_REPLICATION_INSTANCE_ARN`, `DMS_TASK_ARN`, `AWS_REGION`.
5. `pnpm lab run aws-dms --record` and open the UI pointed at the relay
   port.

## Record

`pnpm lab run aws-dms --record` writes `demos/aws-dms/traces/<timestamp>.json`.

During the run: let `provision` and `schema` complete, start the DMS task
for `full-load`, press **Burst writes** once during `cdc-live`, then **Run
validation**, then **Start cutover**. A good run has no `log` events at
`error` level and every check reaching `pass`.

Promote a good run: `cp demos/aws-dms/traces/<timestamp>.json demos/aws-dms/traces/featured.json`.

Then confirm it before committing:

- `pnpm lab validate aws-dms` -> manifest ok, featured trace ok
- `pnpm lab check-public` -> `0 findings`

## Teardown

Run in this exact order:

1. `pnpm lab run aws-dms` runner should already have exited or been Ctrl-C'd.
2. `cd demos/aws-dms/infra/terraform && terraform destroy -auto-approve` -
   destroys the DMS replication instance, endpoints, task, Aurora PostgreSQL
   cluster, and the VPC/subnets/security groups/IAM role created for this
   demo.
3. Delete the TiDB Cloud Dedicated cluster from the TiDB Cloud console
   (Terraform-managed only if the TiDB Cloud Terraform provider is wired
   in; otherwise this is a manual console step).

### Nothing-is-billing checklist

Confirm every item below before ending the work session:

- [ ] `aws dms describe-replication-instances --query 'ReplicationInstances[].ReplicationInstanceIdentifier'` returns an empty list.
- [ ] `aws dms describe-replication-tasks --query 'ReplicationTasks[].ReplicationTaskIdentifier'` returns an empty list (a task can outlive its instance in some failure modes).
- [ ] `aws rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier'` returns an empty list (or does not include this demo's cluster identifier).
- [ ] `aws rds describe-db-cluster-snapshots --query 'DBClusterSnapshots[].DBClusterSnapshotIdentifier'` returns no snapshot for this demo (`skip_final_snapshot = true` should prevent one, but confirm - a lingering snapshot bills storage even after the cluster is gone).
- [ ] `aws logs describe-log-groups --log-group-name-prefix /aws/dms` shows no log group referencing this task's replication instance id (CloudWatch Logs for DMS are not deleted by `terraform destroy` unless explicitly managed as a resource; delete manually with `aws logs delete-log-group` if present).
- [ ] The TiDB Cloud console's cluster list no longer shows the demo cluster.
