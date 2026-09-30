# TiDB Integration Lab

Demos of TiDB working with the tools customers already run. Each demo shows the data flow as an animated diagram with live metrics, runs live against real systems, and records a replay that the static site plays back.

## Quick start

**Live site (no install):** https://stephenlthorn.github.io/tidb-demos/ plays every replay and shows the console video and screenshots.

### Watch the recorded replays (no database or cloud account needed)

Requirements: Node.js 22+ and pnpm 10+ (`npm install -g pnpm`).

```bash
git clone https://github.com/stephenlthorn/tidb-demos.git
cd tidb-demos/integrations
pnpm install
pnpm dev
```

Open the printed URL (usually http://localhost:5173). Every demo card plays back a replay recorded from a real live run: the animated data-flow diagram, the metric tiles, the phase narration and the pass/fail checks, at 1x-8x speed with a scrubber. Okta and Datadog also have side-by-side video and screenshots of the real vendor console in `demos/okta/media/` and `demos/datadog/media/`.

### Run a demo live yourself

Each demo's README lists exactly what it needs (local TiDB, Docker, or a cloud account) and how to tear it down. The local ones use a TiDB playground and, for some, Kafka:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://tiup-mirrors.pingcap.com/install.sh | sh   # installs tiup (TiDB)
bash infra/tidb/playground.sh                      # terminal 1: local TiDB with TiFlash and TiCDC
pnpm lab run example                               # terminal 2: the self-test demo
pnpm dev                                           # terminal 3: the dashboard
```

Then open http://localhost:5173/#/demo/example?relay=http://127.0.0.1:7070 to watch the live run (use the demo id and relay port you started).

`pnpm lab run <demo-id> --record` records a new replay into `demos/<demo-id>/traces/`. `pnpm test` runs every package's tests.

## Demos

| # | Demo | Runs on | Replay |
|---|---|---|---|
| 00 | [Platform and example](demos/example/) | Local | recorded |
| 01 | [AWS DMS](demos/aws-dms/) | AWS + TiDB Cloud | recorded |
| 02 | [Kafka](demos/kafka/) | Local | recorded |
| 03 | [Debezium](demos/debezium/) | Local | recorded |
| 04 | [Redis](demos/redis/) | Local | recorded |
| 05 | [Okta](demos/okta/) | Local + Okta developer org | recorded |
| 06 | [Databricks](demos/databricks/) | Databricks Free Edition + TiDB Cloud Starter | recorded |
| 08 | [Prometheus / Grafana](demos/prometheus-grafana/) | Local | recorded |
| 09 | [Datadog](demos/datadog/) | Local + Datadog account | recorded |
| 10 | [Terraform / EKS](demos/terraform-eks/) | AWS + TiDB Cloud | recorded |
| 11 | [Power BI](demos/power-bi/) | TiDB Cloud Starter + Power BI | recorded |

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

## Publishing the site

`pnpm build:site` builds the static site into `packages/ui/dist`. It is published by pushing that folder to the `gh-pages` branch (served at https://stephenlthorn.github.io/tidb-demos/).
