# Plan 02: Kafka + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a fintech risk pipeline where payment events stream through Kafka into TiDB, risk state lives in TiDB, and TiCDC streams every committed change back out to Kafka for downstream consumers, with live throughput, lag, and correctness metrics.

**Architecture:** A synthetic producer writes payment events to a Kafka topic (`payments`). An ingester consumes that topic and performs batched idempotent upserts into TiDB. A TiCDC changefeed watches the target table and re-emits every change, in canal-json format, to a second Kafka topic (`tidb-changes`). A risk-alert consumer reads that topic to show the round trip. One runner process owns all four roles (producer, ingester, TiCDC lifecycle calls, downstream consumer) and emits manifest events for each.

**Tech Stack:** Node 22, TypeScript strict, `@confluentinc/kafka-javascript` for the Kafka client (rationale in section 4), mysql2 via `@lab/runner-kit`, native `fetch` against the TiCDC OpenAPI v2 for changefeed lifecycle and checkpoint lag.

**Depends on:** Plan 00 (platform: contract, runner-kit, relay, shared `infra/kafka/docker-compose.yml` and `infra/tidb/playground.sh`).

---

## 1. Why this demo

- **The question customers ask:** "We already use Kafka for our event bus. Can TiDB sit in that pipeline without us losing the ability to react to changes downstream, and can it keep up with bursts?"
- **Pattern:** fintech risk pipeline: payment events stream through Kafka into TiDB, risk state lives in TiDB, and TiCDC streams every change back out to Kafka for downstream consumers.
- **What TiDB proves here:**
  - TiDB can be both a fast idempotent write target for a Kafka consumer and a CDC source, at the same time, without a separate ETL hop.
  - TiCDC keeps up under a burst and catches up cleanly after the changefeed is paused and resumed, with a measured checkpoint lag.
  - An ingester crash and restart causes zero row loss and no duplicate rows in TiDB, because the upsert is idempotent on the payment's primary key.
  - The at-least-once delivery of the Kafka sink is real and measurable (duplicates appear downstream) and is solved the same way any Kafka consumer solves it: dedupe on a stable key.
- **What this demo does not claim:** TiCDC does not provide exactly-once delivery to Kafka; this demo shows and measures that, it does not hide it. This is not a benchmark of maximum throughput; the load profile is sized to be visible in a 3-6 minute recording, not to be a capacity test.

## 2. What the audience sees

### Flow diagram

```
[producer] --msgs/s--> [(payments)] --msgs/s--> [ingester] --rows/s--> [ (tidb) ]
                                                                            |
                                                                      rows/s (CDC)
                                                                            v
[risk-consumer] <--msgs/s-- [(tidb-changes)] <--msgs/s-- [ticdc]
```

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | warm-up | Warming up | Kafka, TiDB, and the changefeed come up; the producer starts at baseline rate. | "We're standing up a normal Kafka-to-TiDB pipeline: nothing custom, just a consumer doing upserts." |
| 2 | steady-state | Steady state | Producer, ingester, TiCDC, and the risk consumer all running at baseline rate; checks start passing. | "At steady state every payment event becomes a row in TiDB, and TiCDC re-publishes that row change within milliseconds." |
| 3 | burst | 10x burst | The `burst` control raises producer rate 10x for a fixed window. | "Now we 10x the load. Watch ingest rate and TiCDC checkpoint lag - TiDB absorbs it, TiCDC catches up." |
| 4 | ingester-restart | Ingester restart | The `restart-ingester` control drops and reconnects the ingester's consumer group mid-stream. | "We kill the ingester consumer. Kafka holds its committed offset, so when it reconnects it resumes exactly where it left off - no loss, no duplicate rows in TiDB." |
| 5 | changefeed-pause-resume | Pause and resume the changefeed | The `pause-changefeed` and `resume-changefeed` controls call the TiCDC OpenAPI v2 pause/resume endpoints. | "We pause the changefeed itself. TiDB keeps taking writes. When we resume, TiCDC catches up from its checkpoint - and this is exactly where Kafka's at-least-once delivery shows up as visible duplicates downstream." |
| 6 | wrap-up | Wrap-up | Load tapers off, all checks are shown passing (except the expected duplicate count, which is shown and explained, not hidden). | "Produced count equals rows in TiDB equals distinct CDC events. Duplicates happened, and we caught every one of them." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `burst` | Burst 10x for 30s | Producer rate is multiplied by 10 for 30 seconds, then returns to baseline. |
| `restart-ingester` | Kill ingester | The runner tears down and recreates the ingester's Kafka consumer (same group id), simulating a crash and restart without losing committed offsets. |
| `pause-changefeed` | Pause changefeed | `POST /api/v2/changefeeds/{id}/pause` against the local TiCDC OpenAPI v2. |
| `resume-changefeed` | Resume changefeed | `POST /api/v2/changefeeds/{id}/resume` against the local TiCDC OpenAPI v2. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `produced-equals-tidb-rows` | Produced count equals TiDB row count | `pass` when the producer's cumulative event count equals `SELECT COUNT(*) FROM payments`, sampled once the producer is idle at the end of a phase window. |
| `tidb-rows-equals-cdc-distinct` | TiDB rows equal distinct CDC events | `pass` when the count of distinct `(payment_id, commit_ts)` pairs seen on `tidb-changes` equals the TiDB row count. |
| `zero-duplicate-rows-in-tidb` | Zero duplicate rows in TiDB | `pass` when `SELECT COUNT(*) FROM payments GROUP BY payment_id HAVING COUNT(*) > 1` returns no rows, proving the upsert stayed idempotent through the restart. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `produce-rate` | Produce rate | msgs/s | both | higher | Count of messages the producer's Kafka client reports as acked in the last tick, divided by tick seconds. |
| `ingest-rate` | Ingest rate | rows/s | both | higher | Count of rows the ingester's batched upsert affected (`OkPacket.affectedRows` from mysql2) in the last tick, divided by tick seconds. |
| `consumer-lag-payments` | Ingester consumer lag | count | tile | lower | `admin.fetchTopicOffsets('payments')` (high-water mark) minus the ingester consumer group's committed offset, summed across partitions, via the Kafka admin client. |
| `consumer-lag-changes` | Risk consumer lag | count | tile | lower | Same computation as above for the risk consumer's group id on `tidb-changes`. |
| `tidb-write-p99` | TiDB upsert p99 | ms | both | lower | `summarize()` (from `@lab/runner-kit`) over per-batch upsert wall-clock times measured with `timed()`, emitted once per tick. |
| `ticdc-checkpoint-lag` | TiCDC checkpoint lag | ms | both | lower | `GET /api/v2/changefeeds/{id}` on the local TiCDC OpenAPI v2; lag is `now - Date.parse(checkpoint_time)` where `checkpoint_time` is the field TiCDC returns (vendor-reported, not modeled). |
| `e2e-latency-p50` | End-to-end latency p50 | ms | series | lower | `summarize()` over `(cdc event consumed at) - (produce_ts embedded in the payment's JSON payload)` for each row observed on `tidb-changes`, p50 of the window. |
| `e2e-latency-p99` | End-to-end latency p99 | ms | series | lower | Same sample set as above, p99. |
| `duplicates-observed` | Duplicate CDC events observed | count | tile | lower | Cumulative count of `(payment_id, commit_ts)` pairs seen more than once on `tidb-changes`, tracked by the risk consumer's dedupe set. |

