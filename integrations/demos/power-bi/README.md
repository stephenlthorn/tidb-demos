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
- A Windows environment for Power BI Desktop only: an Azure VM, a Windows
  365 Cloud PC, or a local Parallels/UTM Windows VM. Power BI Desktop is
  Windows-only. Power BI Desktop itself is a free download from Microsoft:
  https://www.microsoft.com/en-us/download/details.aspx?id=58494
- The Oracle MySQL Connector/NET package installed on the Power BI Desktop
  machine, required by Power BI's MySQL database connector:
  https://learn.microsoft.com/en-us/power-query/connectors/mysql-database

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

1. Provision a fresh TiDB Cloud cluster (Starter or Essential tier;
   re-confirm TiFlash support first) and point `demos/power-bi/.env` at it
   with `TIDB_TLS=true`.
2. Seed it once: `pnpm --filter @lab/demo-power-bi exec tsx runner/setup.ts`.
3. Start the Windows VM, install Power BI Desktop and the MySQL connector
   prerequisite, and open a report pointed at the same cluster with its
   three visuals pinned to the exact SQL in `runner/src/dashboardQueries.ts`
   via the connector's "Native SQL statement" advanced option. Do not
   click Refresh yet.
4. From `integrations/`, run `pnpm lab run power-bi --record` and let it
   play through to the `power-bi-live` phase (about 195 seconds)
   untouched.
5. When the `power-bi-live` phase starts, switch to the Windows VM, click
   Refresh, and start a screen recording of the report updating. Let the
   runner continue into `wrap-up` and exit.
6. Copy the resulting trace to `demos/power-bi/traces/featured.json`, run
   `pnpm lab validate power-bi` and `pnpm lab check-public`, then tear down
   both the Windows VM and the TiDB Cloud cluster the same day.

## Teardown

```bash
ticloud serverless delete --cluster-id <cluster-id>
az vm deallocate --resource-group lab-power-bi-rg --name lab-power-bi-vm
az group delete --name lab-power-bi-rg --yes --no-wait
tiup clean lab   # if the local playground was used
```

## Cost notes

The TiDB Cloud cluster and the Windows VM both bill by time; no prices
are hardcoded here since they change. See the current rates at:

- TiDB Cloud pricing: https://www.pingcap.com/pricing/
- Azure Windows VM pricing: https://azure.microsoft.com/en-us/pricing/details/virtual-machines/windows/
- Windows 365 pricing (alternative to an Azure VM): https://www.microsoft.com/en-us/windows-365/business/compare-plans-pricing

Tear both down the same day as any recording.
