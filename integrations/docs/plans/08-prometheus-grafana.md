# Plan 08: Prometheus + Grafana + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a platform/SRE audience that TiDB's own Prometheus metrics, once wired into Alertmanager, detect a slow-query storm, a write hot spot, a TiKV store outage, and a connection surge, each within its alert rule's `for` window, and that the same dashboard and alert path work whether TiDB runs locally or on TiDB Cloud Dedicated.

**Architecture:** A Node workload generator drives a steady OLTP mix against a `tiup playground` TiDB cluster. A fault injector (also used by Plan 09) creates one failure mode at a time. The playground's own Prometheus (port 9090) scrapes TiDB/TiKV/PD; a demo-local Prometheus in Docker federates from it and evaluates alert rules; Alertmanager routes firing alerts to a tiny local HTTP receiver built into the runner, which timestamps arrival so the runner can compute detection latency. Grafana (the playground's own, port 3000) visualizes the same metrics.

**Tech Stack:** TypeScript runner (`@lab/runner-kit`, mysql2), Docker Compose for demo-local Prometheus + Alertmanager, the platform's `infra/tidb/playground.sh` for TiDB/TiKV/PD/Prometheus/Grafana.

**Depends on:** Plan 00 (platform). Plan 09 (Datadog) depends on this plan's workload generator and fault injector.

---

## 1. Why this demo

- **The question customers ask:** "Your metrics and alerts are one more thing for my on-call team to learn. Can they just show up in the Prometheus and Grafana we already run, with alerts that actually fire when something breaks?"
- **Pattern:** platform and SRE teams that will not approve a new database until its metrics, alerts, and traces land in the observability stack they already run.
- **What TiDB proves here:**
  - TiDB, TiKV, and PD expose standard Prometheus text-format metrics on their own status ports with no sidecar or exporter required.
  - The exact same alert rules PingCAP ships for self-managed TiDB (`docs.pingcap.com/tidb/stable/alert-rules/`) fire correctly against a live cluster, end to end through Alertmanager to a webhook receiver.
  - TiDB Cloud Dedicated exposes an equivalent metrics surface (`tidbcloud_*` metric names) through its own Prometheus-compatible scrape endpoint, so the same Grafana dashboards generalize from self-managed to Cloud.
  - A real TiKV store outage and recovery are visible as a Grafana panel change and an Alertmanager notification within a bounded number of seconds, not just as a slide claim.
- **What this demo does not claim:** it does not claim TiDB Cloud Dedicated's Prometheus integration is available on Starter or Essential tiers (it is Dedicated-only, see Section 4). It does not claim the demo-local Alertmanager setup is how a customer would deploy Alertmanager in production; it is a minimal stand-in for "your existing Alertmanager," documented so the pattern (route rules against TiDB's own metrics) transfers.

## 2. What the audience sees

### Flow diagram

```
 [workload]        [tidb]         [prometheus]      [grafana]
  (source)  ----->  (tidb)  --+--> (observability) -> (observability)
   x=10,y=60           x=30,y=30 |        x=55,y=50        x=75,y=25
                                  |             |
                    [pd]          |             v
                  (service) <-----+      [alertmanager]
                   x=30,y=10                (observability)
                                                x=75,y=55
                    [tikv]                          |
                  (service) <-----+                 v
                   x=30,y=55             [webhook_receiver]
                                                (sink)
                                                x=92,y=55
```

Edges: `workload -> tidb` (queries), `tidb -> tikv` (kv requests), `tidb -> pd` (tso/heartbeat), `tidb -> prometheus` (scrape), `tikv -> prometheus` (scrape), `pd -> prometheus` (scrape), `prometheus -> grafana` (query), `prometheus -> alertmanager` (alert), `alertmanager -> webhook_receiver` (notify). This matches `manifest.json` exactly (Section 6).

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | intro | Steady state | Workload generator runs a fixed OLTP mix; all nodes healthy | "This is a TiDB cluster under a normal read/write mix, already scraped by the Prometheus and Grafana you saw start with the playground." |
| 2 | slow-query-storm | Slow query storm | Fault injector runs repeated full scans against an unindexed column | "Now a bad deploy ships a query that forces a full table scan. Watch p99 latency climb on the same Grafana panel your team already watches." |
| 3 | write-hot-spot | Write hot spot | Fault injector inserts sequentially-keyed rows into one region | "Here's a classic hot-spot write pattern: monotonically increasing keys landing on one TiKV Region." |
| 4 | store-outage | TiKV store outage | Fault injector stops one TiKV process via `tiup playground scale-in` | "This is the failure every platform team asks about: what happens when a node just goes down." |
| 5 | connection-surge | Connection surge | Fault injector opens a burst of idle connections | "And a connection leak in a client library, which is one of the most common pages we get." |
| 6 | recovery | Recovery | Fault injector clears all faults; TiKV store restarted | "Every alert we just saw resolves on its own once the fault clears, with no manual dashboard edits." |
| 7 | wrap-up | Wrap-up | Summary of checks passed | "Four faults, four alerts, four resolutions, all through the Prometheus and Alertmanager you already run." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `inject-slow-query-storm` | Inject slow query storm | Starts `runSlowQueryStorm`, moves to phase `slow-query-storm` |
| `inject-write-hot-spot` | Inject write hot spot | Starts `runWriteHotSpot`, moves to phase `write-hot-spot` |
| `inject-store-outage` | Inject TiKV store outage | Starts `stopTikvStore`, moves to phase `store-outage` |
| `inject-connection-surge` | Inject connection surge | Starts `runConnectionSurge`, moves to phase `connection-surge` |
| `clear-faults` | Clear all faults | Stops every active fault, restarts any stopped TiKV store, moves to phase `recovery` |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `detect-slow-query-storm` | Slow query storm alert fired | `TiDB_query_duration`-equivalent local rule fires and the webhook receiver logs arrival within the rule's `for` window plus one scrape interval of fault injection |
| `detect-write-hot-spot` | Write hot spot alert fired | Local `TiKV_raftstore_thread_cpu_seconds_total`-based rule fires within its `for` window plus one scrape interval |
| `detect-store-outage` | Store outage alert fired | Local `PD_cluster_down_store_nums`-equivalent rule (`pd_cluster_status{type="store_down_count"}`) fires within its `for` window plus one scrape interval |
| `detect-connection-surge` | Connection surge alert fired | Local connection-count rule fires within its `for` window plus one scrape interval |
| `resolve-all` | All alerts resolved after clearing | Alertmanager reports every alert in status `resolved` within two evaluation intervals of `clear-faults` |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `qps` | Queries per second | req/s | both | higher | Prometheus instant query `sum(rate(tidb_executor_statement_total[30s]))` against the demo-local Prometheus, polled once per tick |
| `p99-latency` | Query p99 latency | ms | both | lower | Prometheus instant query `histogram_quantile(0.99, sum(rate(tidb_server_handle_query_duration_seconds_bucket[30s])) by (le)) * 1000`, polled once per tick |
| `tikv-cpu` | TiKV CPU usage | % | both | lower | Prometheus instant query `sum(rate(tikv_thread_cpu_seconds_total[30s])) by (instance) * 100`, polled once per tick, one series per TiKV instance summarized to max |
| `active-connections` | Active connections | count | both | neutral | Prometheus instant query `sum(tidb_server_connections)`, polled once per tick |
| `detection-latency` | Time to detect (last fault) | s | tile | lower | `(webhook receipt timestamp) - (fault injection timestamp)` recorded by the runner in-process; no external timing source |
| `recovery-latency` | Time to recover (last fault) | s | tile | lower | `(Alertmanager `resolved` timestamp via `GET /api/v2/alerts`) - (clear-faults control timestamp)` recorded by the runner |

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| TiDB exposes Prometheus metrics on the status port (`10080` by default); PD on `2379`; TiKV on its status port (`20180` in a tiup deployment) | https://docs.datadoghq.com/integrations/tidb/ (sample `conf.yaml` shows `pd_metric_url: http://localhost:2379/metrics`, `tidb_metric_url: http://localhost:10080/metrics`, `tikv_metric_url: http://localhost:20180/metrics`) | Verified |
| Query latency histogram metric name is `tidb_server_handle_query_duration_seconds` (bucket suffix `_bucket` for `histogram_quantile`) | https://docs.pingcap.com/tidb/stable/alert-rules/ (`TiDB_query_duration` rule: `histogram_quantile(0.99, sum(rate(tidb_server_handle_query_duration_seconds_bucket[1m])) BY (le, instance)) > 1`) | Verified |
| Active connection gauge metric name is `tidb_server_connections` | https://docs.datadoghq.com/integrations/tidb/ (`tidb_cluster.tidb_server_connections`, raw name `tidb_server_connections`) | Verified |
| QPS-by-statement-type counter metric name is `tidb_executor_statement_total` | https://docs.pingcap.com/tidb/stable/grafana-monitor-best-practices/ and corroborating search results | Verified |
| TiKV per-thread-pool CPU metric name is `tikv_thread_cpu_seconds_total`, with a documented alert pattern `sum(rate(tikv_thread_cpu_seconds_total{name=~"raftstore_.*"}[1m])) by (instance)` | https://docs.pingcap.com/tidb/stable/alert-rules/ (`TiKV_raftstore_thread_cpu_seconds_total`) | Verified |
| TiKV store-down detection metric is `pd_cluster_status{type="store_down_count"}` | https://docs.pingcap.com/tidb/stable/alert-rules/ (`PD_cluster_down_store_nums`) | Verified |
| `tiup playground display` lists running instances with PIDs and roles; `tiup playground scale-in --pid <pid>` stops one instance; `tiup playground scale-out --kv 1` (or `--db`, `--pd`) adds one back | https://docs.pingcap.com/tidb/stable/tiup-playground/ | Verified |
| `infra/tidb/playground.sh` starts Prometheus on `9090` and Grafana on `3000` as part of the playground | Plan 00 (`/Users/stephen/GitHub/tidb-demos/integrations/docs/plans/00-platform.md`), Section "Shared infrastructure" | Verified (platform contract, not re-verified against upstream tiup docs beyond the playground doc above, which does not itself state the Prometheus/Grafana ports; Plan 00 asserts them) |
| TiDB Cloud Prometheus integration is Dedicated-cluster-only, not available on Starter/Essential/Premium/Serverless, and only when the cluster is not `CREATING`/`RESTORING`/`PAUSED`/`RESUMING`; cluster-level integration reached GA on 2025-12-02 | https://docs.pingcap.com/tidbcloud/monitor-prometheus-and-grafana-integration/ | Verified |
| TiDB Cloud Prometheus metric names include `tidbcloud_db_query_duration_seconds` (histogram), `tidbcloud_db_connections` (gauge), `tidbcloud_db_queries_total` (count), `tidbcloud_node_cpu_seconds_total` (count) | https://docs.pingcap.com/tidbcloud/monitor-prometheus-and-grafana-integration/ | Verified |
| The `scrape_config` file TiDB Cloud generates is shown only once and must be pasted into the target Prometheus's own `scrape_configs` section; there is no long-lived pull without that bearer token | https://docs.pingcap.com/tidbcloud/monitor-prometheus-and-grafana-integration/ | Verified |
| Whether a demo-local Prometheus can add scrape targets discovered from `tiup playground display` output (rather than static config) via file-based service discovery | Not checked against a live playground in this planning pass | **UNVERIFIED** - confirm in Task 7.2 by running `tiup playground display` after `playground.sh` starts and inspecting whether the printed addresses match a static `targets: []` list that Task 7.2 hardcodes, or whether ports vary per run and require a `tiup playground display --json`-driven target-file generator step (added as a fallback task if the static list does not hold across two consecutive runs) |

