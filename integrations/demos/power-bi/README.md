# Power BI + TiDB: live dashboards without nightly ETL

## What this proves

One TiDB cluster serves a live order-writing workload and a Power BI report
at the same time. A TiFlash replica added to the `orders` table lets the
dashboard's query set run fast analytical queries without competing with
order writes on TiKV. The demo measures, side by side:

- Dashboard query p50/p99 (`dashboard-p50-tikv`, `dashboard-p99-tikv`,
  `dashboard-p50-tiflash`, `dashboard-p99-tiflash`) forced to TiKV vs forced
  to TiFlash, on the same data.
- How many milliseconds after a write commits it becomes visible to a
  TiFlash-routed dashboard query (`freshness-ms`; freshness is measured,
  not asserted).
- Order write p99 (`write-p99`) with the dashboard query set idle, routed
  to TiKV, and routed to TiFlash, plus the resulting degradation
  (`write-p99-degradation`).
- TiFlash replica sync progress (`tiflash-replica-progress`), added live
  during the run.

A real Power BI Desktop report, connected to the same cluster, is
screen-recorded separately and accompanies the trace replay on the site.
Power BI's native MySQL connector only supports Import mode, so the report
itself does not stream live - the underlying database does, and clicking
Refresh in Power BI shows that.

## What this does not claim

- This does not replace a warehouse for heavy historical/BI workloads
  across many subject areas; it targets the class of dashboard that today
  waits on a nightly copy for no reason other than "that's how the
  pipeline works."
- TiFlash replication lag is measured, not asserted to be zero. Whatever
  the `freshness-ms` metric reports on the day of recording is the number
  shown.

## Prerequisites

- Node 22, pnpm, and (for local development) tiup.
- A TiDB Cloud account for the featured recording, or the local
  `infra/tidb/playground.sh` for day-to-day development. See the TiDB
  Cloud tier-selection guide for current tier names and TiFlash support:
  https://docs.pingcap.com/tidbcloud/select-cluster-tier/
- A Windows environment for Power BI Desktop only. This demo's own Terraform
  (`infra/windows/`) provisions a single AWS EC2 Windows Server instance for
  this; a local Parallels/UTM Windows VM or a Windows 365 Cloud PC also work.
  Power BI Desktop is Windows-only. Power BI Desktop itself is a free
  download from Microsoft:
  https://www.microsoft.com/en-us/download/details.aspx?id=58494
- The Oracle MySQL Connector/NET package installed on the Power BI Desktop
  machine, required by Power BI's MySQL database connector:
  https://learn.microsoft.com/en-us/power-query/connectors/mysql-database
  (the EC2 path installs both of the above automatically - see below)
- An AWS account (profile from `AWS_PROFILE`, region `us-west-2`) and
  Terraform >= 1.5, if using the `infra/windows/` EC2 path.

## Run (local development)

```bash
infra/tidb/playground.sh                          # separate terminal, leave running
cp demos/power-bi/.env.example demos/power-bi/.env
pnpm --filter @lab/demo-power-bi exec tsx runner/setup.ts
pnpm lab run power-bi
```

Open the UI (`pnpm --filter @lab/ui dev`) and select `power-bi` in live
mode, or drive it headless with `curl` against `http://localhost:7070`.

### Controls (live mode)

- `start-dashboard-load`: begin the heavier concurrent replay of the
  dashboard query set against whichever engine is currently routed.
- `route-to-tikv` / `route-to-tiflash`: point that heavier load at TiKV or
  at the TiFlash replica.
- `write-burst`: multiply the order write rate for a short window.

## Record

This recording uses a TiDB Cloud Starter cluster (created with
`infra/tidbcloud-starter`, elsewhere in this lab) and a real Power BI
Desktop instance running on an AWS EC2 Windows box, driven over RDP so the
report refresh can be screen-recorded directly.

### 1. Bring up the TiDB Cloud Starter cluster

