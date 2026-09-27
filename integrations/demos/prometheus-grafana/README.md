# Prometheus, Grafana, and Alertmanager + TiDB

## What it proves

TiDB, TiKV, and PD expose Prometheus metrics on their own status ports with no
sidecar or exporter required. This demo wires those metrics into a demo-local
Prometheus and Alertmanager (standing in for the Prometheus and Alertmanager a
platform team already runs) and shows four common failure modes, each detected
by an off-the-shelf PromQL alert rule and each resolving on its own once the
fault clears: a slow-query storm, a write hot spot, a TiKV store outage, and a
connection surge.

## Prerequisites

- Docker Desktop running
- tiup installed (`curl --proto '=https' --tlsv1.2 -sSf https://tiup-mirrors.pingcap.com/install.sh | sh`)
- Node 22, pnpm

## Run

1. `bash ../../infra/tidb/playground.sh --tag lab-08 --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1`
2. `docker compose -f infra/docker-compose.yml up -d`
3. `cp .env.example .env` and fill in `LAB_ENV_TIDB` with the version tiup printed
4. From the `integrations/` workspace root: `pnpm lab run prometheus-grafana --port 7070`
5. Open the UI (see the platform's `packages/ui` dev server) and press the fault
   buttons, or `curl -X POST localhost:7070/control/<control-id>`

## Record

`pnpm lab run prometheus-grafana --record --port 7070`, exercise every control
listed in the manifest in order, then Ctrl-C. Promote the newest file under
`traces/` to `traces/featured.json`, run `pnpm lab validate prometheus-grafana`,
then `pnpm lab check-public`.

## Teardown

```
docker compose -f infra/docker-compose.yml down -v
tiup clean lab-08
```

Confirm nothing is left running: `docker compose -f infra/docker-compose.yml ps`
shows no containers, and `tiup playground display` in the terminal that ran the
playground exits or shows no processes once it is stopped with Ctrl-C.

## Cost notes

Fully local; no third-party billing. An optional appendix records the same
dashboard against a TiDB Cloud Dedicated cluster; Dedicated clusters bill
hourly. See the current pricing and formula at https://www.pingcap.com/pricing/
(no price is hardcoded here), and pause or delete the cluster immediately after
recording.