`group` conventions used in the manifest: `throughput` for produce-rate/ingest-rate, `lag` for both consumer-lag metrics and ticdc-checkpoint-lag, `latency` for tidb-write-p99 and both e2e-latency metrics, `correctness` for duplicates-observed.

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| TiCDC's Kafka sink supports exactly these protocols: `canal-json`, `open-protocol`, `avro`, `debezium`, `simple`. | [Replicate Data to Kafka](https://docs.pingcap.com/tidb/stable/ticdc-sink-to-kafka/) | Verified |
| PingCAP's own guidance: "In most cases, it is recommended to use the canal-json protocol." This demo follows that recommendation for the primary changefeed. | [Replicate Data to Kafka](https://docs.pingcap.com/tidb/stable/ticdc-sink-to-kafka/) | Verified |
| Sink URI format is `kafka://host:port/topic-name?protocol=...&kafka-version=...&partition-num=...&max-message-bytes=...&replication-factor=...`; `enable-tidb-extension=true` adds TiDB extension fields (including `commitTs`) to canal-json/avro messages and enables WATERMARK events. | [Replicate Data to Kafka](https://docs.pingcap.com/tidb/stable/ticdc-sink-to-kafka/) | Verified |
| Minimum Kafka broker version for TiCDC >= v8.1.0 is Kafka 2.1.0. | [Replicate Data to Kafka](https://docs.pingcap.com/tidb/stable/ticdc-sink-to-kafka/) | Verified |
| Kafka ACLs TiCDC needs: Topic `Create`, `Write`, `Describe`; Cluster `DescribeConfig`. Describe/Create can be dropped if the topic already exists. | [Replicate Data to Kafka](https://docs.pingcap.com/tidb/stable/ticdc-sink-to-kafka/) | Verified |
| TiCDC OpenAPI v2: `GET /api/v2/changefeeds/{changefeed_id}` returns `checkpoint_ts` (TSO) and `checkpoint_time` (formatted string) among other fields. `GET /api/v2/changefeeds/{changefeed_id}/synced` returns `synced`, `sink_checkpoint_ts`, `puller_resolved_ts`, `last_synced_ts`, `now_ts`, `info`. Pause is `POST /api/v2/changefeeds/{changefeed_id}/pause`, resume is `POST /api/v2/changefeeds/{changefeed_id}/resume` with body `{"overwrite_checkpoint_ts": 0}`. | [TiCDC OpenAPI v2](https://docs.pingcap.com/tidb/stable/ticdc-open-api-v2/) | Verified |
| TiCDC guarantees at-least-once delivery. The Kafka sink can send duplicated messages, for example after a changefeed is paused and resumed (`msg1, msg2, msg3, msg2, msg3`), and PingCAP's own guidance is that consumers must filter duplicates. | [TiCDC FAQs](https://docs.pingcap.com/tidb/stable/ticdc-faq/) | Verified |
| TiDB Cloud Dedicated supports changefeeds to Apache Kafka (requires cluster v6.1.3+); TiDB Cloud Starter does not support changefeeds at all; TiDB Cloud Essential's changefeed feature is "only available upon request", not self-serve GA. Debezium output format on TiDB Cloud additionally requires v8.1.0+. | [Changefeed Overview (TiDB Cloud)](https://docs.pingcap.com/tidbcloud/changefeed-overview/), [Sink to Apache Kafka (TiDB Cloud)](https://docs.pingcap.com/tidbcloud/changefeed-sink-to-apache-kafka/) | Verified |
| TiDB Cloud Dedicated changefeeds are billed in TiCDC Replication Capacity Units (RCUs); no fixed price is quoted here, see the billing page. | [Changefeed Billing for TiDB Cloud Dedicated](https://docs.pingcap.com/tidbcloud/tidb-cloud-billing-ticdc-rcu/) | Verified (formula/mechanism only, no price copied) |
| TiDB Cloud Premium tier's changefeed-to-Kafka support level is not stated on the pages fetched for this plan (Premium was in public preview at the time of writing). | n/a | **UNVERIFIED** - before recording a TiDB Cloud Premium variant, check the current [Changefeed Overview (TiDB Cloud)](https://docs.pingcap.com/tidbcloud/changefeed-overview/) page for Premium-tier changefeed support. |
| KafkaJS has not published a release in an extended period and is widely reported as unmaintained; `@confluentinc/kafka-javascript` is Confluent's actively released, librdkafka-based client with a KafkaJS-compatible API. | [KafkaJS seems not maintained anymore (nestjs/nest#13223)](https://github.com/nestjs/nest/issues/13223), [Confluent's JavaScript Client for Apache Kafka (CJSK) Is Now Generally Available](https://www.confluent.io/blog/introducing-confluent-kafka-javascript/) | Verified as "widely reported"; **UNVERIFIED** exact last-KafkaJS-release date - confirm on the [kafkajs npm page](https://www.npmjs.com/package/kafkajs) before writing the `.env.example` / package.json comment that cites it. |
| Kafka client choice for this demo: `@confluentinc/kafka-javascript`, because it has an active release cadence and vendor support, and its API is close enough to KafkaJS's that runner code reads like idiomatic Node Kafka code (rationale, not a vendor claim). | [@confluentinc/kafka-javascript on npm](https://www.npmjs.com/package/@confluentinc/kafka-javascript) | Verified (package exists and is actively published); exact current version **UNVERIFIED** - run `npm view @confluentinc/kafka-javascript version` before pinning it in `package.json`. |

## 5. Prerequisites, cost, and teardown

- Accounts and access: none required for the local variant. The TiDB Cloud variant (section 8's sibling note) needs a TiDB Cloud Dedicated cluster (v6.1.3+) and a reachable Kafka cluster (self-hosted, reachable by Private Connect, VPC Peering, or a public IP - TiDB Cloud does not support Private Connect directly into MSK/Confluent Cloud without a `kafka-proxy` intermediary; see [Sink to Apache Kafka](https://docs.pingcap.com/tidbcloud/changefeed-sink-to-apache-kafka/)).
- Local tools: Docker Desktop, tiup, Node 22, pnpm.
- Cost model: local variant costs nothing beyond compute. TiDB Cloud Dedicated variant bills cluster node time (see the cluster's own pricing page) plus changefeed RCUs (see [Changefeed Billing for TiDB Cloud Dedicated](https://docs.pingcap.com/tidbcloud/tidb-cloud-billing-ticdc-rcu/) for the formula); no price is hardcoded here.
- Teardown:
  - `docker compose -f infra/kafka/docker-compose.yml down -v` (removes the `lab-kafka` container and its volume).
  - `cdc cli changefeed remove --changefeed-id=kafka-fintech-risk --server=http://127.0.0.1:8300` (or `DELETE /api/v2/changefeeds/kafka-fintech-risk`) before tearing down TiDB, so no orphaned changefeed is left registered.
  - `tiup clean lab` (removes the local playground's data directory).
  - For the TiDB Cloud variant: delete the changefeed from the Changefeed page (or `DELETE /api/v2/changefeeds/{id}` if using the Cloud API) and confirm it no longer appears in the console before deleting or pausing the cluster itself.

## 6. File structure

```
demos/kafka/
  manifest.json                 DemoManifestSchema instance: nodes, edges, metrics, phases, checks, controls for this demo
  package.json                  "@lab/demo-kafka", depends on @lab/contract + @lab/runner-kit (workspace:*) + @confluentinc/kafka-javascript
  tsconfig.json                 extends ../../tsconfig.base.json
  README.md                     what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md                 presenter script per phase, discovery questions, objections and answers
  .env.example                  standard TIDB_*/LAB_ENV_* block plus KAFKA_BROKERS, CHANGEFEED_ID, TICDC_API
  infra/
    docker-compose.yml          extends the shared lab network so this demo can run standalone against infra/kafka/docker-compose.yml
  runner/
    main.ts                     entry point: wires producer, ingester, TiCDC lifecycle, risk consumer, phases, controls
    src/
      paymentEvent.ts            pure: createPaymentEvent, encodePaymentEvent, decodePaymentEvent
      dedupe.ts                  pure: createDedupeTracker (Set-based observe())
      latency.ts                 pure: computeE2eLatencyMs
      upsertSql.ts                pure: buildUpsertSql for batched payment upserts
      canalJsonParser.ts          pure: parseCanalJsonMessage
      checkpointLag.ts            pure: computeCheckpointLagMs
      kafkaClient.ts              thin I/O: producer/consumer/admin wrappers over @confluentinc/kafka-javascript
      ticdcApi.ts                 thin I/O: fetch wrappers over the TiCDC OpenAPI v2 (create/pause/resume/get changefeed)
      tidbSchema.ts                thin I/O: CREATE TABLE IF NOT EXISTS payments DDL runner
    test/
      paymentEvent.test.ts
      dedupe.test.ts
      latency.test.ts
      upsertSql.test.ts
      canalJsonParser.test.ts
      checkpointLag.test.ts
  test/
    manifest.test.ts             parses manifest.json with DemoManifestSchema
  traces/
    featured.json                the recording the website plays (committed after capture)
```

## 7. Tasks

### Task 1: Scaffold the demo package and a failing manifest test

- [ ] Create `demos/kafka/package.json`:

```json
{
  "name": "@lab/demo-kafka",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "@confluentinc/kafka-javascript": "^1.0.0",
    "mysql2": "^3.11.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "tsx": "^4.20.0",
    "@types/node": "^22.10.0",
    "vitest": "^3.2.0",
    "typescript": "^5.9.0"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "start": "tsx runner/main.ts"
  }
}
```

- [ ] Create `demos/kafka/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["runner", "test"]
}
```

- [ ] Write the failing test `demos/kafka/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('kafka demo manifest', () => {
  it('parses as a valid DemoManifest', () => {
    const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8');
    const result = DemoManifestSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test` - expected FAIL (`manifest.json` does not exist, `readFileSync` throws `ENOENT`).

- [ ] Create `demos/kafka/manifest.json`:

```json
{
  "id": "kafka",
  "number": 2,
  "title": "Kafka: fintech risk pipeline",
  "tagline": "Payments flow through Kafka into TiDB, and every committed change flows back out through TiCDC.",
  "integrations": ["Apache Kafka", "TiCDC"],
  "pattern": "fintech risk pipeline: payment events stream through Kafka into TiDB, risk state lives in TiDB, and TiCDC streams every change back out to Kafka for downstream consumers",
  "publish": true,
  "runner": { "command": ["node", "--import", "tsx", "runner/main.ts"], "cwd": "." },
  "nodes": [
    { "id": "producer", "label": "Payment producer", "kind": "source", "x": 5, "y": 20 },
    { "id": "payments-topic", "label": "payments topic", "kind": "queue", "x": 25, "y": 20 },
    { "id": "ingester", "label": "Ingester", "kind": "service", "x": 40, "y": 20 },
    { "id": "tidb", "label": "TiDB", "kind": "tidb", "x": 50, "y": 50 },
    { "id": "ticdc", "label": "TiCDC changefeed", "kind": "service", "x": 62, "y": 35 },
    { "id": "changes-topic", "label": "tidb-changes topic", "kind": "queue", "x": 78, "y": 35 },
    { "id": "risk-consumer", "label": "Risk-alert consumer", "kind": "sink", "x": 92, "y": 35 }
  ],
  "edges": [
    { "id": "produce", "from": "producer", "to": "payments-topic", "label": "payments produced", "unit": "msgs/s" },
    { "id": "consume-payments", "from": "payments-topic", "to": "ingester", "label": "payments consumed", "unit": "msgs/s" },
    { "id": "upsert", "from": "ingester", "to": "tidb", "label": "rows upserted", "unit": "rows/s" },
    { "id": "capture", "from": "tidb", "to": "ticdc", "label": "rows captured", "unit": "rows/s" },
    { "id": "publish-change", "from": "ticdc", "to": "changes-topic", "label": "changes published", "unit": "msgs/s" },
    { "id": "consume-changes", "from": "changes-topic", "to": "risk-consumer", "label": "changes consumed", "unit": "msgs/s" }
  ],
  "metrics": [
    { "id": "produce-rate", "label": "Produce rate", "unit": "msgs/s", "display": "both", "better": "higher", "group": "throughput", "howMeasured": "Acked messages per tick from the producer's Kafka client, divided by tick seconds." },
    { "id": "ingest-rate", "label": "Ingest rate", "unit": "rows/s", "display": "both", "better": "higher", "group": "throughput", "howMeasured": "affectedRows from the batched upsert per tick, divided by tick seconds." },
    { "id": "consumer-lag-payments", "label": "Ingester consumer lag", "unit": "count", "display": "tile", "better": "lower", "group": "lag", "howMeasured": "High-water mark minus committed offset for the ingester's consumer group on payments, summed across partitions via the Kafka admin client." },
    { "id": "consumer-lag-changes", "label": "Risk consumer lag", "unit": "count", "display": "tile", "better": "lower", "group": "lag", "howMeasured": "High-water mark minus committed offset for the risk consumer's group on tidb-changes." },
    { "id": "tidb-write-p99", "label": "TiDB upsert p99", "unit": "ms", "display": "both", "better": "lower", "group": "latency", "howMeasured": "summarize() over per-batch upsert wall-clock times measured with timed(), emitted once per tick." },
    { "id": "ticdc-checkpoint-lag", "label": "TiCDC checkpoint lag", "unit": "ms", "display": "both", "better": "lower", "group": "lag", "howMeasured": "now minus Date.parse(checkpoint_time) from GET /api/v2/changefeeds/{id} on the local TiCDC OpenAPI v2." },
    { "id": "e2e-latency-p50", "label": "End-to-end latency p50", "unit": "ms", "display": "series", "better": "lower", "group": "latency", "howMeasured": "p50 of (CDC event consumed at) minus (produce_ts embedded in the payment payload), over the tick's samples." },
    { "id": "e2e-latency-p99", "label": "End-to-end latency p99", "unit": "ms", "display": "series", "better": "lower", "group": "latency", "howMeasured": "p99 of the same sample set as e2e-latency-p50." },
    { "id": "duplicates-observed", "label": "Duplicate CDC events observed", "unit": "count", "display": "tile", "better": "lower", "group": "correctness", "howMeasured": "Cumulative count of (payment_id, commit_ts) pairs seen more than once on tidb-changes, tracked by the risk consumer's dedupe set." }
  ],
  "phases": [
    { "id": "warm-up", "label": "Warming up", "narration": "We're standing up a normal Kafka-to-TiDB pipeline: nothing custom, just a consumer doing upserts." },
    { "id": "steady-state", "label": "Steady state", "narration": "At steady state every payment event becomes a row in TiDB, and TiCDC re-publishes that row change within milliseconds." },
    { "id": "burst", "label": "10x burst", "narration": "Now we 10x the load. Watch ingest rate and TiCDC checkpoint lag - TiDB absorbs it, TiCDC catches up." },
    { "id": "ingester-restart", "label": "Ingester restart", "narration": "We kill the ingester consumer. Kafka holds its committed offset, so when it reconnects it resumes exactly where it left off - no loss, no duplicate rows in TiDB." },
    { "id": "changefeed-pause-resume", "label": "Pause and resume the changefeed", "narration": "We pause the changefeed itself. TiDB keeps taking writes. When we resume, TiCDC catches up from its checkpoint - and this is exactly where Kafka's at-least-once delivery shows up as visible duplicates downstream." },
    { "id": "wrap-up", "label": "Wrap-up", "narration": "Produced count equals rows in TiDB equals distinct CDC events. Duplicates happened, and we caught every one of them." }
  ],
  "checks": [
    { "id": "produced-equals-tidb-rows", "label": "Produced count equals TiDB row count", "description": "Producer's cumulative event count equals SELECT COUNT(*) FROM payments once the producer is idle." },
    { "id": "tidb-rows-equals-cdc-distinct", "label": "TiDB rows equal distinct CDC events", "description": "Count of distinct (payment_id, commit_ts) pairs seen on tidb-changes equals the TiDB row count." },
    { "id": "zero-duplicate-rows-in-tidb", "label": "Zero duplicate rows in TiDB", "description": "SELECT payment_id, COUNT(*) FROM payments GROUP BY payment_id HAVING COUNT(*) > 1 returns no rows." }
  ],
  "controls": [
    { "id": "burst", "label": "Burst 10x for 30s", "description": "Multiplies producer rate by 10 for 30 seconds, then returns to baseline." },
    { "id": "restart-ingester", "label": "Kill ingester", "description": "Tears down and recreates the ingester's Kafka consumer under the same group id." },
    { "id": "pause-changefeed", "label": "Pause changefeed", "description": "Calls POST /api/v2/changefeeds/{id}/pause." },
    { "id": "resume-changefeed", "label": "Resume changefeed", "description": "Calls POST /api/v2/changefeeds/{id}/resume." }
  ]
}
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test` - expected PASS.
- [ ] Commit: `git add demos/kafka/package.json demos/kafka/tsconfig.json demos/kafka/manifest.json demos/kafka/test/manifest.test.ts && git commit -m "kafka demo: scaffold package and manifest"`

### Task 2: Payment event creation and encoding (pure)

- [ ] Write failing test `demos/kafka/runner/test/paymentEvent.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPaymentEvent, encodePaymentEvent, decodePaymentEvent } from '../src/paymentEvent';

describe('paymentEvent', () => {
  it('creates a payment event with a produceTs and a positive amount', () => {
    const event = createPaymentEvent({ sequence: 1, now: () => 1000 });
    expect(event.paymentId).toBe('payment-000001');
    expect(event.produceTs).toBe(1000);
    expect(event.amountCents).toBeGreaterThan(0);
  });

  it('round-trips through JSON encode/decode', () => {
    const event = createPaymentEvent({ sequence: 42, now: () => 5000 });
    const decoded = decodePaymentEvent(encodePaymentEvent(event));
    expect(decoded).toEqual(event);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test paymentEvent` - expected FAIL (`../src/paymentEvent` does not exist).

- [ ] Create `demos/kafka/runner/src/paymentEvent.ts`:

```ts
import { z } from 'zod';
export type PaymentEvent = {
  readonly paymentId: string;
  readonly accountId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly produceTs: number;
};

export type CreatePaymentEventOptions = {
  readonly sequence: number;
  readonly now: () => number;
};

const padSequence = (sequence: number): string => String(sequence).padStart(6, '0');

const pseudoRandomAmountCents = (sequence: number): number => {
  const base = ((sequence * 7919) % 250000) + 100;
  return base;
};

const pseudoRandomAccountId = (sequence: number): string => `acct-${(sequence * 31) % 500}`;

export const createPaymentEvent = (options: CreatePaymentEventOptions): PaymentEvent => ({
  paymentId: `payment-${padSequence(options.sequence)}`,
  accountId: pseudoRandomAccountId(options.sequence),
  amountCents: pseudoRandomAmountCents(options.sequence),
  currency: 'USD',
  produceTs: options.now(),
});

export const encodePaymentEvent = (event: PaymentEvent): string => JSON.stringify(event);

const PaymentEventSchema = z.object({
  paymentId: z.string(),
  accountId: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  produceTs: z.number(),
});

export const decodePaymentEvent = (raw: string): PaymentEvent => PaymentEventSchema.parse(JSON.parse(raw));
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test paymentEvent` - expected PASS.
- [ ] Commit: `git add demos/kafka/runner/src/paymentEvent.ts demos/kafka/runner/test/paymentEvent.test.ts && git commit -m "kafka demo: pure payment event creation and codec"`

### Task 3: Dedupe tracker (pure)

- [ ] Write failing test `demos/kafka/runner/test/dedupe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDedupeTracker } from '../src/dedupe';

describe('dedupe tracker', () => {
  it('reports the first observation of a key as not a duplicate', () => {
    const tracker = createDedupeTracker();
    expect(tracker.observe('payment-000001:100')).toEqual({ isDuplicate: false, duplicateCount: 0 });
  });

  it('reports a repeated key as a duplicate and counts it', () => {
    const tracker = createDedupeTracker();
    tracker.observe('payment-000001:100');
    expect(tracker.observe('payment-000001:100')).toEqual({ isDuplicate: true, duplicateCount: 1 });
    expect(tracker.observe('payment-000001:100')).toEqual({ isDuplicate: true, duplicateCount: 2 });
  });

  it('treats different keys independently', () => {
    const tracker = createDedupeTracker();
    tracker.observe('payment-000001:100');
    expect(tracker.observe('payment-000002:100')).toEqual({ isDuplicate: false, duplicateCount: 0 });
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test dedupe` - expected FAIL.

- [ ] Create `demos/kafka/runner/src/dedupe.ts`:

```ts
export type DedupeObservation = {
  readonly isDuplicate: boolean;
  readonly duplicateCount: number;
};

export type DedupeTracker = {
  readonly observe: (key: string) => DedupeObservation;
};

export const createDedupeTracker = (): DedupeTracker => {
  const seen = new Map<string, number>();
  const observe = (key: string): DedupeObservation => {
    const priorCount = seen.get(key) ?? 0;
    seen.set(key, priorCount + 1);
    return priorCount === 0 ? { isDuplicate: false, duplicateCount: 0 } : { isDuplicate: true, duplicateCount: priorCount };
  };
  return { observe };
};
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test dedupe` - expected PASS.
- [ ] Commit: `git add demos/kafka/runner/src/dedupe.ts demos/kafka/runner/test/dedupe.test.ts && git commit -m "kafka demo: pure dedupe tracker"`

### Task 4: End-to-end latency computation (pure)

- [ ] Write failing test `demos/kafka/runner/test/latency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeE2eLatencyMs } from '../src/latency';

describe('computeE2eLatencyMs', () => {
  it('returns the difference between consume time and produce time', () => {
    expect(computeE2eLatencyMs({ produceTs: 1000, consumeTs: 1250 })).toBe(250);
  });

  it('floors negative results at zero for clock-skew safety', () => {
    expect(computeE2eLatencyMs({ produceTs: 1000, consumeTs: 900 })).toBe(0);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test latency` - expected FAIL.

- [ ] Create `demos/kafka/runner/src/latency.ts`:

```ts
export type LatencyInput = {
  readonly produceTs: number;
  readonly consumeTs: number;
};

export const computeE2eLatencyMs = (input: LatencyInput): number =>
  Math.max(0, input.consumeTs - input.produceTs);
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test latency` - expected PASS.
- [ ] Commit: `git add demos/kafka/runner/src/latency.ts demos/kafka/runner/test/latency.test.ts && git commit -m "kafka demo: pure e2e latency computation"`

### Task 5: Batched upsert SQL builder (pure)

- [ ] Write failing test `demos/kafka/runner/test/upsertSql.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildUpsertSql } from '../src/upsertSql';
import type { PaymentEvent } from '../src/paymentEvent';

describe('buildUpsertSql', () => {
  it('builds one INSERT ... ON DUPLICATE KEY UPDATE statement for a batch', () => {
    const events: readonly PaymentEvent[] = [
      { paymentId: 'payment-000001', accountId: 'acct-1', amountCents: 500, currency: 'USD', produceTs: 1000 },
      { paymentId: 'payment-000002', accountId: 'acct-2', amountCents: 700, currency: 'USD', produceTs: 1001 },
    ];
    const built = buildUpsertSql(events);
    expect(built.sql).toBe(
      'INSERT INTO payments (payment_id, account_id, amount_cents, currency, produce_ts) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE account_id = VALUES(account_id), amount_cents = VALUES(amount_cents), currency = VALUES(currency), produce_ts = VALUES(produce_ts)',
    );
    expect(built.params).toEqual([
      'payment-000001', 'acct-1', 500, 'USD', 1000,
      'payment-000002', 'acct-2', 700, 'USD', 1001,
    ]);
  });

  it('returns an empty statement for an empty batch', () => {
    const built = buildUpsertSql([]);
    expect(built.sql).toBe('');
    expect(built.params).toEqual([]);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test upsertSql` - expected FAIL.

- [ ] Create `demos/kafka/runner/src/upsertSql.ts`:

```ts
import type { PaymentEvent } from './paymentEvent';

export type BuiltSql = {
  readonly sql: string;
  readonly params: readonly (string | number)[];
};

const columns = ['payment_id', 'account_id', 'amount_cents', 'currency', 'produce_ts'] as const;

const eventToParams = (event: PaymentEvent): readonly (string | number)[] => [
  event.paymentId,
  event.accountId,
  event.amountCents,
  event.currency,
  event.produceTs,
];

export const buildUpsertSql = (events: readonly PaymentEvent[]): BuiltSql => {
  if (events.length === 0) return { sql: '', params: [] };
  const valuePlaceholders = events.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
  const updateClause = columns
    .filter((column) => column !== 'payment_id')
    .map((column) => `${column} = VALUES(${column})`)
    .join(', ');
  const sql =
    `INSERT INTO payments (${columns.join(', ')}) VALUES ${valuePlaceholders} ` +
    `ON DUPLICATE KEY UPDATE ${updateClause}`;
  const params = events.flatMap(eventToParams);
  return { sql, params };
};
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test upsertSql` - expected PASS.
- [ ] Commit: `git add demos/kafka/runner/src/upsertSql.ts demos/kafka/runner/test/upsertSql.test.ts && git commit -m "kafka demo: pure batched upsert SQL builder"`

### Task 6: Canal-JSON message parser (pure)

- [ ] Write failing test `demos/kafka/runner/test/canalJsonParser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseCanalJsonMessage } from '../src/canalJsonParser';

const sampleInsert = JSON.stringify({
  database: 'lab',
  table: 'payments',
  type: 'INSERT',
  isDdl: false,
  data: [{ payment_id: 'payment-000001', account_id: 'acct-1', amount_cents: '500', currency: 'USD', produce_ts: '1000' }],
  old: null,
  _tidb: { commitTs: 439749918821711874 },
});

describe('parseCanalJsonMessage', () => {
  it('extracts table, type, row data, and commitTs from a canal-json row event', () => {
    const parsed = parseCanalJsonMessage(sampleInsert);
    expect(parsed).toEqual({
      ok: true,
      table: 'payments',
      type: 'INSERT',
      commitTs: 439749918821711874n,
      row: { payment_id: 'payment-000001', account_id: 'acct-1', amount_cents: '500', currency: 'USD', produce_ts: '1000' },
    });
  });

  it('reports DDL events as not row events without throwing', () => {
    const ddl = JSON.stringify({ database: 'lab', table: '', type: 'QUERY', isDdl: true, data: null, old: null });
    expect(parseCanalJsonMessage(ddl)).toEqual({ ok: false, reason: 'not a row event' });
  });

  it('reports malformed JSON without throwing', () => {
    expect(parseCanalJsonMessage('not json')).toEqual({ ok: false, reason: 'invalid JSON' });
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test canalJsonParser` - expected FAIL.

- [ ] Create `demos/kafka/runner/src/canalJsonParser.ts`:

```ts
import { z } from 'zod';
export type ParsedRowEvent = {
  readonly ok: true;
  readonly table: string;
  readonly type: string;
  readonly commitTs: bigint;
  readonly row: Readonly<Record<string, string>>;
};

export type ParseFailure = {
  readonly ok: false;
  readonly reason: 'invalid JSON' | 'not a row event';
};

export type ParseResult = ParsedRowEvent | ParseFailure;

const CanalJsonMessageSchema = z.object({
  table: z.string().optional(),
  type: z.string().optional(),
  isDdl: z.boolean().optional(),
  data: z.array(z.record(z.string(), z.string())).nullable().optional(),
  _tidb: z.object({ commitTs: z.number().optional() }).optional(),
});

const parseJson = (raw: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

export const parseCanalJsonMessage = (raw: string): ParseResult => {
  const json = parseJson(raw);
  if (!json.ok) return { ok: false, reason: 'invalid JSON' };
  const parsed = CanalJsonMessageSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, reason: 'not a row event' };
  const message = parsed.data;
  if (message.isDdl === true || !message.data || message.data.length === 0 || !message._tidb?.commitTs) {
    return { ok: false, reason: 'not a row event' };
  }
  return {
    ok: true,
    table: message.table ?? '',
    type: message.type ?? '',
    commitTs: BigInt(message._tidb.commitTs),
    row: message.data[0],
  };
};
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test canalJsonParser` - expected PASS.
- [ ] Commit: `git add demos/kafka/runner/src/canalJsonParser.ts demos/kafka/runner/test/canalJsonParser.test.ts && git commit -m "kafka demo: pure canal-json row event parser"`

### Task 7: Checkpoint lag computation (pure)

- [ ] Write failing test `demos/kafka/runner/test/checkpointLag.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeCheckpointLagMs } from '../src/checkpointLag';

describe('computeCheckpointLagMs', () => {
  it('returns the gap between now and the checkpoint time', () => {
    const nowMs = Date.parse('2026-01-01T00:00:05.000Z');
    const checkpointTime = '2026-01-01 00:00:03.500';
    expect(computeCheckpointLagMs({ nowMs, checkpointTime })).toBe(1500);
  });

  it('floors negative results at zero for clock-skew safety', () => {
    const nowMs = Date.parse('2026-01-01T00:00:03.000Z');
    const checkpointTime = '2026-01-01 00:00:05.000';
    expect(computeCheckpointLagMs({ nowMs, checkpointTime })).toBe(0);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test checkpointLag` - expected FAIL.

- [ ] Create `demos/kafka/runner/src/checkpointLag.ts`:

```ts
export type CheckpointLagInput = {
  readonly nowMs: number;
  readonly checkpointTime: string;
};

export const computeCheckpointLagMs = (input: CheckpointLagInput): number => {
  const checkpointMs = Date.parse(input.checkpointTime.replace(' ', 'T') + 'Z');
  return Math.max(0, input.nowMs - checkpointMs);
};
```

- [ ] Run: `pnpm --filter @lab/demo-kafka test checkpointLag` - expected PASS.
- [ ] Commit: `git add demos/kafka/runner/src/checkpointLag.ts demos/kafka/runner/test/checkpointLag.test.ts && git commit -m "kafka demo: pure TiCDC checkpoint lag computation"`

### Task 8: Bring up shared infra and confirm connectivity (manual, I/O)

- [ ] Start the shared Kafka broker: `docker compose -f infra/kafka/docker-compose.yml up -d` - expected output includes `lab-kafka` reported `healthy` within ~20s (`docker compose -f infra/kafka/docker-compose.yml ps`).
- [ ] Start the local TiDB playground: `infra/tidb/playground.sh` - expected output prints the TiDB, PD, and TiCDC listening addresses and the TiDB version; record the version string for `LAB_ENV_TIDB` later.
- [ ] Create the working database and table: `mysql -h 127.0.0.1 -P 4000 -u root -e "CREATE DATABASE IF NOT EXISTS lab; USE lab; CREATE TABLE IF NOT EXISTS payments (payment_id VARCHAR(32) PRIMARY KEY, account_id VARCHAR(32) NOT NULL, amount_cents BIGINT NOT NULL, currency VARCHAR(8) NOT NULL, produce_ts BIGINT NOT NULL);"` - expected: no error, `mysql> SHOW TABLES;` lists `payments`.
- [ ] Confirm TiCDC OpenAPI v2 is reachable: `curl -s http://127.0.0.1:8300/api/v2/status` - expected JSON response with `"is_owner"` and no connection error.

### Task 9: Create the changefeed (manual, I/O)

- [ ] Create the changefeed with canal-json output and TiDB extension fields enabled:

```bash
cdc cli changefeed create \
  --server=http://127.0.0.1:8300 \
  --sink-uri="kafka://127.0.0.1:9092/tidb-changes?protocol=canal-json&kafka-version=3.0.0&partition-num=3&max-message-bytes=10485760&replication-factor=1&enable-tidb-extension=true" \
  --changefeed-id="kafka-fintech-risk"
```

Expected output: `Create changefeed successfully!` followed by an `ID: kafka-fintech-risk` line and a JSON `Info` block with `"state":"normal"`.

- [ ] Confirm changefeed status and checkpoint fields: `curl -s http://127.0.0.1:8300/api/v2/changefeeds/kafka-fintech-risk` - expected JSON includes `"state":"normal"`, a non-zero `checkpoint_ts`, and a `checkpoint_time` string.

### Task 10: Thin I/O adapters - Kafka client, TiCDC API client, schema runner

- [ ] Create `demos/kafka/runner/src/kafkaClient.ts`:

```ts
import { Kafka, type Producer, type Consumer } from '@confluentinc/kafka-javascript';

export type KafkaClients = {
  readonly producer: Producer;
  readonly createConsumer: (groupId: string) => Consumer;
  readonly fetchGroupLag: (options: { readonly groupId: string; readonly topic: string }) => Promise<number>;
};

export const createKafkaClients = (options: { readonly brokers: readonly string[] }): KafkaClients => {
  const kafka = new Kafka({ 'bootstrap.servers': options.brokers.join(',') });
  const producer = kafka.producer();
  const admin = kafka.admin();
  const createConsumer = (groupId: string): Consumer => kafka.consumer({ 'group.id': groupId });
  const fetchGroupLag = async (lagOptions: { readonly groupId: string; readonly topic: string }): Promise<number> => {
    const watermarks = await admin.fetchTopicOffsets(lagOptions.topic);
    const committed = await admin.fetchOffsets({ groupId: lagOptions.groupId, topics: [lagOptions.topic] });
    const highTotal = watermarks.reduce((sum, partition) => sum + Number(partition.high), 0);
    const committedTotal = committed
      .flatMap((topic) => topic.partitions)
      .reduce((sum, partition) => sum + Math.max(0, Number(partition.offset)), 0);
    return Math.max(0, highTotal - committedTotal);
  };
  return { producer, createConsumer, fetchGroupLag };
};
```

Manual verification: `pnpm --filter @lab/demo-kafka exec tsx -e "import('./runner/src/kafkaClient').then(async m => { const c = m.createKafkaClients({brokers:['127.0.0.1:9092']}); await c.producer.connect(); console.log('connected'); await c.producer.disconnect(); })"` - expected output `connected` with no thrown error.

- [ ] Create `demos/kafka/runner/src/ticdcApi.ts`:

```ts
export type ChangefeedStatus = {
  readonly state: string;
  readonly checkpointTime: string;
};

export type TicdcApi = {
  readonly getChangefeed: (id: string) => Promise<ChangefeedStatus>;
  readonly pause: (id: string) => Promise<void>;
  readonly resume: (id: string) => Promise<void>;
};

export const createTicdcApi = (options: { readonly baseUrl: string }): TicdcApi => {
  const getChangefeed = async (id: string): Promise<ChangefeedStatus> => {
    const response = await fetch(`${options.baseUrl}/api/v2/changefeeds/${id}`);
    const body = (await response.json()) as { readonly state: string; readonly checkpoint_time: string };
    return { state: body.state, checkpointTime: body.checkpoint_time };
  };
  const pause = async (id: string): Promise<void> => {
    await fetch(`${options.baseUrl}/api/v2/changefeeds/${id}/pause`, { method: 'POST' });
  };
  const resume = async (id: string): Promise<void> => {
    await fetch(`${options.baseUrl}/api/v2/changefeeds/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overwrite_checkpoint_ts: 0 }),
    });
  };
  return { getChangefeed, pause, resume };
};
```

Manual verification: `pnpm --filter @lab/demo-kafka exec tsx -e "import('./runner/src/ticdcApi').then(async m => { const api = m.createTicdcApi({baseUrl:'http://127.0.0.1:8300'}); console.log(await api.getChangefeed('kafka-fintech-risk')); })"` - expected output an object with `state: 'normal'` and a `checkpointTime` string.

- [ ] Commit: `git add demos/kafka/runner/src/kafkaClient.ts demos/kafka/runner/src/ticdcApi.ts && git commit -m "kafka demo: thin I/O adapters for Kafka and TiCDC OpenAPI v2"`

### Task 11: Wire the runner's main.ts

- [ ] Create `demos/kafka/runner/main.ts`:

```ts
import { createEmitter, every, onControl, createTidbPool } from '@lab/runner-kit';
import { createKafkaClients } from './src/kafkaClient';
import { createTicdcApi } from './src/ticdcApi';
import { createPaymentEvent, encodePaymentEvent, decodePaymentEvent } from './src/paymentEvent';
import { buildUpsertSql } from './src/upsertSql';
import { parseCanalJsonMessage } from './src/canalJsonParser';
import { computeE2eLatencyMs } from './src/latency';
import { computeCheckpointLagMs } from './src/checkpointLag';
import { createDedupeTracker } from './src/dedupe';

const emitter = createEmitter();
const pool = createTidbPool();
const kafka = createKafkaClients({ brokers: [process.env.KAFKA_BROKERS ?? '127.0.0.1:9092'] });
const ticdc = createTicdcApi({ baseUrl: process.env.TICDC_API ?? 'http://127.0.0.1:8300' });
const changefeedId = process.env.CHANGEFEED_ID ?? 'kafka-fintech-risk';
const dedupe = createDedupeTracker();

const controller = new AbortController();
let producerRateMultiplier = 1;
let sequence = 0;

onControl((id) => {
  if (id === 'burst') {
    producerRateMultiplier = 10;
    setTimeout(() => {
      producerRateMultiplier = 1;
    }, 30_000);
  }
  if (id === 'pause-changefeed') void ticdc.pause(changefeedId);
  if (id === 'resume-changefeed') void ticdc.resume(changefeedId);
  if (id === 'restart-ingester') emitter.node('ingester', 'starting', 'restarting consumer group');
});

const runProducerTick = async (): Promise<void> => {
  const eventsThisTick = 5 * producerRateMultiplier;
  for (let i = 0; i < eventsThisTick; i += 1) {
    sequence += 1;
    const event = createPaymentEvent({ sequence, now: () => emitter.elapsedMs() });
    await kafka.producer.send({ topic: 'payments', messages: [{ value: encodePaymentEvent(event) }] });
  }
  emitter.metric('produce-rate', eventsThisTick);
};

const runIngesterTick = async (): Promise<void> => {
  const batch = await kafka.createConsumer('kafka-demo-ingester').consumeBatch({ topic: 'payments', maxMessages: 200 });
  const events = batch.map((message) => decodePaymentEvent(message.value));
  const built = buildUpsertSql(events);
  if (built.sql !== '') await pool.query(built.sql, [...built.params]);
  emitter.metric('ingest-rate', events.length);
};

const runChangefeedMonitorTick = async (): Promise<void> => {
  const status = await ticdc.getChangefeed(changefeedId);
  const lag = computeCheckpointLagMs({ nowMs: emitter.elapsedMs(), checkpointTime: status.checkpointTime });
  emitter.metric('ticdc-checkpoint-lag', lag);
};

const runRiskConsumerTick = async (): Promise<void> => {
  const batch = await kafka.createConsumer('kafka-demo-risk-consumer').consumeBatch({ topic: 'tidb-changes', maxMessages: 500 });
  batch.forEach((message) => {
    const parsed = parseCanalJsonMessage(message.value);
    if (!parsed.ok) return;
    const dedupeResult = dedupe.observe(`${parsed.row.payment_id}:${parsed.commitTs}`);
    if (dedupeResult.isDuplicate) emitter.metric('duplicates-observed', dedupeResult.duplicateCount);
    const latency = computeE2eLatencyMs({ produceTs: Number(parsed.row.produce_ts), consumeTs: emitter.elapsedMs() });
    emitter.metric('e2e-latency-p50', latency);
  });
};

void every({ intervalMs: 1000, task: runProducerTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runIngesterTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runChangefeedMonitorTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runRiskConsumerTick, signal: controller.signal });
```

- [ ] Manual run: `TIDB_HOST=127.0.0.1 KAFKA_BROKERS=127.0.0.1:9092 TICDC_API=http://127.0.0.1:8300 CHANGEFEED_ID=kafka-fintech-risk pnpm --filter @lab/demo-kafka start` - expected: `metric` and `flow` JSON lines print to stdout once per second with no `log` events at `error` level.
- [ ] Commit: `git add demos/kafka/runner/main.ts && git commit -m "kafka demo: wire producer, ingester, TiCDC monitor, and risk consumer"`

### Task 12: README and TALK-TRACK

- [ ] Create `demos/kafka/README.md`:

```markdown
# Kafka + TiDB: fintech risk pipeline

Payment events stream through Kafka into TiDB. TiCDC streams every committed
change back out to a second Kafka topic for downstream consumers, proving
TiDB can sit inside an existing Kafka-centric architecture as both a
consumer's write target and a CDC source.

## What it proves

- TiDB absorbs a 10x burst without falling behind.
- An ingester crash and restart causes zero lost or duplicated rows in TiDB.
- TiCDC catches up cleanly after a changefeed pause/resume, and its
  at-least-once delivery (visible duplicate downstream events) is measured,
  not hidden.

## Prerequisites

- Docker Desktop running.
- tiup installed.
- Node 22 and pnpm installed.

## Run

1. `docker compose -f ../../infra/kafka/docker-compose.yml up -d`
2. `../../infra/tidb/playground.sh`
3. Create the `lab.payments` table and the `kafka-fintech-risk` changefeed
   (see Plan 02, Tasks 8-9, for exact commands).
4. `cp .env.example .env` and fill in the values printed by the playground.
5. `pnpm lab run kafka --record`
6. Open the UI at `http://localhost:5173` and press the phase/control
   buttons in order.

## Record

`pnpm lab run kafka --record` writes `demos/kafka/traces/<timestamp>.json`.
Promote a good run: `cp demos/kafka/traces/<timestamp>.json demos/kafka/traces/featured.json`.

## Teardown

1. `cdc cli changefeed remove --changefeed-id=kafka-fintech-risk --server=http://127.0.0.1:8300`
2. `docker compose -f ../../infra/kafka/docker-compose.yml down -v`
3. `tiup clean lab`

## Cost notes

Local run costs nothing beyond compute. A TiDB Cloud Dedicated variant bills
node time plus TiCDC Replication Capacity Units; see
https://docs.pingcap.com/tidbcloud/tidb-cloud-billing-ticdc-rcu/ for the
formula. No price is quoted here because it changes independently of this
plan.
```

- [ ] Create `demos/kafka/TALK-TRACK.md`:

```markdown
# Talk track: Kafka + TiDB

## Warming up
"We're standing up a normal Kafka-to-TiDB pipeline: nothing custom, just a
consumer doing upserts."

## Steady state
"At steady state every payment event becomes a row in TiDB, and TiCDC
re-publishes that row change within milliseconds. Watch the end-to-end
latency series - that's produce time to CDC-consume time, measured, not
modeled."

## 10x burst
"Now we 10x the load. Watch ingest rate and TiCDC checkpoint lag - TiDB
absorbs it, TiCDC catches up."

## Ingester restart
"We kill the ingester consumer. Kafka holds its committed offset, so when it
reconnects it resumes exactly where it left off - no loss, no duplicate rows
in TiDB, because the upsert is idempotent on payment_id."

## Pause and resume the changefeed
"We pause the changefeed itself. TiDB keeps taking writes. When we resume,
TiCDC catches up from its checkpoint - and this is exactly where Kafka's
at-least-once delivery shows up as visible duplicates downstream."

## Wrap-up
"Produced count equals rows in TiDB equals distinct CDC events. Duplicates
happened, and we caught every one of them."

## Discovery questions

1. "What do you use Kafka for today, and where does the database sit in
   that pipeline?"
2. "When a downstream consumer needs to react to a database change, how do
   you get that change into Kafka today?"
3. "How do you handle a consumer crash mid-batch today - do you have an
   idempotency key on the write side?"
4. "Have you measured how long it takes a change to reach your downstream
   consumers today, or is that a blind spot?"
5. "What's your tolerance for duplicate events downstream - do your
   consumers already dedupe, or would this be new?"

## Objections and honest answers

1. "Doesn't this add another moving part (TiCDC) to our architecture?"
   Yes. It's one more component, and it's optional - you only add it if you
   need the second Kafka topic. If you just need Kafka-in, TiDB-out, you
   don't need TiCDC at all.
2. "Kafka's at-least-once - doesn't that mean we can get duplicate rows in
   our downstream systems?"
   Yes, and this demo shows it happening on purpose during the pause/resume
   phase. The fix is the same fix you'd use with any at-least-once system:
   dedupe on a stable key, which is what the risk consumer does here.
3. "What happens if TiCDC itself falls behind permanently, not just during
   a burst?"
   This demo doesn't test that; it tests recoverable lag under a bounded
   burst and a bounded pause. Sustained lag under sustained load is a
   capacity-planning question, not something this demo measures.
4. "Can we point this at our existing Kafka cluster instead of the local
   one?"
   Yes - change KAFKA_BROKERS and the sink-uri host list. ACLs need Topic
   Create/Write/Describe and Cluster DescribeConfig for the user TiCDC
   connects as.
5. "Does TiDB Cloud support this, or is it self-managed only?"
   TiDB Cloud Dedicated supports changefeeds to Kafka; Starter does not;
   Essential's changefeed support is request-only, not self-serve. See the
   README's cost notes for the current tier page.
```

- [ ] Commit: `git add demos/kafka/README.md demos/kafka/TALK-TRACK.md && git commit -m "kafka demo: README and talk track"`

## 8. Recording the featured trace

1. Complete Tasks 8-9 (shared infra up, table created, changefeed created and `state: "normal"`).
2. Set `.env` values: `LAB_ENV_TIDB` to the exact version string printed by `infra/tidb/playground.sh`; `LAB_ENV_NOTES` to `"local docker compose kafka + tiup playground, single broker, single TiKV"`.
3. Run `pnpm lab run kafka --record --port 7070`.
4. In the UI, let `warm-up` and `steady-state` run for at least 30 seconds each so the metric series have enough points to read.
5. Press `burst`, wait for the 30-second window to finish and `ticdc-checkpoint-lag` to return to its steady-state band.
6. Press `restart-ingester`, wait for `consumer-lag-payments` to drain back to zero.
7. Press `pause-changefeed`, wait 20-30 seconds, then press `resume-changefeed`; wait for `duplicates-observed` to tick up and `ticdc-checkpoint-lag` to recover.
8. Let `wrap-up` run until all three checks show `pass` (the correctness checks, not the duplicate counter, which is expected to be greater than zero and is not itself a check).
9. Stop the run (Ctrl-C on `pnpm lab run`); confirm `demos/kafka/traces/<ISO timestamp>.json` was written.
10. Promote it: `cp demos/kafka/traces/<ISO timestamp>.json demos/kafka/traces/featured.json`.
11. `pnpm lab validate kafka` - expected: no schema errors, no `eventReferenceErrors`.
12. `pnpm lab check-public` - expected: no denylisted terms or internal URLs found.

## 9. Risks and gotchas

- **Kafka client API mismatch:** `@confluentinc/kafka-javascript` is close to but not identical to KafkaJS's API (it wraps librdkafka). Confirm the exact `admin.fetchTopicOffsets` / `fetchOffsets` method names and return shapes against the installed package version before wiring `kafkaClient.ts` - the code in Task 10 is illustrative and must be checked against `node_modules/@confluentinc/kafka-javascript`'s type definitions.
- **TiCDC checkpoint_time format:** the OpenAPI v2 example in section 4 returns `checkpoint_time` as a space-separated `YYYY-MM-DD HH:MM:SS.mmm` string in what appears to be server local time, not UTC. `checkpointLag.ts` assumes UTC; if the local TiCDC server's timezone is not UTC, `computeCheckpointLagMs` will be off by the timezone offset. Confirm the timezone of `checkpoint_time` on the running cluster (`docker exec`/`tiup` host timezone) before trusting the metric in a recording, and adjust the parsing if needed.
- **`enable-tidb-extension=true` is required** for the canal-json `_tidb.commitTs` field the dedupe key depends on. Forgetting it silently drops the field and `parseCanalJsonMessage` returns `not a row event` for every message.
- **Duplicate topic auto-creation:** with `auto-create-topic` defaulting to `true`, a typo in the topic name creates a new empty topic instead of failing loudly. Verify `tidb-changes` and `payments` exist with `kafka-topics.sh --list` before a recording session.
- **Ingester consumer group offsets:** `restart-ingester` in Task 11 only emits a `node` event; it does not actually disconnect the underlying consumer in the illustrative code. Before recording, implement the real teardown/recreate of the `Consumer` instance (disconnect, then `createConsumer` again with the same `group.id`) so the control demonstrates a real crash-recovery, not a no-op.
- **TiDB Cloud variant:** Private Connect is not supported directly into managed Kafka SaaS (MSK, Confluent Cloud); a `kafka-proxy` intermediary is required in that case. Confirm current support before promising a customer a direct Private Connect path to their managed Kafka.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 02-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/02-kafka.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - | TiDB Cloud Premium tier's changefeed-to-Kafka support level is not stated on the pages fetched for this plan (Premium was in public preview at the time of writing). | n/a | **UNVERIFIED** - before recording a TiDB Cloud Premium variant, check the current [Changefeed Overview (TiDB Cloud)](https://
  - | KafkaJS has not published a release in an extended period and is widely reported as unmaintained; `@confluentinc/kafka-javascript` is Confluent's actively released, librdkafka-based client with a KafkaJS-compatible API. | [KafkaJS seems not maintained anymore (nestjs/nest#13223)](https://github.co
  - | Kafka client choice for this demo: `@confluentinc/kafka-javascript`, because it has an active release cadence and vendor support, and its API is close enough to KafkaJS's that runner code reads like idiomatic Node Kafka code (rationale, not a vendor claim). | [@confluentinc/kafka-javascript on npm
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/02-kafka.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 02-P1: Scaffold the demo package and a failing manifest test
- Tasks: 1
- Depends on: 02-V1   Shared runtime: none
- Files owned: `integrations/demos/kafka/manifest.json`, `integrations/demos/kafka/package.json`, `integrations/demos/kafka/test/manifest.test.ts`, `integrations/demos/kafka/tsconfig.json`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-kafka test` -> PASS
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 1's steps are all checked off and the gate output matches.

### Packet 02-P2: Payment event creation and encoding (pure)
- Tasks: 2
- Depends on: 02-P1   Shared runtime: none
- Files owned: `integrations/demos/kafka/runner/src/paymentEvent.ts`, `integrations/demos/kafka/runner/test/paymentEvent.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-kafka test paymentEvent` -> PASS
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 2's steps are all checked off and the gate output matches.

### Packet 02-P3: Dedupe tracker (pure)
- Tasks: 3
- Depends on: 02-P2   Shared runtime: none
- Files owned: `integrations/demos/kafka/runner/src/dedupe.ts`, `integrations/demos/kafka/runner/test/dedupe.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-kafka test dedupe` -> PASS
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 3's steps are all checked off and the gate output matches.

### Packet 02-P4: End-to-end latency computation (pure)
- Tasks: 4
- Depends on: 02-P3   Shared runtime: none
- Files owned: `integrations/demos/kafka/runner/src/latency.ts`, `integrations/demos/kafka/runner/test/latency.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-kafka test latency` -> PASS
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 4's steps are all checked off and the gate output matches.

### Packet 02-P5: Batched upsert SQL builder (pure)
- Tasks: 5
- Depends on: 02-P4   Shared runtime: none
- Files owned: `integrations/demos/kafka/runner/src/upsertSql.ts`, `integrations/demos/kafka/runner/test/upsertSql.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-kafka test upsertSql` -> PASS
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 5's steps are all checked off and the gate output matches.

### Packet 02-P6: Canal-JSON message parser (pure)
- Tasks: 6
- Depends on: 02-P5   Shared runtime: none
- Files owned: `integrations/demos/kafka/runner/src/canalJsonParser.ts`, `integrations/demos/kafka/runner/test/canalJsonParser.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-kafka test canalJsonParser` -> PASS
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 6's steps are all checked off and the gate output matches.

### Packet 02-P7: Checkpoint lag computation (pure)
- Tasks: 7
- Depends on: 02-P6   Shared runtime: none
- Files owned: `integrations/demos/kafka/runner/src/checkpointLag.ts`, `integrations/demos/kafka/runner/test/checkpointLag.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-kafka test checkpointLag` -> PASS
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 7's steps are all checked off and the gate output matches.

### Packet 02-P8: Bring up shared infra and confirm connectivity (manual, I/O)
- Tasks: 8
- Depends on: 02-P7   Shared runtime: tidb-playground + kafka
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 8 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 8's steps are all checked off and the gate output matches.

### Packet 02-P9: Create the changefeed (manual, I/O)
- Tasks: 9
- Depends on: 02-P8   Shared runtime: tidb-playground + kafka
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 9 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 02-P10: Thin I/O adapters - Kafka client, TiCDC API client, schema runner
- Tasks: 10
- Depends on: 02-P9   Shared runtime: none
- Files owned: `integrations/demos/kafka/runner/src/kafkaClient.ts`, `integrations/demos/kafka/runner/src/ticdcApi.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 02-P11: Wire the runner's main.ts
- Tasks: 11
- Depends on: 02-P10   Shared runtime: none
- Files owned: `integrations/demos/kafka/runner/main.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-kafka typecheck` -> exit 0
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 02-P12: README and TALK-TRACK
- Tasks: 12
- Depends on: 02-P11   Shared runtime: cloud-account
- Files owned: `integrations/demos/kafka/README.md`, `integrations/demos/kafka/TALK-TRACK.md`, `integrations/demos/kafka/traces/featured.json`
- Model: sonnet   Effort: M
- Gate:
  - `grep -c $'\u2014' integrations/demos/kafka/README.md integrations/demos/kafka/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 02-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 02-P12   Shared runtime: cloud-account
- Files owned: `integrations/demos/kafka/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate kafka` -> `kafka: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.
