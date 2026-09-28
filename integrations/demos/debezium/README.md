# Debezium + TiDB: Postgres in, TiDB out, one consumer

A stock Debezium and Kafka Connect stack replicates live from PostgreSQL
into TiDB through a JDBC sink connector. Separately, TiDB emits its own
changes in Debezium's message format through TiCDC, so the same downstream
consumer code reads both.

## What it proves

- An existing Debezium PostgreSQL source connector plus a Debezium JDBC
  sink connector replicates into TiDB with no custom sink code.
- TiDB's own TiCDC changefeed can speak Debezium's format well enough that
  one consumer parses both a real Debezium topic and a TiCDC-Debezium topic.
- A live `ALTER TABLE ... ADD COLUMN` on the source is measured end to end,
  including what the sink connector's schema evolution setting does with it.

## Prerequisites

- Docker Desktop running.
- tiup installed.
- Node 22 and pnpm installed.
- `psql` and `mysql` CLI clients installed for manual verification.

## Run

1. `docker compose -f ../../infra/kafka/docker-compose.yml up -d` (shared Kafka, if not already running).
2. `../../infra/tidb/playground.sh` (local TiDB, if not already running).
3. Confirm the shared `lab` Docker network exists: `docker network inspect lab`.
4. Confirm the Debezium JDBC sink connector plugin is present in the
   `quay.io/debezium/connect` image tag you use, or mount the matching
   release JAR into `infra/connect-plugins/` before starting Connect.
5. `docker compose -f infra/docker-compose.yml up -d` (Postgres + Kafka Connect for this demo).
6. Create the source table, heartbeat table, and both Kafka Connect
   connectors (`postgres-source`, `tidb-sink`) against the running stack.
   The `tidb-sink` connector needs a `RegexRouter` transform to strip the
   `pg.public.` topic prefix (see Plan 03, Task 8 and Build notes) - without
   it the sink silently writes into `pg_public_accounts` /
   `pg_public_heartbeat` instead of `accounts` / `heartbeat`.
7. Create the TiCDC Debezium changefeed (`debezium-tidb-source`), or let
   the `start-ticdc-debezium` control create it once the run is live.
8. `cp .env.example .env` and fill in the values, including the exact
   TiDB and component versions you started.
9. `pnpm lab run debezium --record`.
10. Open the UI at `http://localhost:5173` and press the controls in order:
    `insert-burst`, then `start-ticdc-debezium`, then `add-column`.

## Record

`pnpm lab run debezium --record` writes `demos/debezium/traces/<timestamp>.json`.
Promote a good run: `cp demos/debezium/traces/<timestamp>.json demos/debezium/traces/featured.json`.

## Teardown

1. `curl -X DELETE http://127.0.0.1:8083/connectors/postgres-source`
2. `curl -X DELETE http://127.0.0.1:8083/connectors/tidb-sink`
3. `cdc cli changefeed remove --changefeed-id=debezium-tidb-source --server=http://127.0.0.1:8300`
4. `docker compose -f infra/docker-compose.yml down -v`
5. `docker compose -f ../../infra/kafka/docker-compose.yml down -v` (if no other demo needs it)
6. `tiup clean lab`

## Cost notes

Local run costs nothing beyond compute. No hardcoded prices; a TiDB Cloud
Dedicated variant of Act B bills node time plus TiCDC Replication Capacity
Units, priced on the [TiDB Cloud pricing page](https://www.pingcap.com/tidb-cloud-pricing/)
and [Changefeed Billing for TiDB Cloud Dedicated](https://docs.pingcap.com/tidbcloud/tidb-cloud-billing-ticdc-rcu/).

## Notes on this implementation

- The Kafka consumer uses `@confluentinc/kafka-javascript`'s `subscribe()` +
  `run({ eachMessage })` API and buffers messages, draining them once per
  tick, because this client has no `consumeBatch` method.
- Ports used: Postgres `5432`, Kafka Connect REST `8083`, plus the shared
  TiDB (`4000`), PD (`2379`), TiCDC (`8300`), and Kafka (`9092`) ports from
  the platform's shared infrastructure. No port outside the platform's
  documented set is used.
