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

1. Start (or reuse) the shared playground tagged `lab`:
   `bash ../../infra/tidb/playground.sh` (this platform script tags the
   playground `lab` and starts TiDB, PD, TiKV, TiCDC, TiFlash, plus the
   playground's own Prometheus on `9090` and Grafana on `3000`). If a `lab`
   playground is already running, reuse it; do not start a second one.
2. `docker compose -f infra/docker-compose.yml up -d`
3. `cp .env.example .env` and fill in `LAB_ENV_TIDB` with the version tiup
   printed (`select tidb_version()` against `127.0.0.1:4000` also shows it),
   plus the `LAB_ENV_COMPONENT_*` versions actually running.
4. From the `integrations/` workspace root: `pnpm lab run prometheus-grafana --port 7070`
5. Open the UI (see the platform's `packages/ui` dev server) and press the fault
   buttons, or `curl -m 10 -X POST localhost:7070/control/<control-id>`

## Ports

| Component | Port | Notes |
|---|---|---|
| Shared playground TiDB | `4000` | `tiup playground` tag `lab`, shared across demos |
| Shared playground PD | `2379` | client URL; metrics at `/metrics` |
| Shared playground TiKV status | `20180` | metrics at `/metrics` |
| Shared playground's own Prometheus | `9090` | started by `infra/tidb/playground.sh`; this demo's Prometheus federates from it |
| Shared playground's own Grafana | `3000` | started by the playground. **Another project's container (`grafana-grafana-1`, not part of this demo) also binds `*:3000`.** Both can be listening at once (IPv4 vs IPv6 wildcard bind); if `http://localhost:3000` shows the wrong dashboard, check with `lsof -nP -iTCP:3000 -sTCP:LISTEN` and browse `http://127.0.0.1:3000` explicitly for the playground's own Grafana. Never stop `grafana-grafana-1`. |
| This demo's Prometheus | `9091` (host) -> `9090` (container) | `LAB_PROMETHEUS_URL`; federates `{job=~"tidb\|tikv\|pd"}` from the playground's `9090` |
| This demo's Alertmanager | `9093` | `LAB_ALERTMANAGER_URL` |
| Webhook receiver (in the runner process) | `9095` | `WEBHOOK_PORT`; receives Alertmanager notifications |
| Relay control/event server | `7070` | passed via `pnpm lab run prometheus-grafana --port 7070`; not fixed in `.env` |

None of this demo's own ports (`9091`, `9093`, `9095`, `7070`) collide with the
other non-lab containers documented in the platform plan (`pov_postgres16`
15432, `pov_mysql84` 23306, `dm-master`/`dm-worker` 8261/8262, `grafana-grafana-1`
on `3000`). If a future run finds one of `9091`/`9093`/`9095`/`7070` taken,
remap the host side in `infra/docker-compose.yml` (Prometheus/Alertmanager) or
`.env` (`WEBHOOK_PORT`, or `--port` for the relay) and update this table.

## Record

`pnpm lab run prometheus-grafana --record --port 7070`, exercise every control
listed in the manifest in order, then Ctrl-C. Promote the newest file under
`traces/` to `traces/featured.json`, run `pnpm lab validate prometheus-grafana`,
then `pnpm lab check-public`.

## Teardown

```
docker compose -f infra/docker-compose.yml down -v
```

This stops only this demo's own Prometheus and Alertmanager containers. Leave
the shared `lab` playground and shared Kafka running for the next demo; do not
run `tiup clean lab` after a shared recording session. Confirm nothing extra is
left running: `docker compose -f infra/docker-compose.yml ps` shows no
containers, and `tiup playground display` still shows `pd`/`tikv`/`tidb` (and
any other tagged roles) as healthy, not `exited`.

## Cost notes

Fully local; no third-party billing. An optional appendix records the same
dashboard against a TiDB Cloud Dedicated cluster; Dedicated clusters bill
hourly. See the current pricing and formula at https://www.pingcap.com/pricing/
(no price is hardcoded here), and pause or delete the cluster immediately after
recording.
