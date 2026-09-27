# TiDB + Databricks: Operational Store Meets the Lakehouse

## What this proves

Databricks reads live TiDB data through a read-only Lakehouse Federation
connection (no export job, no staging bucket), computes a per-customer risk
score, and the runner reverse-ETLs those scores back into TiDB. An app then
serves the fresh scores out of TiDB at OLTP latency while writes keep
flowing, and an optional ad hoc analytical query answers over the same fresh
rows from TiDB's columnar (TiFlash) replica. See `docs/plans/06-databricks.md`
in this repo for the full design, verified facts and sources, and the
rationale for choosing this path over TiCDC-to-Kafka or export-to-S3.

## Prerequisites

- A TiDB Cloud **Starter** cluster (free), with its public endpoint's IP
  access list open to your machine and to Databricks (see "Networking" below).
- A Databricks workspace: try **Free Edition** first; if the federated read
  in setup step 3 below cannot reach TiDB Cloud's host, use a free trial
  workspace instead. A personal access token with permission to run
  statements on a SQL warehouse and manage Unity Catalog connections/catalogs.
- A Databricks secret scope holding the TiDB username and password.
- Node 22 and pnpm.

## One-time setup

1. Create the TiDB Cloud Starter cluster; note its host and create a
   database user for this demo.
2. In a terminal, create the Databricks secret scope and secrets:
   ```bash
   databricks secrets create-scope --scope lab-tidb
   databricks secrets put-secret lab-tidb tidb-user
   databricks secrets put-secret lab-tidb tidb-password
   ```
3. In the Databricks SQL editor, run the statements in `sql/databricks-setup.sql`
   in order: create the connection, register the foreign catalog, create the
   `main.lab_databricks.risk_scores` table, then confirm the federated read
   reaches TiDB with the trailing `SELECT` in that file.
4. Copy `.env.example` to `.env` and fill in the TiDB and Databricks values.
5. `pnpm install` at the `integrations/` workspace root.

## Run

```bash
pnpm lab run databricks --port 7070
```

Open the UI (see the platform's own README for how it points at a running
relay) to watch the flow diagram and metrics live, or drive it headless with:

```bash
curl http://localhost:7070/health
curl -X POST http://localhost:7070/control/trigger-scoring
curl -X POST http://localhost:7070/control/burst-events
curl -X POST http://localhost:7070/control/change-rule
curl -X POST http://localhost:7070/control/run-analytics
```

## Record

```bash
pnpm lab run databricks --record --port 7070
```

Stop with Ctrl-C when done; promote the newest file under
`demos/databricks/traces/` to `traces/featured.json`. Full recording
choreography is in `docs/plans/06-databricks.md` Section 8.

## Networking

Databricks serverless compute does not have a fixed outbound IP unless the
workspace has a Network Connectivity Configuration. For this demo, the
practical option is to temporarily open the TiDB Cloud Starter cluster's
public endpoint allow list to all IPs while recording or demoing live, then
tighten it back down. This is a demo convenience, not a production pattern.

## Cost

TiDB Cloud Starter has a free monthly quota; this demo's traffic is designed
to stay inside it (see current quota and pricing at
https://www.pingcap.com/tidb-cloud-starter-pricing-details/). Databricks
bills the SQL warehouse's DBUs while it runs (see
https://www.databricks.com/product/pricing/databricks-sql); use a small
serverless warehouse with a short auto-stop timeout, or Free Edition if it
works for your workspace.

## Teardown

Run the statements in `sql/databricks-teardown.sql` in the Databricks SQL
editor, then: stop the Databricks SQL warehouse, delete the personal access
token, delete the secret scope
(`databricks secrets delete-scope --scope lab-tidb`), and delete or lock back
down the TiDB Cloud Starter cluster's public endpoint allow list.
