# Kafka + TiDB: fintech risk pipeline

Payment events stream through Kafka into TiDB. TiCDC streams every committed
change back out to a second Kafka topic for downstream consumers, proving
TiDB can sit inside an existing Kafka-centric architecture as both a
consumer's write target and a CDC source.

## What it proves

- TiDB absorbs a 10x burst (`burst` control) without falling behind, shown
  live in the `ingest-rate` and `ticdc-checkpoint-lag` metrics.
- An ingester crash and restart (`restart-ingester` control) causes zero
  lost or duplicated rows in TiDB, because the upsert is idempotent on
  `payment_id`. The `consumer-lag-payments` metric and the
  `zero-duplicate-rows-in-tidb` check prove it.
- TiCDC catches up cleanly after a changefeed pause and resume
  (`pause-changefeed` / `resume-changefeed` controls), and its at-least-once
  delivery is measured, not hidden: the `duplicates-observed` metric ticks
  up on purpose during that phase.
- `produced-equals-tidb-rows` and `tidb-rows-equals-cdc-distinct` hold at
  every check point once the producer is idle, proving the pipeline lost
  nothing end to end.

This is not a maximum-throughput benchmark. The load profile is sized to be
visible in a 3-6 minute recording, not to be a capacity test.

## Prerequisites

- Docker Desktop running.
- tiup installed.
- Node 22 and pnpm installed.
- Accounts and access: none required for the local variant below. See
  "TiDB Cloud variant" for what a Dedicated cluster and a reachable Kafka
  cluster add.

## Run locally

From `integrations/`:

1. Start the shared Kafka broker:

   ```bash
   docker compose -f infra/kafka/docker-compose.yml up -d
   ```

   Expect `lab-kafka` reported `healthy` within about 20 seconds
   (`docker compose -f infra/kafka/docker-compose.yml ps`).

2. Start the local TiDB playground:

   ```bash
   infra/tidb/playground.sh
   ```

   This prints the TiDB, PD, and TiCDC listening addresses and the TiDB
   version. Keep the version string handy for `LAB_ENV_TIDB` if you record
   a trace.

3. Create the working database and table:

   ```bash
   mysql -h 127.0.0.1 -P 4000 -u root -e "CREATE DATABASE IF NOT EXISTS lab; USE lab; CREATE TABLE IF NOT EXISTS payments (payment_id VARCHAR(32) PRIMARY KEY, account_id VARCHAR(32) NOT NULL, amount_cents BIGINT NOT NULL, currency VARCHAR(8) NOT NULL, produce_ts BIGINT NOT NULL);"
   ```

4. Confirm the TiCDC OpenAPI v2 is reachable:

   ```bash
   curl -s http://127.0.0.1:8300/api/v2/status
   ```

   Expect a JSON response with `"is_owner"` and no connection error.

5. Create the changefeed with canal-json output and TiDB extension fields
   enabled (the extension fields carry `commitTs`, which the dedupe logic
   depends on):

   ```bash
   cdc cli changefeed create \
     --server=http://127.0.0.1:8300 \
     --sink-uri="kafka://127.0.0.1:9092/tidb-changes?protocol=canal-json&kafka-version=3.0.0&partition-num=3&max-message-bytes=10485760&replication-factor=1&enable-tidb-extension=true" \
     --changefeed-id="kafka-fintech-risk"
   ```

   Expect `Create changefeed successfully!` followed by an
   `ID: kafka-fintech-risk` line and a JSON `Info` block with
   `"state":"normal"`.

   Confirm it: `curl -s http://127.0.0.1:8300/api/v2/changefeeds/kafka-fintech-risk`
   should show `"state":"normal"`, a non-zero `checkpoint_ts`, and a
   `checkpoint_time` string.

6. Copy the environment template and fill in the values from steps above:

   ```bash
   cp demos/kafka/.env.example demos/kafka/.env
   ```

7. Run the demo:

   ```bash
   pnpm lab run kafka --record
   ```

8. Open the UI at `http://localhost:5173` and step through the phases in
   order: warm-up, steady-state, then use the controls to trigger the
   10x burst, the ingester restart, and the changefeed pause/resume, ending
   on wrap-up.

## Record

`pnpm lab run kafka --record` writes `demos/kafka/traces/<timestamp>.json`.
Promote a good run: `cp demos/kafka/traces/<timestamp>.json demos/kafka/traces/featured.json`.

## Teardown

Run these in order so no changefeed is left orphaned once TiDB is gone:

```bash
cdc cli changefeed remove --changefeed-id=kafka-fintech-risk --server=http://127.0.0.1:8300
docker compose -f infra/kafka/docker-compose.yml down -v
tiup clean lab
```

## TiDB Cloud variant

TiDB Cloud Dedicated supports changefeeds to Apache Kafka; TiDB Cloud
Starter does not support changefeeds at all, and Essential's changefeed
support is available only on request, not self-serve. Check the current
tier support before promising a customer either path:
[Changefeed Overview](https://docs.pingcap.com/tidbcloud/changefeed-overview/).

To run this demo against TiDB Cloud instead of the local playground:

- Provision a TiDB Cloud Dedicated cluster (the minimum version for Kafka
  changefeeds, and the higher minimum for the Debezium output format, are
  documented on
  [Sink to Apache Kafka](https://docs.pingcap.com/tidbcloud/changefeed-sink-to-apache-kafka/) -
  confirm the current numbers there rather than trusting a cached copy).
- Point the sink at a Kafka cluster TiDB Cloud can reach: self-hosted and
  reachable by Private Connect or VPC Peering, or a public IP. TiDB Cloud
  does not support Private Connect directly into a managed Kafka SaaS
  (MSK, Confluent Cloud) without a `kafka-proxy` intermediary; see the same
  page for the current setup.
- Create the changefeed from the TiDB Cloud console's Changefeed page (or
  the Cloud API) instead of `cdc cli`.
- Teardown: delete the changefeed from the Changefeed page (or
  `DELETE /api/v2/changefeeds/{id}` via the Cloud API) and confirm it no
  longer appears in the console before pausing or deleting the cluster
  itself.

## Cost notes

The local run above costs nothing beyond compute. The TiDB Cloud Dedicated
variant bills cluster node time (see the cluster's own pricing page) plus
changefeed traffic in TiCDC Replication Capacity Units; see
[Changefeed Billing for TiDB Cloud Dedicated](https://docs.pingcap.com/tidbcloud/tidb-cloud-billing-ticdc-rcu/)
for the formula. No price is quoted here because it changes independently
of this repo.
