# TiDB Integration Lab: Roadmap

**Source of the asks:** the NA Solutions Engineering team thread (2026-09-25) on which tools, demos, and PoCs would help sell more. The requests were Chalk, Kafka, Datadog, Prometheus/Grafana, Power BI, AWS DMS, Debezium, Redis, Okta, Terraform/EKS, Databricks. The call copilot that was also asked for is a separate tool, not part of this lab.

**What every demo gets:** an animated flow diagram of the real data path, live metric tiles with sparklines (each one says exactly how it was measured), a phase timeline whose captions double as the talk track, correctness checks, and buttons that inject events (bursts, faults, revokes). Every demo runs **live** against real systems for calls, and records a **replay** that a static website plays back with play, pause, speed, and scrub.

**How to use this folder:** build Plan 00 once, then pick any demo plan and implement it top to bottom. To delegate the build to Sonnet subagents, follow [EXECUTION.md](EXECUTION.md): every plan ends with a section of work packets (tasks, owned files, shared runtime, gate commands), including verify packets that confirm open facts before code depends on them. Each plan is self-contained, test-first, and ends with a recorded `traces/featured.json` that goes on the site.

## Build order

| Order | Plan | Demo | Why this position | Local or cloud | Effort |
|---|---|---|---|---|---|
| 0 | [00-platform.md](00-platform.md) | Lab platform: contract, runner kits, relay, UI, site | Everything else plugs into it | Local | 3-4 days |
| 1 | [01-aws-dms.md](01-aws-dms.md) | AWS DMS: Aurora PostgreSQL to TiDB, full load + CDC + cutover | Active migration PoC depends on this story right now | AWS + TiDB Cloud | 2-3 days |
| 2 | [02-kafka.md](02-kafka.md) | Kafka in, TiCDC out: risk pipeline | Same active account's risk pipeline; builds the shared Kafka/TiCDC plumbing that 03, 04 and 06 reuse | Local | 2 days |
| 3 | [03-debezium.md](03-debezium.md) | Debezium + Kafka Connect in both directions | Reuses Plan 02 infra; answers "we already standardized on Debezium" | Local | 2 days |
| 4 | [04-redis.md](04-redis.md) | Redis cache correctness with CDC invalidation, and when TiDB alone is enough | Common objection; local and cheap | Local | 2 days |
| 5 | [05-okta.md](05-okta.md) | Okta: TiDB Cloud org SSO guide + identity lifecycle for DB access | Security reviews block deals; setup questions keep recurring | Okta dev org + local/TiDB Cloud | 2 days |
| 6 | [06-databricks.md](06-databricks.md) | Databricks: lakehouse next to an operational store, closed loop | Top booth question at data and AI conferences | Databricks + TiDB Cloud Starter | 2-3 days |
| 7 | [07-chalk.md](07-chalk.md) | Chalk: TiDB as the fresh source for real-time features | Clarifies the TiDB vs feature-platform boundary for ML teams; gated on Chalk access | Chalk + TiDB | 2-3 days |
| 8 | [08-prometheus-grafana.md](08-prometheus-grafana.md) | Prometheus/Grafana: metrics, alerts, time-to-detect per fault | Owns the shared workload generator and fault injector | Local | 2 days |
| 9 | [09-datadog.md](09-datadog.md) | Datadog: integration, APM spans with SQL, monitors | Reuses Plan 08's workload and faults | Datadog trial + local/TiDB Cloud | 2 days |
| 10 | [10-terraform-eks.md](10-terraform-eks.md) | Terraform + EKS: provision, connect privately, scale in place | Platform teams and bring-your-own-cloud style questions; most expensive to run | AWS + TiDB Cloud | 3 days |
| 11 | [11-power-bi.md](11-power-bi.md) | Power BI: live dashboards on TiFlash without ETL | Needs a Windows machine; lowest priority of the asks | Windows VM + TiDB | 2 days |

Plans 01 and 02 can run in parallel after Plan 00 if more than one person builds. Plan 03 needs 02's infra; 09 needs 08's workload generator.

## Architecture at a glance

```
 runner (any language)            relay (`pnpm lab run <id>`)                 browser
 +---------------------+  stdout  +------------------------------+   SSE    +--------------------------+
 | talks to Kafka, DMS, | ------> | validates each JSON line     | -------> | flow diagram, metrics,   |
 | Okta, TiDB, ...      |  NDJSON | fans out over /events        |          | phases, checks, logs     |
 | emits metric / flow /| <------ | POST /control/:id -> stdin   | <------- | control buttons (live)   |
 | node / phase / check |  stdin  | --record writes a trace file |  POST    |                          |
 +---------------------+          +------------------------------+          +--------------------------+
                                              |
                                  traces/featured.json  --->  static site (replay: play, pause, 1-8x, scrub)
```

## Definition of done for every demo

1. Live run works end to end with the exact commands in the plan.
2. Every metric is measured (or labeled simulated) and its `howMeasured` is accurate.
3. `traces/featured.json` recorded, `pnpm lab validate <id>` clean.
4. Replay renders in the UI and tells the story in 3-6 minutes of playback.
5. `README.md` and `TALK-TRACK.md` written; teardown commands tested and nothing left billing.
6. `pnpm lab check-public` passes: no customer names, no internal links.

## Open items across plans

Each plan's section 4 lists the facts it could not confirm while writing, each marked **UNVERIFIED** with the exact check to run first. The largest ones:

- **Chalk:** whether Chalk's MySQL source works against TiDB, and how to get a Chalk environment. Plan 07 opens with a smoke test that stops the plan if this fails.
- **Databricks:** whether Databricks Free Edition can reach a TiDB Cloud endpoint. Plan 06 tests this early; the fallback is a trial workspace.
- **AWS DMS:** exact CloudWatch dimensions and `DescribeTableStatistics` field names. Plan 01 captures a live response before coding against it.
- **Terraform/EKS:** whether the private endpoint resolves without private DNS on the VPC endpoint.
- **Power BI:** the MySQL connector is Import-only (no DirectQuery), so the plan pins visuals to exact SQL and shows a screen recording alongside the replayed query set.

## Backlog (asked for earlier, not in this round)

- Port the earlier single-feature demos (HTAP, write scaling, PITR, resource-control noisy neighbor, elastic autoscaling with cost guardrails, CDC exactly-once) into the lab shell so they get the same diagram and replay treatment.
- An agent-memory demo (vector + full-text) beyond what Plan 12 covers.
- A bring-your-own-cloud deployment walkthrough, extending Plan 10's appendix.
- A heterogeneous migration story for Oracle and SQL Server sources, alongside Plan 01.
