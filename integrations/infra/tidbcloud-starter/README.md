# tidbcloud-starter

Terraform root module that creates one TiDB Cloud Starter (serverless)
cluster in AWS `us-west-2`, using the official [`tidbcloud/tidbcloud`
provider](https://registry.terraform.io/providers/tidbcloud/tidbcloud/latest).

Each `var.name` (e.g. `lab-06`, `lab-12`) gets its own cluster and its own
local state file, so multiple labs/demos can run at the same time without
colliding.

## What it creates

- `tidbcloud_serverless_cluster.this`: one Starter cluster, region
  `regions/aws-us-west-2`, `spending_limit.monthly = 0` (stay inside the
  free 25 GiB storage / 250M RU per month quota).
- `random_password.root`: a generated password.
- `tidbcloud_sql_user.root`: brings the cluster's built-in
  `<user_prefix>.root` admin user under Terraform so its password can be
  set to the generated one (the provider has no `root_password` argument
  on the cluster resource itself; see "How the root password is set"
  below).

TiDB Cloud Starter is shared, fully-managed infrastructure - it has no
AWS resources of its own, so there is nothing here for this repo's usual
`Project=tidb-integration-lab` / `Demo=<id>` AWS tagging convention to tag.
A cost sweep should key off the cluster's `display_name` (`var.name`)
instead; `terraform output cluster_id` gives the exact ID.

## Prerequisites

- Terraform >= 1.5.
- `~/.config/tidb-lab/secrets.env` defining `TIDBCLOUD_PUBLIC_KEY` and
  `TIDBCLOUD_PRIVATE_KEY`.
- `mysql` CLI, or Node with `mysql2` available (`pnpm install` at the
  `integrations/` workspace root), so `up.sh` can create the `lab` database.

## Usage

```bash
./up.sh lab-06                 # create/reuse the cluster only
./up.sh lab-06 databricks      # also write demos/databricks/.env
./down.sh lab-06               # destroy it
```

`up.sh <name> [demo-id]`:
1. Applies just the cluster (its ID and user prefix are unknown until it
   exists).
2. Imports the built-in root user into state, once.
3. Applies again to set its password, and prints `cluster_id`, `host`,
   `port`, `user`.
4. Creates the `lab` database (TLS required, as always for Starter).
5. If `demo-id` is given, writes `TIDB_HOST` / `TIDB_PORT` / `TIDB_USER` /
   `TIDB_PASSWORD` / `TIDB_DATABASE=lab` / `TIDB_TLS=true` into
   `demos/<demo-id>/.env`, replacing any existing `TIDB_*` lines (copying
   `.env.example` first if `.env` does not exist yet).

`down.sh <name>` removes the root user from Terraform's state (TiDB Cloud
does not allow deleting that user directly, only via cluster deletion),
then runs `terraform destroy` and deletes the local state file.

## How the root password is set

`tidbcloud_serverless_cluster` does not expose a `root_password` argument;
the cluster is created with a `<user_prefix>.root` admin user whose
initial password TiDB Cloud generates and never returns. The documented
way to control it with Terraform is the `tidbcloud_sql_user` resource,
which can only update an existing user's password, not create a user with
that exact name (it would already exist). `up.sh` handles this with a
one-time `terraform import` of `tidbcloud_sql_user.root` right after the
cluster is created, then a normal `apply` sets the password.

## Manual (non-scripted) use

```bash
export TIDBCLOUD_PUBLIC_KEY=...
export TIDBCLOUD_PRIVATE_KEY=...
terraform init
TF_VAR_name=lab-06 terraform apply -target=tidbcloud_serverless_cluster.this
terraform import tidbcloud_sql_user.root "$(terraform output -raw cluster_id),$(terraform output -raw user)"
TF_VAR_name=lab-06 terraform apply
terraform output host port user
terraform output -raw password
```

## Cost

TiDB Cloud Starter includes 25 GiB row storage, 25 GiB column storage, and
250M Request Units free per organization per month; overage is $0.20/GiB
and $0.10/1M RU (source:
[pingcap.com/pricing](https://www.pingcap.com/pricing/)). With
`spending_limit.monthly = 0` this lab cluster cannot spend beyond that free
quota, so as long as the org's other Starter usage that month stays under
the free tier, this cluster costs **$0/hour**. It can be paused or left
idle at no charge; deleting it (`down.sh`) removes it entirely.
