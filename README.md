# TiDB Demos

A collection of TiDB demo repositories showcasing various use cases and applications.

## AI Agents & Memory

- [TiDB Self-Healing DB Agent](https://github.com/bernard-kavanagh/tidb-self-healing-db-agent) — Autonomous self-healing database agent powered by TiDB
- [DB9 Agent](https://github.com/bernard-kavanagh/db9-agent) — DB9 agentic demo using TiDB
- [TiDB Agent](https://github.com/bernard-kavanagh/tidb-agent) — General-purpose TiDB agent demo
- [Mem9 Agent Demo](https://github.com/stephenlthorn/mem9-demo) — Agent memory demo on Mem9
- [Mem9 AI Coding](https://github.com/stephenlthorn/mem9-ai-coding) — Persistent AI coding memory on TiDB Cloud Zero, showing how Claude Code + the Mem9 plugin remembers developer context across sessions

## Fraud Detection & Analytics

- [TiDB Fraud Detection](https://github.com/bernard-kavanagh/tidb_fraud_detection) — Real-time fraud detection powered by TiDB
- [Finance Fraud Detection](https://github.com/stephenlthorn/FinanceFraud) — TiDB Cloud demo combining hybrid search (BM25 + vector) and recursive-CTE graph fraud detection in a Streamlit app
- [EV Charger Anomaly Detection](https://github.com/bernard-kavanagh/ev_charger_anomaly_detection) — Anomaly detection for EV charging stations using TiDB
- [HTAP: Real-Time OLTP + OLAP Without ETL](htap-realtime-oltp-olap/) — Concurrent OLTP (TiKV row store) and OLAP (TiFlash columnar store) from a single TiDB cluster with zero ETL lag

## POC & Sales Tools

- [TiDB POV Kit (Self-Service)](https://github.com/stephenlthorn/tidb-pov-kit-self-service) — Self-service proof-of-value kit for running TiDB POCs
- [AI 30-Minute Demo](https://github.com/stephenlthorn/ai-30-min-demo) — FastAPI booth deck for a 30-minute AI demo on TiDB

## Integration Lab

[TiDB Integration Lab](integrations/) - animated, measured demos of TiDB working with the tools customers already run. Each demo runs live against real systems and shows the data flow as an animated diagram with metric tiles, phase captions, pass/fail correctness checks, and control buttons (bursts, faults, cutovers). One live run is recorded as a replay, and a static site plays it back. Every number in a replay comes from that run.

| # | Demo | What it proves | Runs on | Replay |
|---|---|---|---|---|
| 01 | [AWS DMS](integrations/demos/aws-dms/) | Full load, live CDC and a measured cutover from Aurora PostgreSQL to TiDB | AWS + TiDB Cloud | recorded |
| 02 | [Kafka](integrations/demos/kafka/) | Payments through Kafka into TiDB, every change back out through TiCDC, no loss or duplicates | Local | recorded |
| 03 | [Debezium](integrations/demos/debezium/) | Stock Debezium and Kafka Connect replicate into TiDB, and TiCDC speaks Debezium format back out | Local | recorded |
| 04 | [Redis](integrations/demos/redis/) | TiCDC-driven cache invalidation vs TTLs, with a measured stale read rate | Local | recorded |
| 05 | [Okta](integrations/demos/okta/) | Okta group membership drives TiDB grants, including a revoke | Local + Okta developer org | recorded |
| 06 | [Databricks](integrations/demos/databricks/) | TiDB serves live features while Databricks trains and scores on the same fresh data | Databricks Free Edition + TiDB Cloud Starter | recorded |
| 08 | [Prometheus / Grafana](integrations/demos/prometheus-grafana/) | TiDB metrics detect injected faults, with measured time to detect | Local | recorded |
| 09 | [Datadog](integrations/demos/datadog/) | TiDB metrics, APM traces to a SQL digest, and Monitors that fire and resolve | Local + Datadog account | recorded |
| 10 | [Terraform / EKS](integrations/demos/terraform-eks/) | TiDB Cloud, EKS and an app provisioned in one `terraform apply` | AWS + TiDB Cloud | recorded |
| 11 | [Power BI](integrations/demos/power-bi/) | One TiDB cluster serves the order pipeline and a live Power BI report, with no ETL | TiDB Cloud Starter + Power BI | recorded |

Every demo has been run live and recorded; each replay carries the environment it was recorded in.

### Next up: the TiDB Cloud agent stack (planned, not built yet)

AI agents need three kinds of data, and TiDB Cloud now has a product for each:

- **TiDB Cloud Filesystem** holds an agent's **files**: a persistent workspace that outlives any sandbox, with copy-on-write layers, checkpoints and forks, plus an append-only journal for auditing.
- **TiDB X**, the architecture behind TiDB Cloud Starter, Essential and Premium, holds the agent's **live state**: a database per agent or per task, copy-on-write branches taken at a point in time, and vector, full-text and hybrid search in plain SQL for agent memory.
- **TiDB Cloud Lake** holds the **history**: a cloud data warehouse where every run, decision and outcome lands for analytics and evaluation.

Two new demos show all three working together. Each one will be built like the demos above: it runs live against the real products, a run is recorded, and the site replays it with the animated diagram, metrics, captions and checks.

| # | Demo | The story | What it proves |
|---|---|---|---|
| 12 | [Coding-agent platform](integrations/docs/plans/12-agent-coding-platform.md) | A fictional company, Kiteline, sells an AI coding agent. One ticket fans out into three attempts at the fix. | Each attempt gets its own Filesystem layer and its own Starter database branch, both starting from the same point. A failed attempt is rebuilt exactly as it stood at the failing step, and the same tests fail again. Run events reach Lake within about a minute for evaluation, and the lesson learned goes back into the agent's memory. |
| 13 | [Anti-money-laundering agent](integrations/docs/plans/13-agent-aml.md) | A fictional bank, Harbor Mutual, runs an agent that investigates suspicious transactions. Synthetic data only. | Every alert gets a case workspace in the Filesystem and an investigation branch, so a rule change can be tested without touching production. Past cases are recalled with hybrid search. Lake measures the precision of each rule version, and an improved skill reaches the shared workspace only when a person promotes it. |

Both demos use a scripted agent rather than a language model, so the replay measures the data infrastructure, not model quality. Filesystem, branching and Lake are in public preview, and the plans list every product fact still to be confirmed against a live account before building.

**Watch it in your browser, no install:** https://stephenlthorn.github.io/tidb-demos/

To watch the replays on your machine (Node.js 22+ and pnpm 10+, no database needed):

```bash
git clone https://github.com/stephenlthorn/tidb-demos.git
cd tidb-demos/integrations
pnpm install
pnpm dev
```

See [integrations/README.md](integrations/README.md) for running a demo live and recording your own replay. Plans, one per demo, are in [integrations/docs/plans/](integrations/docs/plans/).
