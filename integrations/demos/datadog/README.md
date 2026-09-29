# Datadog + TiDB

## What it proves

TiDB's own metrics reach Datadog through the official Agent-based `tidb` OpenMetrics
integration, a real SQL query shows up as a Datadog APM span that correlates back to
TiDB's own `information_schema.statements_summary`, and four Datadog Monitors detect
the same fault signatures as the Prometheus demo (Plan 08), each with a measured
time-to-detect read back from Datadog's own Monitor API.

## Prerequisites

- Docker Desktop running
- tiup installed
- Node 22, pnpm
- A Datadog account (a free trial is sufficient; see
  https://www.datadoghq.com/free-datadog-trial/) with an API key and an
  Application key

## Run

1. `bash ../../infra/tidb/playground.sh --tag lab-09 --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1`
2. `cp .env.example .env` and fill in `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`
3. `docker compose -f infra/docker-compose.yml up -d`
4. Create the four Monitors: `DD_API_KEY=$DD_API_KEY DD_APP_KEY=$DD_APP_KEY DD_SITE=$DD_SITE node --import tsx runner/createMonitors.ts`, and confirm `demos/datadog/.monitor-ids.json` was written
5. Start the APM service: `DD_API_KEY=$DD_API_KEY node --import tsx apm-service/server.ts`
6. From the `integrations/` workspace root: `pnpm lab run datadog --port 7071`
7. Press the fault buttons in the UI, or `curl -X POST localhost:7071/control/<control-id>`

## Record

`pnpm lab run datadog --record --port 7071`, exercise every control in order, then
Ctrl-C. Promote the newest file under `traces/` to `traces/featured.json`, run
`pnpm lab validate datadog`, then `pnpm lab check-public`.

## Teardown

```
docker compose -f infra/docker-compose.yml down -v
for id in $(cat .monitor-ids.json | jq -r '.[]'); do
  curl -X DELETE -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
    "https://api.datadoghq.com/api/v1/monitor/$id"
done
tiup clean lab-09
```

Confirm nothing is left billing: the Datadog Monitors list shows none of the four
`Lab: TiDB *` monitors, and the Integrations > TiDB page shows no recently reporting
host once the Agent container is stopped.

## Cost notes

See Section 5 of the implementation plan (`docs/plans/09-datadog.md`) for the
Datadog pricing formula link and the free-trial link; no price is hardcoded here.

## Live proof: the real Datadog UI

Recorded 2026-09-29 during a live run against a Datadog trial org and the local TiDB playground. The lab dashboard (left) and the real Datadog UI (right) are captured side by side; account details are blurred.

- Video (4x speed): [media/datadog-live-side-by-side.mp4](media/datadog-live-side-by-side.mp4)
- Screenshots at each phase and check verdict: [media/screenshots/](media/screenshots/)
  - The slow query as an APM span tagged with its SQL: [04-check-slow-span-correlated-pass.jpg](media/screenshots/04-check-slow-span-correlated-pass.jpg)
  - The TiKV store outage monitor firing and resolving: [11-check-detect-store-outage-pass.jpg](media/screenshots/11-check-detect-store-outage-pass.jpg)
  - The connection surge monitor crossing its 150-connection threshold: [13-phase-connection-surge.jpg](media/screenshots/13-phase-connection-surge.jpg)
  - The two monitors that cannot fire on the macOS playground (their metrics are not forwarded by the Datadog TiDB check), shown honestly as fails: [05-check-detect-slow-query-storm-fail.jpg](media/screenshots/05-check-detect-slow-query-storm-fail.jpg), [08-check-detect-write-hot-spot-fail.jpg](media/screenshots/08-check-detect-write-hot-spot-fail.jpg)