Follow `infra/tidbcloud-starter`'s own README to create the cluster and get
its connection details (host, port 4000, prefixed username, database). TiDB
Cloud Starter supports TiFlash/columnar storage (verified in plan section
4); the replica count this demo requests (1) is silently upgraded to 2 by
Starter, which is expected and does not need any code change. Point
`demos/power-bi/.env` at the cluster with `TIDB_TLS=true`, then seed it
once:

```bash
cp demos/power-bi/.env.example demos/power-bi/.env   # fill in TIDB_HOST etc.
cd demos/power-bi && node --env-file=.env --import tsx runner/setup.ts
```

`runner/setup.ts` reads its TiDB connection from `process.env`, and unlike
`pnpm lab run` it does not load `.env` itself, so `--env-file=.env` is
required here - without it, the seed step silently connects to the local
tiup playground defaults instead of the cluster in `.env` (found live
while recording this demo; see the plan's Build notes).

### 2. Bring up the Windows EC2 instance

```bash
cd demos/power-bi/infra/windows
terraform init
MY_IP=$(curl -s https://checkip.amazonaws.com)
terraform apply -var "admin_cidr=${MY_IP}/32"
```

This creates one Windows Server 2022 EC2 instance (`t3.large`, gp3 root
volume) with RDP (3389) open only to `admin_cidr`, and its `user_data`
silently installs Power BI Desktop and the MySQL Connector/NET package on
first boot (see task 3 in plan section 4 for the exact download URLs and
switches; both rotate per release, so re-check them if `apply` is run much
later than this was written). Allow a few minutes after `apply` finishes
for that install to complete before connecting.

Get the Administrator password:

```bash
terraform output get_password_data_command   # prints the exact command; run it verbatim
```

(Windows needs a few minutes after launch to generate the password; retry
the command if it errors immediately after `apply`.)

### 3. Connect and configure the report

Open an RDP client (e.g. Microsoft Remote Desktop) to `terraform output
rdp_target`, log in as `Administrator` with the decrypted password, and
open `C:\lab\README.txt` for the connection placeholders and the exact
three SQL statements to paste. In Power BI Desktop: Get Data > More... >
Database > MySQL database, enter the TiDB Cloud Starter host:port and
database, then under Advanced options use "Native SQL statement" to pin
each of the report's three visuals to the exact SQL in
`runner/src/dashboardQueries.ts` (also copied into `C:\lab\README.txt`).
Paste the cluster password directly into Power BI's own credential dialog;
it is never written to disk on the instance. Do not click Refresh yet.

### 4. Run the replay and record the live refresh

From `integrations/`, run `pnpm lab run power-bi --record` and let it play
through to the `power-bi-live` phase (about 195 seconds) untouched. When
that phase starts, switch to the RDP session, click Refresh in Power BI
Desktop, and start screen-recording the report updating. Let the runner
continue into `wrap-up` and exit.

Copy the resulting trace to `demos/power-bi/traces/featured.json`, run
`pnpm lab validate power-bi` and `pnpm lab check-public`.

## Teardown

```bash
cd demos/power-bi/infra/windows
terraform destroy -var "admin_cidr=${MY_IP}/32"   # same admin_cidr value used to apply

# TiDB Cloud Starter cluster: see infra/tidbcloud-starter's own README/teardown

tiup clean lab   # only if the local playground was used for development
```

Tear both the EC2 instance and the TiDB Cloud cluster down the same day as
any recording.

## Cost notes

Both the TiDB Cloud Starter cluster and the EC2 Windows instance bill by
time; no prices are hardcoded here since they change. See the current
rates at:

- TiDB Cloud pricing: https://www.pingcap.com/pricing/
- EC2 Windows on-demand pricing (`t3.large`, us-west-2):
  https://aws.amazon.com/ec2/pricing/on-demand/

Tear both down the same day as any recording.
