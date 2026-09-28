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
- A TiDB Cloud account with a **Starter** cluster in `us-west-2`, created by
  the sibling `infra/tidbcloud-starter` module, reached over Starter's public
  endpoint with TLS (`verify-full`). This demo does not use TiDB Cloud
  Dedicated, PrivateLink, or VPC peering: Starter does not support those, and
  the plan's decision (Section 4/5) is to prefer Starter wherever a demo can
  use it, since it needs no cluster-creation lead time and no VPC networking
  on the TiDB Cloud side.
- Local tools: macOS, Docker Desktop (not required to run this demo locally
  since all data stores are cloud-hosted, but used for the relay/UI dev
  loop), Node 22, pnpm, terraform, aws cli.
- This demo's runner (writes, checksums, cutover against Aurora) runs on
  your workstation, and this VPC has no bastion or VPN. Aurora is therefore
  `publicly_accessible` and reachable only from the DMS security group and
  from `var.admin_cidr`, your workstation's public IP as a `/32`, required
  at apply time. TLS is enforced on Aurora (`rds.force_ssl = 1`), and the
  runner connects with `PG_SSL=true`.

## Cost model

This demo bills for, while it runs:

1. The Aurora PostgreSQL Serverless v2 writer, at its ACU-hour rate (floor
   0.5 ACU) - see [Amazon Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/).
2. The AWS DMS `dms.t3.small` replication instance, at its documented hourly
   rate, plus its allocated storage - see
   [AWS DMS pricing](https://aws.amazon.com/dms/pricing/).
3. The TiDB Cloud Starter cluster, at its documented request-based rate -
   see [TiDB Cloud pricing](https://www.pingcap.com/tidb-cloud-pricing/).

There is no NAT gateway in this demo (Section 4/5): the DMS replication
instance is `publicly_accessible` in a public subnet instead, which is
cheaper for a short-lived run. No dollar figures are hardcoded anywhere in
this demo, because rates change independently of it. Read the current rate
from the linked pricing pages before quoting a cost to anyone.

## Run

1. Apply the sibling `infra/tidbcloud-starter` module first (or confirm it
   has already run) so `demos/aws-dms/.env` has `TIDB_HOST`, `TIDB_PORT`,
   `TIDB_USER`, `TIDB_PASSWORD` filled in.
2. Generate a gitignored `terraform.tfvars` from `.env`, or export
   `TF_VAR_*` directly, then apply:

   ```
   cd infra/terraform
   terraform init
   TF_VAR_aurora_master_password=... \
   TF_VAR_tidb_host=... TF_VAR_tidb_user=... TF_VAR_tidb_password=... \
   TF_VAR_admin_cidr=$(curl -s https://checkip.amazonaws.com)/32 \
   terraform apply
   ```

3. Load `infra/sql/schema-tidb.sql` against the TiDB Cloud Starter cluster
   (DMS creates tables and primary keys only; see Section 4 of the plan).
4. `cp .env.example .env` (if not already populated by step 1) and fill in
   the remaining `PG_*` (use the `aurora_writer_endpoint` output for
   `PG_HOST`, and set `PG_SSL=true`), `DMS_REPLICATION_INSTANCE_ARN`,
   `DMS_TASK_ARN`, `AWS_REGION` values from the `terraform apply` output.
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
   destroys the DMS replication instance, endpoints, certificate, task,
   Aurora PostgreSQL Serverless v2 cluster, and the VPC/subnets/security
   groups/IAM role created for this demo.
3. Destroy the TiDB Cloud Starter cluster from the sibling
   `infra/tidbcloud-starter` module (`terraform destroy` there, or the TiDB
   Cloud console if it was created manually).

### Nothing-is-billing checklist

Confirm every item below before ending the work session:

- [ ] `aws dms describe-replication-instances --query 'ReplicationInstances[].ReplicationInstanceIdentifier'` returns an empty list.
- [ ] `aws dms describe-replication-tasks --query 'ReplicationTasks[].ReplicationTaskIdentifier'` returns an empty list (a task can outlive its instance in some failure modes).
- [ ] `aws rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier'` returns an empty list (or does not include this demo's cluster identifier).
- [ ] `aws rds describe-db-cluster-snapshots --query 'DBClusterSnapshots[].DBClusterSnapshotIdentifier'` returns no snapshot for this demo (`skip_final_snapshot = true` should prevent one, but confirm - a lingering snapshot bills storage even after the cluster is gone).
- [ ] `aws logs describe-log-groups --log-group-name-prefix /aws/dms` shows no log group referencing this task's replication instance id (CloudWatch Logs for DMS are not deleted by `terraform destroy` unless explicitly managed as a resource; delete manually with `aws logs delete-log-group` if present).
- [ ] The TiDB Cloud console's cluster list no longer shows the demo cluster.