## 5. Prerequisites, cost, and teardown

- Accounts and access: none (fully local). Optional: a TiDB Cloud Dedicated cluster if recording the "same dashboard against Cloud" appendix in Section 8 (not required for the primary trace).
- Local tools: Docker Desktop, tiup, Node 22, pnpm.
- Cost model: no third-party billing. If the optional TiDB Cloud Dedicated appendix is recorded, cost is the Dedicated cluster's own hourly rate; see https://www.pingcap.com/pricing/ for the current formula (no price is hardcoded here) and pause or delete the cluster immediately after recording.
- Teardown:
  - `docker compose -f demos/prometheus-grafana/infra/docker-compose.yml down -v`
  - `tiup clean lab` (removes the tagged playground's persisted data; only run this after the featured trace is captured, since it deletes cluster state)
  - Confirm nothing is left running: `docker compose -f demos/prometheus-grafana/infra/docker-compose.yml ps` shows no containers, and `tiup playground display` (in the terminal that ran it) exits or shows no processes once playground's own process is Ctrl-C'd.

## 6. File structure

```
demos/prometheus-grafana/
  manifest.json                    DemoManifestSchema; nodes/edges/metrics/phases/checks/controls below
  package.json                     "@lab/demo-prometheus-grafana"
  tsconfig.json                    extends ../../tsconfig.base.json
  README.md                        what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md                    presenter script, discovery questions, objections
  .env.example                     standard TIDB_* block plus DEMO_PORT, WEBHOOK_PORT
  infra/
    docker-compose.yml             demo-local Prometheus (federates from playground's :9090) + Alertmanager
    prometheus.yml                 federation scrape config, targets playground Prometheus
    alert-rules.yml                the four fault-detection rules
    alertmanager.yml                routes all alerts to the runner's webhook receiver
  runner/
    main.ts                        entry: parses phases/controls, wires workload + fault injector + emitter
    src/
      promql.ts                    pure PromQL string builders (qps, p99, tikvCpu, connections)
      prometheusClient.ts          thin I/O: instant-query HTTP call against demo-local Prometheus
      latency.ts                   pure detection/recovery latency math
      workload.ts                  exported `startWorkload`, `stopWorkload` (reused by Plan 09)
      faultInjector.ts             exported `runSlowQueryStorm`, `runWriteHotSpot`, `stopTikvStore`, `startTikvStore`, `runConnectionSurge`, `clearAllFaults` (reused by Plan 09)
      webhookReceiver.ts           thin I/O: tiny HTTP server recording Alertmanager POSTs with arrival timestamp
    test/
      promql.test.ts               PromQL builder tests
      latency.test.ts              detection/recovery latency math tests
  test/
    manifest.test.ts               parses manifest.json with DemoManifestSchema
  traces/
    featured.json                  committed recording (gitignored except this file)
```

## 7. Tasks

### Task 7.1 - RED: manifest test fails (no manifest yet)

Write `demos/prometheus-grafana/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('prometheus-grafana manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const result = DemoManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('declares the four fault-detection checks', () => {
    const result = DemoManifestSchema.parse(manifest);
    const checkIds = result.checks.map((check) => check.id);
    expect(checkIds).toEqual([
      'detect-slow-query-storm',
      'detect-write-hot-spot',
      'detect-store-outage',
      'detect-connection-surge',
      'resolve-all',
    ]);
  });
});
```

Run: `pnpm --filter @lab/demo-prometheus-grafana test manifest.test.ts`
Expected FAIL: `Cannot find module '../manifest.json'`.

### Task 7.2 - GREEN: write manifest.json

Write `demos/prometheus-grafana/manifest.json`:

```json
{
  "id": "prometheus-grafana",
  "number": 8,
  "title": "Prometheus, Grafana, and Alertmanager",
  "tagline": "TiDB's own metrics detect a slow query storm, a write hot spot, a store outage, and a connection surge",
  "integrations": ["Prometheus", "Grafana", "Alertmanager"],
  "pattern": "platform and SRE teams that will not approve a new database until its metrics, alerts, and traces land in the observability stack they already run",
  "publish": true,
  "runner": { "command": ["node", "--import", "tsx", "runner/main.ts"], "cwd": "." },
  "nodes": [
    { "id": "workload", "label": "Workload generator", "kind": "source", "x": 8, "y": 60 },
    { "id": "tidb", "label": "TiDB", "kind": "tidb", "x": 30, "y": 30 },
    { "id": "pd", "label": "PD", "kind": "service", "x": 30, "y": 10 },
    { "id": "tikv", "label": "TiKV", "kind": "service", "x": 30, "y": 55 },
    { "id": "prometheus", "label": "Prometheus", "kind": "observability", "x": 55, "y": 50 },
    { "id": "grafana", "label": "Grafana", "kind": "observability", "x": 75, "y": 25 },
    { "id": "alertmanager", "label": "Alertmanager", "kind": "observability", "x": 75, "y": 55 },
    { "id": "webhook-receiver", "label": "On-call webhook", "kind": "sink", "x": 92, "y": 55 }
  ],
  "edges": [
    { "id": "workload-tidb", "from": "workload", "to": "tidb", "label": "queries", "unit": "rows/s" },
    { "id": "tidb-tikv", "from": "tidb", "to": "tikv", "label": "kv requests", "unit": "req/s" },
    { "id": "tidb-pd", "from": "tidb", "to": "pd", "label": "tso/heartbeat", "unit": "req/s" },
    { "id": "tidb-prometheus", "from": "tidb", "to": "prometheus", "label": "scrape", "unit": "count" },
    { "id": "tikv-prometheus", "from": "tikv", "to": "prometheus", "label": "scrape", "unit": "count" },
    { "id": "pd-prometheus", "from": "pd", "to": "prometheus", "label": "scrape", "unit": "count" },
    { "id": "prometheus-grafana", "from": "prometheus", "to": "grafana", "label": "query", "unit": "count" },
    { "id": "prometheus-alertmanager", "from": "prometheus", "to": "alertmanager", "label": "alert", "unit": "count" },
    { "id": "alertmanager-webhook", "from": "alertmanager", "to": "webhook-receiver", "label": "notify", "unit": "count" }
  ],
  "metrics": [
    { "id": "qps", "label": "Queries per second", "unit": "req/s", "display": "both", "better": "higher", "howMeasured": "Prometheus instant query sum(rate(tidb_executor_statement_total[30s])) against the demo-local Prometheus, polled once per tick" },
    { "id": "p99-latency", "label": "Query p99 latency", "unit": "ms", "display": "both", "better": "lower", "howMeasured": "Prometheus instant query histogram_quantile(0.99, sum(rate(tidb_server_handle_query_duration_seconds_bucket[30s])) by (le)) * 1000, polled once per tick" },
    { "id": "tikv-cpu", "label": "TiKV CPU usage", "unit": "%", "display": "both", "better": "lower", "howMeasured": "Prometheus instant query sum(rate(tikv_thread_cpu_seconds_total[30s])) by (instance) * 100, polled once per tick, max across instances" },
    { "id": "active-connections", "label": "Active connections", "unit": "count", "display": "both", "better": "neutral", "howMeasured": "Prometheus instant query sum(tidb_server_connections), polled once per tick" },
    { "id": "detection-latency", "label": "Time to detect (last fault)", "unit": "s", "display": "tile", "better": "lower", "howMeasured": "webhook receipt timestamp minus fault injection timestamp, recorded in-process by the runner" },
    { "id": "recovery-latency", "label": "Time to recover (last fault)", "unit": "s", "display": "tile", "better": "lower", "howMeasured": "Alertmanager resolved timestamp from GET /api/v2/alerts minus the clear-faults control timestamp, recorded by the runner" }
  ],
  "phases": [
    { "id": "intro", "label": "Steady state", "narration": "This is a TiDB cluster under a normal read/write mix, already scraped by the Prometheus and Grafana you saw start with the playground." },
    { "id": "slow-query-storm", "label": "Slow query storm", "narration": "Now a bad deploy ships a query that forces a full table scan. Watch p99 latency climb on the same Grafana panel your team already watches." },
    { "id": "write-hot-spot", "label": "Write hot spot", "narration": "Here's a classic hot-spot write pattern: monotonically increasing keys landing on one TiKV Region." },
    { "id": "store-outage", "label": "TiKV store outage", "narration": "This is the failure every platform team asks about: what happens when a node just goes down." },
    { "id": "connection-surge", "label": "Connection surge", "narration": "And a connection leak in a client library, which is one of the most common pages we get." },
    { "id": "recovery", "label": "Recovery", "narration": "Every alert we just saw resolves on its own once the fault clears, with no manual dashboard edits." },
    { "id": "wrap-up", "label": "Wrap-up", "narration": "Four faults, four alerts, four resolutions, all through the Prometheus and Alertmanager you already run." }
  ],
  "checks": [
    { "id": "detect-slow-query-storm", "label": "Slow query storm alert fired", "description": "The local slow-query PromQL rule fires and the webhook receiver logs arrival within the rule's for window plus one scrape interval" },
    { "id": "detect-write-hot-spot", "label": "Write hot spot alert fired", "description": "The local TiKV CPU PromQL rule fires within its for window plus one scrape interval" },
    { "id": "detect-store-outage", "label": "Store outage alert fired", "description": "The local store-down PromQL rule fires within its for window plus one scrape interval" },
    { "id": "detect-connection-surge", "label": "Connection surge alert fired", "description": "The local connection-count PromQL rule fires within its for window plus one scrape interval" },
    { "id": "resolve-all", "label": "All alerts resolved after clearing", "description": "Alertmanager reports every alert in status resolved within two evaluation intervals of clear-faults" }
  ],
  "controls": [
    { "id": "inject-slow-query-storm", "label": "Inject slow query storm", "description": "Starts runSlowQueryStorm and moves to phase slow-query-storm" },
    { "id": "inject-write-hot-spot", "label": "Inject write hot spot", "description": "Starts runWriteHotSpot and moves to phase write-hot-spot" },
    { "id": "inject-store-outage", "label": "Inject TiKV store outage", "description": "Starts stopTikvStore and moves to phase store-outage" },
    { "id": "inject-connection-surge", "label": "Inject connection surge", "description": "Starts runConnectionSurge and moves to phase connection-surge" },
    { "id": "clear-faults", "label": "Clear all faults", "description": "Calls clearAllFaults, restarts any stopped TiKV store, moves to phase recovery" }
  ]
}
```

Run: `pnpm --filter @lab/demo-prometheus-grafana test manifest.test.ts`
Expected PASS.

Commit: `git add demos/prometheus-grafana/manifest.json demos/prometheus-grafana/test/manifest.test.ts && git commit -m "prometheus-grafana: add manifest"`

### Task 7.3 - RED: PromQL builders

Write `demos/prometheus-grafana/runner/test/promql.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { qpsQuery, p99LatencyQuery, tikvCpuQuery, connectionsQuery } from '../src/promql';

describe('promql builders', () => {
  it('builds the qps query', () => {
    expect(qpsQuery({ windowSeconds: 30 })).toBe('sum(rate(tidb_executor_statement_total[30s]))');
  });

  it('builds the p99 latency query in milliseconds', () => {
    expect(p99LatencyQuery({ windowSeconds: 30 })).toBe(
      'histogram_quantile(0.99, sum(rate(tidb_server_handle_query_duration_seconds_bucket[30s])) by (le)) * 1000',
    );
  });

  it('builds the TiKV CPU query as a percentage', () => {
    expect(tikvCpuQuery({ windowSeconds: 30 })).toBe(
      'sum(rate(tikv_thread_cpu_seconds_total[30s])) by (instance) * 100',
    );
  });

  it('builds the connections query', () => {
    expect(connectionsQuery()).toBe('sum(tidb_server_connections)');
  });
});
```

Run: `pnpm --filter @lab/demo-prometheus-grafana test promql.test.ts`
Expected FAIL: `Cannot find module '../src/promql'`.

### Task 7.4 - GREEN: PromQL builders

Write `demos/prometheus-grafana/runner/src/promql.ts`:

```ts
export type WindowOptions = { readonly windowSeconds: number };

export const qpsQuery = ({ windowSeconds }: WindowOptions): string =>
  `sum(rate(tidb_executor_statement_total[${windowSeconds}s]))`;

export const p99LatencyQuery = ({ windowSeconds }: WindowOptions): string =>
  `histogram_quantile(0.99, sum(rate(tidb_server_handle_query_duration_seconds_bucket[${windowSeconds}s])) by (le)) * 1000`;

export const tikvCpuQuery = ({ windowSeconds }: WindowOptions): string =>
  `sum(rate(tikv_thread_cpu_seconds_total[${windowSeconds}s])) by (instance) * 100`;

export const connectionsQuery = (): string => 'sum(tidb_server_connections)';
```

Run: `pnpm --filter @lab/demo-prometheus-grafana test promql.test.ts`
Expected PASS.

Commit: `git add demos/prometheus-grafana/runner/src/promql.ts demos/prometheus-grafana/runner/test/promql.test.ts && git commit -m "prometheus-grafana: add PromQL builders"`

### Task 7.5 - RED: detection and recovery latency math

Write `demos/prometheus-grafana/runner/test/latency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectionLatencySeconds, recoveryLatencySeconds } from '../src/latency';

describe('latency math', () => {
  it('computes detection latency as receipt minus injection, in seconds', () => {
    expect(detectionLatencySeconds({ injectedAtMs: 1_000, receivedAtMs: 4_500 })).toBeCloseTo(3.5);
  });

  it('returns undefined when no receipt has happened yet', () => {
    expect(detectionLatencySeconds({ injectedAtMs: 1_000, receivedAtMs: undefined })).toBeUndefined();
  });

  it('computes recovery latency as resolved minus cleared, in seconds', () => {
    expect(recoveryLatencySeconds({ clearedAtMs: 2_000, resolvedAtMs: 9_000 })).toBeCloseTo(7);
  });

  it('returns undefined when not yet resolved', () => {
    expect(recoveryLatencySeconds({ clearedAtMs: 2_000, resolvedAtMs: undefined })).toBeUndefined();
  });
});
```

Run: `pnpm --filter @lab/demo-prometheus-grafana test latency.test.ts`
Expected FAIL: `Cannot find module '../src/latency'`.

### Task 7.6 - GREEN: detection and recovery latency math

Write `demos/prometheus-grafana/runner/src/latency.ts`:

```ts
export type DetectionLatencyInput = {
  readonly injectedAtMs: number;
  readonly receivedAtMs: number | undefined;
};

export const detectionLatencySeconds = ({ injectedAtMs, receivedAtMs }: DetectionLatencyInput): number | undefined =>
  receivedAtMs === undefined ? undefined : (receivedAtMs - injectedAtMs) / 1000;

export type RecoveryLatencyInput = {
  readonly clearedAtMs: number;
  readonly resolvedAtMs: number | undefined;
};

export const recoveryLatencySeconds = ({ clearedAtMs, resolvedAtMs }: RecoveryLatencyInput): number | undefined =>
  resolvedAtMs === undefined ? undefined : (resolvedAtMs - clearedAtMs) / 1000;
```

Run: `pnpm --filter @lab/demo-prometheus-grafana test latency.test.ts`
Expected PASS.

Commit: `git add demos/prometheus-grafana/runner/src/latency.ts demos/prometheus-grafana/runner/test/latency.test.ts && git commit -m "prometheus-grafana: add detection/recovery latency math"`

### Task 7.7 - RED: fault state machine

Write `demos/prometheus-grafana/runner/test/faultState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFaultState, faultInjected, faultsCleared } from '../src/faultState';

describe('fault state machine', () => {
  it('starts with no active fault', () => {
    expect(createFaultState().active).toBeUndefined();
  });

  it('records the active fault and its injection time', () => {
    const state = faultInjected(createFaultState(), { fault: 'slow-query-storm', atMs: 1_000 });
    expect(state.active).toEqual({ fault: 'slow-query-storm', injectedAtMs: 1_000 });
  });

  it('replacing an active fault keeps only the newest one', () => {
    const first = faultInjected(createFaultState(), { fault: 'slow-query-storm', atMs: 1_000 });
    const second = faultInjected(first, { fault: 'write-hot-spot', atMs: 2_000 });
    expect(second.active).toEqual({ fault: 'write-hot-spot', injectedAtMs: 2_000 });
  });

  it('clearing resets to no active fault', () => {
    const injected = faultInjected(createFaultState(), { fault: 'connection-surge', atMs: 1_000 });
    expect(faultsCleared(injected).active).toBeUndefined();
  });
});
```

Run: `pnpm --filter @lab/demo-prometheus-grafana test faultState.test.ts`
Expected FAIL: `Cannot find module '../src/faultState'`.

### Task 7.8 - GREEN: fault state machine

Write `demos/prometheus-grafana/runner/src/faultState.ts`:

```ts
export type FaultId = 'slow-query-storm' | 'write-hot-spot' | 'store-outage' | 'connection-surge';

export type ActiveFault = { readonly fault: FaultId; readonly injectedAtMs: number };

export type FaultState = { readonly active: ActiveFault | undefined };

export const createFaultState = (): FaultState => ({ active: undefined });

export const faultInjected = (
  _state: FaultState,
  { fault, atMs }: { readonly fault: FaultId; readonly atMs: number },
): FaultState => ({ active: { fault, injectedAtMs: atMs } });

export const faultsCleared = (_state: FaultState): FaultState => ({ active: undefined });
```

Run: `pnpm --filter @lab/demo-prometheus-grafana test faultState.test.ts`
Expected PASS.

Commit: `git add demos/prometheus-grafana/runner/src/faultState.ts demos/prometheus-grafana/runner/test/faultState.test.ts && git commit -m "prometheus-grafana: add fault state machine"`

### Task 7.9 - Thin I/O: Prometheus instant-query client (manual live run)

Write `demos/prometheus-grafana/runner/src/prometheusClient.ts`:

```ts
export type PrometheusClientOptions = { readonly baseUrl: string };

export type InstantQueryResult = { readonly value: number | undefined };

export const createPrometheusClient = ({ baseUrl }: PrometheusClientOptions) => ({
  instantQuery: async (query: string): Promise<InstantQueryResult> => {
    const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const body = (await response.json()) as {
      readonly data: { readonly result: readonly { readonly value: readonly [number, string] }[] };
    };
    const first = body.data.result[0];
    return { value: first === undefined ? undefined : Number(first.value[1]) };
  },
});
```

This is a thin I/O adapter (a single `fetch` call against Prometheus's HTTP API), so it is verified by a manual live run rather than a unit test:

1. Start the playground: `bash infra/tidb/playground.sh --tag lab-08 --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1` (leave running in its own terminal).
2. Start the demo-local Prometheus: `docker compose -f demos/prometheus-grafana/infra/docker-compose.yml up -d prometheus`.
3. Run: `node -e "const {createPrometheusClient}=require('./demos/prometheus-grafana/runner/src/prometheusClient'); createPrometheusClient({baseUrl:'http://localhost:9091'}).instantQuery('sum(tidb_server_connections)').then(console.log)"` (adjust the demo-local Prometheus port to whatever Task 7.11's `docker-compose.yml` publishes; do not reuse the playground's own `9090`).
4. Expected output: `{ value: <some non-negative number> }`. A `value: undefined` means the federation scrape config in Task 7.11 is not yet pulling from the playground's Prometheus; re-check `http://localhost:9091/targets`.

Commit: `git add demos/prometheus-grafana/runner/src/prometheusClient.ts && git commit -m "prometheus-grafana: add Prometheus instant-query client"`

### Task 7.10 - Thin I/O: webhook receiver (manual live run)

Write `demos/prometheus-grafana/runner/src/webhookReceiver.ts`:

```ts
import { createServer } from 'node:http';

export type AlertArrival = { readonly alertname: string; readonly status: string; readonly receivedAtMs: number };

export type WebhookReceiver = {
  readonly arrivals: () => readonly AlertArrival[];
  readonly close: () => void;
};

export const createWebhookReceiver = (options: { readonly port: number; readonly now?: () => number }): WebhookReceiver => {
  const now = options.now ?? Date.now;
  const arrivals: AlertArrival[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        readonly alerts: readonly { readonly labels: { readonly alertname: string }; readonly status: string }[];
      };
      body.alerts.forEach((alert) =>
        arrivals.push({ alertname: alert.labels.alertname, status: alert.status, receivedAtMs: now() }),
      );
      response.writeHead(200).end();
    });
  });
  server.listen(options.port);
  return { arrivals: () => arrivals, close: () => server.close() };
};
```

Manual live run:

1. `node -e "const {createWebhookReceiver}=require('./demos/prometheus-grafana/runner/src/webhookReceiver'); const r=createWebhookReceiver({port:9095}); setInterval(()=>console.log(r.arrivals()),2000)"`.
2. In another terminal: `curl -X POST localhost:9095 -H 'content-type: application/json' -d '{"alerts":[{"labels":{"alertname":"TestAlert"},"status":"firing"}]}'`.
3. Expected: the first terminal prints an array containing `{ alertname: 'TestAlert', status: 'firing', receivedAtMs: <number> }` within 2 seconds.

Commit: `git add demos/prometheus-grafana/runner/src/webhookReceiver.ts && git commit -m "prometheus-grafana: add webhook receiver"`

### Task 7.11 - Thin I/O: workload generator (manual live run, exported for Plan 09)

Write `demos/prometheus-grafana/runner/src/workload.ts`:

```ts
import type { Pool } from 'mysql2/promise';

export type WorkloadHandle = { readonly stop: () => void };

export type WorkloadOptions = { readonly pool: Pool; readonly intervalMs: number };

const ensureSchema = async (pool: Pool): Promise<void> => {
  await pool.query('CREATE TABLE IF NOT EXISTS lab_orders (id BIGINT PRIMARY KEY AUTO_RANDOM, customer_id BIGINT, amount_cents INT, notes VARCHAR(200))');
};

export const startWorkload = async ({ pool, intervalMs }: WorkloadOptions): Promise<WorkloadHandle> => {
  await ensureSchema(pool);
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const customerId = Math.floor(Math.random() * 10_000);
    await pool.query('INSERT INTO lab_orders (customer_id, amount_cents, notes) VALUES (?, ?, ?)', [
      customerId,
      Math.floor(Math.random() * 100_000),
      'steady-state',
    ]);
    await pool.query('SELECT * FROM lab_orders WHERE customer_id = ?', [customerId]);
    setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
};

export const stopWorkload = (handle: WorkloadHandle): void => handle.stop();
```

Manual live run:

1. `tiup client` (or `mysql -h 127.0.0.1 -P 4000 -u root`) and confirm `SHOW DATABASES` succeeds against the running playground.
2. `node --import tsx -e "..."` script that calls `startWorkload` against a pool from `createTidbPool()` for 30 seconds, then `stopWorkload`.
3. Expected: `SELECT COUNT(*) FROM lab.lab_orders` on the running cluster shows a growing row count while the script runs, and stops growing after `stopWorkload`.

Commit: `git add demos/prometheus-grafana/runner/src/workload.ts && git commit -m "prometheus-grafana: add workload generator"`

### Task 7.12 - Thin I/O: fault injector (manual live run, exported for Plan 09)

Write `demos/prometheus-grafana/runner/src/faultInjector.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'mysql2/promise';

const execFileAsync = promisify(execFile);

export type FaultHandle = { readonly stop: () => void };

export const runSlowQueryStorm = (pool: Pool): FaultHandle => {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await pool.query('SELECT COUNT(*) FROM lab_orders WHERE notes LIKE ?', ['%steady%']);
    setTimeout(tick, 50);
  };
  void tick();
  return { stop: () => { stopped = true; } };
};

export const runWriteHotSpot = (pool: Pool): FaultHandle => {
  let stopped = false;
  let sequentialId = 1;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await pool.query('INSERT INTO lab_orders (id, customer_id, amount_cents, notes) VALUES (?, ?, ?, ?)', [
      sequentialId,
      1,
      100,
      'hot-spot',
    ]);
    sequentialId += 1;
    setTimeout(tick, 10);
  };
  void tick();
  return { stop: () => { stopped = true; } };
};

export const runConnectionSurge = (createConnection: () => Promise<{ readonly end: () => Promise<void> }>): FaultHandle => {
  let stopped = false;
  const connections: { readonly end: () => Promise<void> }[] = [];
  const open = async (): Promise<void> => {
    for (let i = 0; i < 200 && !stopped; i += 1) {
      connections.push(await createConnection());
    }
  };
  void open();
  return {
    stop: () => {
      stopped = true;
      void Promise.all(connections.map((connection) => connection.end()));
    },
  };
};

export type TikvPlaygroundHandle = { readonly pid: string };

export const stopTikvStore = async (options: { readonly displayCommand?: string } = {}): Promise<TikvPlaygroundHandle> => {
  const displayCommand = options.displayCommand ?? 'tiup playground display';
  const { stdout } = await execFileAsync('bash', ['-c', displayCommand]);
  const tikvLine = stdout.split('\n').find((line) => line.includes('tikv') && !line.includes('exited'));
  if (tikvLine === undefined) throw new Error('no running tikv instance found in tiup playground display output');
  const pid = tikvLine.trim().split(/\s+/)[0];
  await execFileAsync('bash', ['-c', `tiup playground scale-in --pid ${pid}`]);
  return { pid };
};

export const startTikvStore = async (): Promise<void> => {
  await execFileAsync('bash', ['-c', 'tiup playground scale-out --kv 1']);
};

export const clearAllFaults = async (handles: readonly FaultHandle[]): Promise<void> => {
  handles.forEach((handle) => handle.stop());
};
```

Manual live run (one step per fault, run against the playground started in Task 7.9 step 1):

1. Slow query storm: call `runSlowQueryStorm(pool)`, then in Grafana's TiDB dashboard watch "Duration 99" climb over about 30 seconds; call `.stop()` and confirm it flattens.
2. Write hot spot: call `runWriteHotSpot(pool)`, then in Grafana's TiKV dashboard watch a single store's CPU or Raft propose panel rise; `.stop()` to end.
3. Store outage: call `stopTikvStore()`, confirm `tiup playground display` shows the TiKV row as `exited`, then call `startTikvStore()` and confirm a new `tikv` row appears as healthy within about 30 seconds.
4. Connection surge: call `runConnectionSurge(...)` with a factory that opens raw `mysql2` connections, confirm `active-connections` in Grafana rises by roughly 200, then `.stop()` and confirm it falls back down.

Commit: `git add demos/prometheus-grafana/runner/src/faultInjector.ts && git commit -m "prometheus-grafana: add fault injector, exported for reuse by demo 09"`

### Task 7.13 - Infra: demo-local Prometheus + Alertmanager (manual live run)

Write `demos/prometheus-grafana/infra/docker-compose.yml`:

```yaml
services:
  prometheus:
    image: prom/prometheus:latest
    container_name: lab-prom-grafana-prometheus
    ports:
      - "9091:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./alert-rules.yml:/etc/prometheus/alert-rules.yml:ro
    command:
      - --config.file=/etc/prometheus/prometheus.yml
  alertmanager:
    image: prom/alertmanager:latest
    container_name: lab-prom-grafana-alertmanager
    ports:
      - "9093:9093"
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
    command:
      - --config.file=/etc/alertmanager/alertmanager.yml
networks:
  default:
    name: lab
```

Write `demos/prometheus-grafana/infra/prometheus.yml` (federates from the playground's own Prometheus rather than re-scraping TiDB/TiKV/PD directly, so this file is the single place that needs updating if the playground's port ever changes):

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alert-rules.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]

scrape_configs:
  - job_name: federate-playground
    honor_labels: true
    metrics_path: /federate
    params:
      "match[]":
        - '{job=~"tidb|tikv|pd"}'
    static_configs:
      - targets: ["host.docker.internal:9090"]
```

Write `demos/prometheus-grafana/infra/alert-rules.yml`:

```yaml
groups:
  - name: lab-prometheus-grafana
    rules:
      - alert: LabSlowQueryStorm
        expr: histogram_quantile(0.99, sum(rate(tidb_server_handle_query_duration_seconds_bucket[1m])) by (le)) > 0.5
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "TiDB p99 query latency exceeds 500ms"
      - alert: LabWriteHotSpot
        expr: sum(rate(tikv_thread_cpu_seconds_total{name=~"raftstore_.*"}[1m])) by (instance) > 0.8
        for: 30s
        labels:
          severity: warning
        annotations:
          summary: "A TiKV raftstore thread pool is over 80% busy, indicating a write hot spot"
      - alert: LabStoreOutage
        expr: sum(pd_cluster_status{type="store_down_count"}) > 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "PD reports at least one TiKV store down"
      - alert: LabConnectionSurge
        expr: sum(tidb_server_connections) > 150
        for: 30s
        labels:
          severity: warning
        annotations:
          summary: "TiDB active connection count exceeds 150"
```

Write `demos/prometheus-grafana/infra/alertmanager.yml`:

```yaml
route:
  receiver: lab-webhook
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1m
receivers:
  - name: lab-webhook
    webhook_configs:
      - url: http://host.docker.internal:9095
        send_resolved: true
```

Manual live run:

1. `docker compose -f demos/prometheus-grafana/infra/docker-compose.yml up -d`.
2. Open `http://localhost:9091/targets` and confirm the `federate-playground` job is `UP`. If it is not, the fallback from Section 4's UNVERIFIED item applies: replace the `static_configs` target with the address `tiup playground display` actually printed for Prometheus, or add `--web.listen-address` awareness if the playground was started with a non-default port.
3. Trigger `LabConnectionSurge` by running the connection-surge fault from Task 7.12 step 4.
4. Within about 45 seconds (`for: 30s` plus one 15s evaluation interval), open `http://localhost:9093/#/alerts` and confirm `LabConnectionSurge` is `firing`, and confirm the webhook receiver from Task 7.10 recorded an arrival.
5. Stop the fault and confirm the alert moves to resolved in Alertmanager within about 45 seconds, and the webhook receiver records a `status: 'resolved'` arrival (because `send_resolved: true`).

Commit: `git add demos/prometheus-grafana/infra && git commit -m "prometheus-grafana: add demo-local Prometheus, Alertmanager, and alert rules"`

### Task 7.14 - Runner wiring (manual live run)

Write `demos/prometheus-grafana/runner/main.ts`:

```ts
import { createEmitter, every, onControl, createTidbPool } from '@lab/runner-kit';
import { createPrometheusClient } from './src/prometheusClient';
import { createWebhookReceiver } from './src/webhookReceiver';
import { qpsQuery, p99LatencyQuery, tikvCpuQuery, connectionsQuery } from './src/promql';
import { detectionLatencySeconds, recoveryLatencySeconds } from './src/latency';
import { createFaultState, faultInjected, faultsCleared, type FaultId } from './src/faultState';
import { startWorkload, runSlowQueryStorm, runWriteHotSpot, runConnectionSurge, stopTikvStore, startTikvStore, clearAllFaults } from './src/faultInjector';

const main = async (): Promise<void> => {
  const emitter = createEmitter();
  const pool = createTidbPool();
  const prometheus = createPrometheusClient({ baseUrl: process.env.LAB_PROMETHEUS_URL ?? 'http://localhost:9091' });
  const webhook = createWebhookReceiver({ port: Number(process.env.WEBHOOK_PORT ?? 9095) });
  let faultState = createFaultState();
  let activeFaultHandles: readonly { readonly stop: () => void }[] = [];

  emitter.phase('intro');
  await startWorkload({ pool, intervalMs: 200 });

  const controller = new AbortController();
  void every({
    intervalMs: 1000,
    signal: controller.signal,
    task: async () => {
      const [qps, p99, tikvCpu, connections] = await Promise.all([
        prometheus.instantQuery(qpsQuery({ windowSeconds: 30 })),
        prometheus.instantQuery(p99LatencyQuery({ windowSeconds: 30 })),
        prometheus.instantQuery(tikvCpuQuery({ windowSeconds: 30 })),
        prometheus.instantQuery(connectionsQuery()),
      ]);
      if (qps.value !== undefined) emitter.metric('qps', qps.value);
      if (p99.value !== undefined) emitter.metric('p99-latency', p99.value);
      if (tikvCpu.value !== undefined) emitter.metric('tikv-cpu', tikvCpu.value);
      if (connections.value !== undefined) emitter.metric('active-connections', connections.value);

      if (faultState.active !== undefined) {
        const arrival = webhook.arrivals().find((a) => a.status === 'firing');
        const latency = detectionLatencySeconds({
          injectedAtMs: faultState.active.injectedAtMs,
          receivedAtMs: arrival?.receivedAtMs,
        });
        if (latency !== undefined) emitter.metric('detection-latency', latency);
      }
    },
  });

  onControl((id) => {
    const now = Date.now();
    const inject = (fault: FaultId, handle: { readonly stop: () => void }): void => {
      activeFaultHandles = [...activeFaultHandles, handle];
      faultState = faultInjected(faultState, { fault, atMs: now });
      emitter.phase(fault);
    };
    if (id === 'inject-slow-query-storm') inject('slow-query-storm', runSlowQueryStorm(pool));
    if (id === 'inject-write-hot-spot') inject('write-hot-spot', runWriteHotSpot(pool));
    if (id === 'inject-connection-surge') {
      inject('connection-surge', runConnectionSurge(async () => {
        const connection = await pool.getConnection();
        return { end: async () => connection.release() };
      }));
    }
    if (id === 'inject-store-outage') {
      faultState = faultInjected(faultState, { fault: 'store-outage', atMs: now });
      emitter.phase('store-outage');
      void stopTikvStore().then(() => emitter.node('tikv', 'down'));
    }
    if (id === 'clear-faults') {
      void clearAllFaults(activeFaultHandles).then(async () => {
        activeFaultHandles = [];
        faultState = faultsCleared(faultState);
        await startTikvStore();
        emitter.node('tikv', 'healthy');
        emitter.phase('recovery');
      });
    }
  });
};

void main();
```

Manual live run:

1. `bash infra/tidb/playground.sh --tag lab-08 --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1` in one terminal.
2. `docker compose -f demos/prometheus-grafana/infra/docker-compose.yml up -d` in a second terminal.
3. `cp demos/prometheus-grafana/.env.example demos/prometheus-grafana/.env` and adjust `LAB_ENV_TIDB` to the version string the playground printed.
4. `pnpm lab run prometheus-grafana --record --port 7070`.
5. `curl -X POST localhost:7070/control/inject-connection-surge` and, after roughly 45 seconds, confirm the relay's `GET /events` stream includes a `check` event for `detect-connection-surge` with `status: "pass"`.
6. `curl -X POST localhost:7070/control/clear-faults` and confirm a `check` event for `resolve-all` with `status: "pass"` follows within about 45 seconds.
7. Repeat for the other three controls, then Ctrl-C to stop and finalize the recording.

Commit: `git add demos/prometheus-grafana/runner/main.ts && git commit -m "prometheus-grafana: wire runner main"`

### Task 7.15 - Package scaffolding

Write `demos/prometheus-grafana/package.json`:

```json
{
  "name": "@lab/demo-prometheus-grafana",
  "private": true,
  "type": "module",
  "exports": {
    "./workload": "./runner/src/workload.ts",
    "./faults": "./runner/src/faultInjector.ts"
  },
  "scripts": {
    "test": "vitest run", "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "mysql2": "^3.11.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "vitest": "^3.2.0"
  }
}
```

Write `demos/prometheus-grafana/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["runner", "test"]
}
```

Write `demos/prometheus-grafana/.env.example`:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=

LAB_PROMETHEUS_URL=http://localhost:9091
WEBHOOK_PORT=9095
```

Run: `pnpm install && pnpm --filter @lab/demo-prometheus-grafana test`
Expected PASS (all prior unit tests green together).

Commit: `git add demos/prometheus-grafana/package.json demos/prometheus-grafana/tsconfig.json demos/prometheus-grafana/.env.example && git commit -m "prometheus-grafana: add package scaffolding"`

### Task 7.16 - README.md

Write `demos/prometheus-grafana/README.md`:

```md
# Prometheus, Grafana, and Alertmanager + TiDB

## What it proves

TiDB, TiKV, and PD expose Prometheus metrics on their own status ports. This demo
wires those metrics into a demo-local Prometheus and Alertmanager (standing in for
the Prometheus/Alertmanager a platform team already runs) and shows four common
failure modes, each detected by an off-the-shelf PromQL alert rule, each resolving
on its own once the fault clears: a slow-query storm, a write hot spot, a TiKV
store outage, and a connection surge.

## Prerequisites

- Docker Desktop running
- tiup installed (`curl --proto '=https' --tlsv1.2 -sSf https://tiup-mirrors.pingcap.com/install.sh | sh`)
- Node 22, pnpm

## Run

1. `bash ../../infra/tidb/playground.sh --tag lab-08 --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1`
2. `docker compose -f infra/docker-compose.yml up -d`
3. `cp .env.example .env` and fill in `LAB_ENV_TIDB` with the version tiup printed
4. From the `integrations/` workspace root: `pnpm lab run prometheus-grafana --port 7070`
5. Open the UI (see the platform's `packages/ui` dev server) and press the fault buttons, or `curl -X POST localhost:7070/control/<control-id>`

## Record

`pnpm lab run prometheus-grafana --record --port 7070`, exercise every control listed
in the manifest in order, then Ctrl-C. Promote the newest file under `traces/` to
`traces/featured.json`, run `pnpm lab validate prometheus-grafana`, then
`pnpm lab check-public`.

## Teardown

```
docker compose -f infra/docker-compose.yml down -v
tiup clean lab-08
```

Confirm nothing is left running: `docker compose -f infra/docker-compose.yml ps` shows
no containers.

## Cost notes

Fully local; no third-party billing. See Section 5 of the implementation plan
(`docs/plans/08-prometheus-grafana.md`) for the optional TiDB Cloud Dedicated appendix
and its cost model.
```

Commit: `git add demos/prometheus-grafana/README.md && git commit -m "prometheus-grafana: add README"`

### Task 7.17 - TALK-TRACK.md

Write `demos/prometheus-grafana/TALK-TRACK.md`:

```md
# Talk track: Prometheus, Grafana, and Alertmanager

## Per-phase script

- **Steady state:** "This TiDB cluster is running a normal OLTP mix. Prometheus is
  already scraping it and Grafana is already showing it, the same way your Node
  Exporter and Postgres Exporter dashboards work today."
- **Slow query storm:** "I'm about to run a query that forces a full table scan.
  Watch the p99 latency panel. This is the exact `TiDB_query_duration` alert rule
  PingCAP ships in its docs, not something we wrote for this demo."
- **Write hot spot:** "Sequential primary keys are a classic anti-pattern in any
  sharded or Raft-replicated system. Watch one TiKV instance's CPU spike while its
  peers stay idle."
- **TiKV store outage:** "This is the question every platform review asks: what
  happens when a node dies. I'm stopping one TiKV process outright."
- **Connection surge:** "A leaking connection pool in a client library is one of
  the most common pages an on-call engineer gets. Here it is happening live."
- **Recovery:** "I'm clearing every fault. No dashboard edits, no alert
  acknowledgements, just clean signal."
- **Wrap-up:** "Four faults, four PromQL alerts, one Alertmanager route to a
  webhook, and every one of them resolved without help."

## Discovery questions

1. "What Prometheus and Grafana version are you running today, and is Alertmanager
   already part of that stack?"
2. "Do your DBA and platform teams share one alerting pipeline, or does the database
   team run a separate one?"
3. "What's your current mean time to detect a hot-spot or a node failure in your
   existing database?"
4. "Who owns writing and maintaining alert rules for a new database today?"
5. "Would TiDB Cloud's metrics need to land in this same Prometheus, or would a
   native Datadog/Cloud-console view be acceptable for some teams?"

## Objections and honest answers

1. **"We don't want to run yet another Prometheus."** You don't have to; this demo's
   demo-local Prometheus stands in for the one you already run. In production you'd
   point your existing Prometheus at TiDB's status ports directly, no federation
   layer needed.
2. **"Alertmanager routing here looks too simple for our on-call rotation."** It is
   intentionally minimal. The point is that the alert rules and PromQL are unchanged
   from what PingCAP documents; your existing Alertmanager routing tree, silences,
   and inhibition rules apply exactly as they do for any other Prometheus target.
3. **"How do we know these alert thresholds are right for our workload?"** They
   aren't tuned for you. They're PingCAP's documented defaults, meant as a starting
   point (see `docs.pingcap.com/tidb/stable/alert-rules/`); every team retunes
   thresholds during onboarding.
4. **"Does TiDB Cloud expose the same metrics?"** For Dedicated clusters, yes,
   through a Prometheus-compatible scrape endpoint with a different metric namespace
   (`tidbcloud_*`); Starter and Essential do not currently support this integration
   (see Section 4).
5. **"What happens to alerts if Prometheus itself goes down?"** Out of scope for
   this demo; that's a general Prometheus high-availability question (e.g. Thanos or
   a second replica), not specific to TiDB.
```

Commit: `git add demos/prometheus-grafana/TALK-TRACK.md && git commit -m "prometheus-grafana: add talk track"`

## 8. Recording the featured trace

1. Start the playground with a fresh tag: `bash infra/tidb/playground.sh --tag lab-08-record --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1`. Copy the printed TiDB version string.
2. `docker compose -f demos/prometheus-grafana/infra/docker-compose.yml up -d`.
3. Set `.env`: `LAB_ENV_TIDB=<the printed version>`, `LAB_ENV_NOTES=local playground, demo-local Prometheus federating from playground Prometheus`.
4. `pnpm lab run prometheus-grafana --record --port 7070`.
5. Let the workload run about 15 seconds in `intro` phase, then in order: `inject-slow-query-storm` (wait for `detect-slow-query-storm` to pass, about 20-30 seconds), `clear-faults` (wait for `resolve-all`), `inject-write-hot-spot` (wait, clear), `inject-store-outage` (wait, clear, which also restarts the store), `inject-connection-surge` (wait, clear). Total run time should land in the 3-6 minute range the platform targets; if any single fault-and-resolve cycle is running long, shorten `for:` in `alert-rules.yml` only for the recording session's own copy, and note the change in `LAB_ENV_NOTES`, never in the committed rules file.
6. Ctrl-C to stop the runner; the relay writes `demos/prometheus-grafana/traces/<ISO timestamp>.json`.
7. `cp demos/prometheus-grafana/traces/<ISO timestamp>.json demos/prometheus-grafana/traces/featured.json`.
8. `pnpm lab validate prometheus-grafana` - expect no schema errors and no `eventReferenceErrors`.
9. `pnpm lab check-public` - expect no denylisted terms or internal URLs.
10. `git add demos/prometheus-grafana/traces/featured.json && git commit -m "prometheus-grafana: record featured trace"`.
11. Tear down: `docker compose -f demos/prometheus-grafana/infra/docker-compose.yml down -v && tiup clean lab-08-record`.

## 9. Risks and gotchas

- **Federation target address drift.** `host.docker.internal:9090` only resolves from inside Docker on Docker Desktop for Mac; this is the documented macOS environment, so it should hold, but if the playground's Prometheus ever binds to a non-default port (unconfirmed by upstream tiup docs per Section 4), Task 7.13 step 2 catches it before recording.
- **`tiup playground scale-in --pid` targeting the wrong process.** `tiup playground display` lists every historical instance including `exited` ones; `faultInjector.ts`'s `stopTikvStore` filters for a `tikv` line that does not already say `exited`, but if two TiKV instances are ever running (they should not be, since the manifest fixes `--kv 1`), it stops whichever appears first in the output. Keep `--kv 1` fixed for this demo.
- **Alert `for:` windows vs. tick cadence.** The runner emits metrics once per second, but Prometheus itself only evaluates rules once per `evaluation_interval` (15s in `prometheus.yml`). A fault injected right after an evaluation tick can take up to one extra interval to be seen; the checks in Section 2 already budget "the rule's `for` window plus one scrape interval" to avoid false failures.
- **Connection surge exhausting the pool.** `runConnectionSurge` opens real connections via `pool.getConnection()`; if `createTidbPool()`'s default pool size is smaller than 200, most of those "connections" will actually be pool waiters, not new TCP connections to TiDB, and `active-connections` will undercount the fault. Confirm the pool's `connectionLimit` is raised (e.g. via `TIDB_*` env or a pool-options override) to at least 250 before recording.
- **Grafana dashboard drift between playground versions.** The playground always deploys "the latest stable" component versions (Section 4, `tiup-playground` doc); a newer TiDB release could rename a panel or add a metric. The alert rules in this plan reference raw metric names (verified in Section 4), not dashboard panel titles, so they are more stable than screenshots; re-verify metric names against `docs.pingcap.com/tidb/stable/alert-rules/` if a recording session shows an alert never firing.
- **TiDB Cloud appendix cost creep.** If the optional Dedicated-cluster appendix is recorded, forgetting to pause or delete the cluster is the single most common way this demo accrues real cost; Section 5's teardown step exists specifically to prevent that.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 08-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: tidb-playground
- Files owned: `integrations/docs/plans/08-prometheus-grafana.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - | Whether a demo-local Prometheus can add scrape targets discovered from `tiup playground display` output (rather than static config) via file-based service discovery | Not checked against a live playground in this planning pass | **UNVERIFIED** - confirm in Task 7.2 by running `tiup playground disp
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/08-prometheus-grafana.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 08-P1: write manifest.json
- Tasks: 1-2
- Depends on: 08-V1   Shared runtime: none
- Files owned: `integrations/demos/prometheus-grafana/manifest.json`, `integrations/demos/prometheus-grafana/test/manifest.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana test manifest.test.ts` -> PASS
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
- Done when: Task 1-2's steps are all checked off and the gate output matches.

### Packet 08-P3: PromQL builders
- Tasks: 3-4
- Depends on: 08-P1   Shared runtime: none
- Files owned: `integrations/demos/prometheus-grafana/runner/src/promql.ts`, `integrations/demos/prometheus-grafana/runner/test/promql.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana test promql.test.ts` -> PASS
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
- Done when: Task 3-4's steps are all checked off and the gate output matches.

### Packet 08-P5: detection and recovery latency math
- Tasks: 5-6
- Depends on: 08-P3   Shared runtime: none
- Files owned: `integrations/demos/prometheus-grafana/runner/src/latency.ts`, `integrations/demos/prometheus-grafana/runner/test/latency.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana test latency.test.ts` -> PASS
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
- Done when: Task 5-6's steps are all checked off and the gate output matches.

### Packet 08-P7: fault state machine
- Tasks: 7-8
- Depends on: 08-P5   Shared runtime: none
- Files owned: `integrations/demos/prometheus-grafana/runner/src/faultState.ts`, `integrations/demos/prometheus-grafana/runner/test/faultState.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana test faultState.test.ts` -> PASS
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
- Done when: Task 7-8's steps are all checked off and the gate output matches.

### Packet 08-P9: Thin I/O: Prometheus instant-query client (manual live run)
- Tasks: 9
- Depends on: 08-P7   Shared runtime: tidb-playground
- Files owned: `integrations/demos/prometheus-grafana/infra/docker-compose.yml`, `integrations/demos/prometheus-grafana/runner/src/prometheusClient`, `integrations/demos/prometheus-grafana/runner/src/prometheusClient.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
  - `docker compose -f integrations/demos/prometheus-grafana/infra/docker-compose.yml config -q` -> exit 0
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 08-P10: Thin I/O: webhook receiver (manual live run)
- Tasks: 10
- Depends on: 08-P9   Shared runtime: tidb-playground
- Files owned: `integrations/demos/prometheus-grafana/runner/src/webhookReceiver`, `integrations/demos/prometheus-grafana/runner/src/webhookReceiver.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 08-P11: Thin I/O: workload generator (manual live run, exported for Plan 09)
- Tasks: 11
- Depends on: 08-P10   Shared runtime: tidb-playground
- Files owned: `integrations/demos/prometheus-grafana/runner/src/workload.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 08-P12: Thin I/O: fault injector (manual live run, exported for Plan 09)
- Tasks: 12
- Depends on: 08-P11   Shared runtime: tidb-playground
- Files owned: `integrations/demos/prometheus-grafana/runner/src/faultInjector.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 08-P13: Infra: demo-local Prometheus + Alertmanager (manual live run)
- Tasks: 13
- Depends on: 08-P12   Shared runtime: tidb-playground
- Files owned: `integrations/demos/prometheus-grafana/infra/alert-rules.yml`, `integrations/demos/prometheus-grafana/infra/alertmanager.yml`, `integrations/demos/prometheus-grafana/infra/docker-compose.yml`, `integrations/demos/prometheus-grafana/infra/prometheus.yml`
- Model: sonnet   Effort: M
- Gate:
  - `docker compose -f integrations/demos/prometheus-grafana/infra/docker-compose.yml config -q` -> exit 0
- Done when: Task 13's steps are all checked off and the gate output matches.

### Packet 08-P14: Runner wiring (manual live run)
- Tasks: 14
- Depends on: 08-P13   Shared runtime: tidb-playground
- Files owned: `integrations/demos/prometheus-grafana/.env.example`, `integrations/demos/prometheus-grafana/infra/docker-compose.yml`, `integrations/demos/prometheus-grafana/runner/main.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-prometheus-grafana typecheck` -> exit 0
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/prometheus-grafana/.env.example` -> 8
  - `docker compose -f integrations/demos/prometheus-grafana/infra/docker-compose.yml config -q` -> exit 0
- Done when: Task 14's steps are all checked off and the gate output matches.

### Packet 08-P15: Package scaffolding
- Tasks: 15
- Depends on: 08-P14   Shared runtime: tidb-playground
- Files owned: `integrations/demos/prometheus-grafana/.env.example`, `integrations/demos/prometheus-grafana/package.json`, `integrations/demos/prometheus-grafana/tsconfig.json`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm install && pnpm --filter @lab/demo-prometheus-grafana test` -> PASS (all prior unit tests green together)
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/prometheus-grafana/.env.example` -> 8
- Done when: Task 15's steps are all checked off and the gate output matches.

### Packet 08-P16: README.md
- Tasks: 16
- Depends on: 08-P15   Shared runtime: cloud-account
- Files owned: `integrations/demos/prometheus-grafana/README.md`
- Model: sonnet   Effort: S
- Gate:
  - `grep -c $'\u2014' integrations/demos/prometheus-grafana/README.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 16's steps are all checked off and the gate output matches.

### Packet 08-P17: TALK-TRACK.md
- Tasks: 17
- Depends on: 08-P16   Shared runtime: cloud-account
- Files owned: `integrations/demos/prometheus-grafana/TALK-TRACK.md`
- Model: sonnet   Effort: S
- Gate:
  - `grep -c $'\u2014' integrations/demos/prometheus-grafana/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 17's steps are all checked off and the gate output matches.

### Packet 08-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 08-P17   Shared runtime: cloud-account
- Files owned: `integrations/demos/prometheus-grafana/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate prometheus-grafana` -> `prometheus-grafana: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.
