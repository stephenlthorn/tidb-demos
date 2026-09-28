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
| 01 | [AWS DMS](integrations/demos/aws-dms/) | Full load, live CDC and a measured cutover from Aurora PostgreSQL to TiDB | AWS + TiDB Cloud | pending |
| 02 | [Kafka](integrations/demos/kafka/) | Payments through Kafka into TiDB, every change back out through TiCDC, no loss or duplicates | Local | recorded |
| 03 | [Debezium](integrations/demos/debezium/) | Stock Debezium and Kafka Connect replicate into TiDB, and TiCDC speaks Debezium format back out | Local | pending |
| 04 | [Redis](integrations/demos/redis/) | TiCDC-driven cache invalidation vs TTLs, with a measured stale read rate | Local | pending |
| 05 | [Okta](integrations/demos/okta/) | Okta group membership drives TiDB grants, including a revoke | Local + Okta developer org | pending |
| 06 | [Databricks](integrations/demos/databricks/) | TiDB serves live features while Databricks trains and scores on the same fresh data | Databricks Free Edition + TiDB Cloud Starter | pending |
| 07 | [Chalk](integrations/demos/chalk/) | Chalk resolvers read fresh TiDB aggregates for online fraud features, checked against direct SQL | Local + Chalk account | pending |
| 08 | [Prometheus / Grafana](integrations/demos/prometheus-grafana/) | TiDB metrics detect injected faults, with measured time to detect | Local | pending |
| 09 | [Datadog](integrations/demos/datadog/) | TiDB metrics, APM traces to a SQL digest, and Monitors that fire and resolve | Local + Datadog account | pending |
| 10 | [Terraform / EKS](integrations/demos/terraform-eks/) | TiDB Cloud, EKS and an app provisioned in one `terraform apply` | AWS + TiDB Cloud | pending |
| 11 | [Power BI](integrations/demos/power-bi/) | One TiDB cluster serves the order pipeline and a live Power BI report, with no ETL | TiDB Cloud Starter + Power BI | pending |
| 12 | [Call copilot](integrations/demos/call-copilot/) | Live retrieval-grounded suggestions during a call, on TiDB hybrid search | TiDB Cloud Starter + LLM and speech APIs | pending |

All code is built and tested. "Pending" means the demo has not been run live and recorded yet. Plans, one per demo, are in [integrations/docs/plans/](integrations/docs/plans/).
