# TiDB Integration Lab

Demos of TiDB working with the tools customers already run. Each demo shows the data flow as an animated diagram with live metrics, runs live against real systems, and records a replay that the static site plays back.

## Quick start

```bash
pnpm install
pnpm test
bash infra/tidb/playground.sh      # separate terminal
pnpm lab run example               # separate terminal
pnpm dev                           # open the printed URL
```

## Demos

| # | Demo | Runs on | Replay |
|---|---|---|---|
| 00 | [Platform and example](demos/example/) | Local | recorded |
| 01 | [AWS DMS](demos/aws-dms/) | AWS + TiDB Cloud | pending |
| 02 | [Kafka](demos/kafka/) | Local | recorded |
| 03 | [Debezium](demos/debezium/) | Local | pending |
| 04 | [Redis](demos/redis/) | Local | pending |
| 05 | [Okta](demos/okta/) | Local + Okta developer org | pending |
| 06 | [Databricks](demos/databricks/) | Databricks Free Edition + TiDB Cloud Starter | pending |
| 07 | [Chalk](demos/chalk/) | Local + Chalk account | pending |
| 08 | [Prometheus / Grafana](demos/prometheus-grafana/) | Local | pending |
| 09 | [Datadog](demos/datadog/) | Local + Datadog account | pending |
| 10 | [Terraform / EKS](demos/terraform-eks/) | AWS + TiDB Cloud | pending |
| 11 | [Power BI](demos/power-bi/) | TiDB Cloud Starter + Power BI | pending |

Each demo folder has a README (prerequisites, run, record, teardown, cost notes) and a TALK-TRACK.md. The full plan for each demo, including what was verified against real systems, is in [docs/plans/](docs/plans/README.md).

### Recording a replay

1. Start what the demo's README lists (the shared TiDB playground, shared Kafka, and the demo's own `infra/`).
2. `cp demos/<id>/.env.example demos/<id>/.env` and fill in the real values, including the component versions you started.
3. `pnpm lab run <id> --record`, then press the controls from the UI (or `curl -X POST http://127.0.0.1:7070/control/<control-id>`).
4. `pnpm lab validate <id>` checks the recorded `traces/featured.json`, which the site plays back.

A replay is one real run. It is never edited by hand, and it carries the environment it was recorded in.

## Rules

- No customer names or internal links anywhere (`pnpm lab check-public` enforces it).
- Every metric says how it was measured; every replay says where it was recorded.
