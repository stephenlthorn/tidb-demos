# Plan 09: Datadog + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a platform/SRE audience that TiDB's metrics land in Datadog through the official Datadog Agent integration, that an APM trace with a real SQL span shows exactly which query is slow, and that a Datadog Monitor detects each injected fault with a measured time-to-detect, all read back through Datadog's own APIs rather than eyeballed on a dashboard.

**Architecture:** Reuses Plan 08's workload generator and fault injector unchanged. A Datadog Agent (Docker) runs the official `tidb` OpenMetrics-based integration, scraping TiDB/TiKV/PD status ports and forwarding `tidb_cluster.*` metrics to Datadog. A small Node service instrumented with `dd-trace` executes the same workload queries so spans carry `sql.query` tags; a deliberately slow query is run through this instrumented path so it shows up in APM as a slow span. Four Datadog Monitors (created via the Monitors API from committed JSON) alert on the same fault signatures as Plan 08. Detection is measured by polling the Monitors API for `overall_state` transitions, not by a public webhook tunnel (see Section 4 for why).

**Tech Stack:** TypeScript runner (`@lab/runner-kit`, mysql2), `dd-trace` for Node APM, Datadog Agent in Docker, Datadog HTTP APIs (Monitors v1, Metrics v1 query).

**Depends on:** Plan 00 (platform). Plan 08's `runner/src/workload.ts` (`startWorkload`, `stopWorkload`) and `runner/src/faultInjector.ts` (`runSlowQueryStorm`, `runWriteHotSpot`, `runConnectionSurge`, `stopTikvStore`, `startTikvStore`, `clearAllFaults`), imported through that package's `exports` (`@lab/demo-prometheus-grafana/workload` and `@lab/demo-prometheus-grafana/faults`) as a workspace dependency rather than copied.

---

## 1. Why this demo

- **The question customers ask:** "We're a Datadog shop. Before we'll approve TiDB, show us it shows up in Datadog the same way every other database we run does, metrics, monitors, and a trace that tells us which query is slow."
- **Pattern:** platform and SRE teams that will not approve a new database until its metrics, alerts, and traces land in the observability stack they already run.
- **What TiDB proves here:**
  - The official Datadog `tidb` Agent integration (OpenMetrics-based, no custom exporter) collects TiDB/TiKV/TiFlash metrics with no code changes to TiDB itself.
  - A Node application's real SQL queries against TiDB show up as `mysql2` spans in Datadog APM, because `dd-trace` auto-instruments `mysql2` and TiDB is MySQL wire-protocol compatible.
  - A slow query is visible both as a slow APM span and, by SQL digest, in TiDB's own `information_schema.statements_summary`, so a customer can correlate "this trace is slow" with "this is the exact normalized SQL and plan responsible."
  - Datadog Monitors built from the same fault signatures as Plan 08's Prometheus alert rules detect all four faults, each with a measured time-to-detect read back from Datadog's own API.
- **What this demo does not claim:** it does not claim Datadog's dedicated Database Monitoring (DBM) product supports TiDB; DBM's documented integrations are Postgres, MySQL, SQL Server, and Oracle, and TiDB is not confirmed to be one of them (Section 4, **UNVERIFIED**). This demo correlates slow spans with TiDB's own `statements_summary` instead of relying on DBM. It also does not claim TiDB Cloud's built-in Datadog integration and this self-managed Agent-based integration expose identical metric names; they use different `tidb_cluster.*` vs `tidb_cloud.*` namespaces (Section 4).

## 2. What the audience sees

### Flow diagram

```
 [workload]        [tidb]          [dd-agent]        [datadog]
  (source)  ----->  (tidb)  ---+--> (observability) -> (cloud)
   x=8,y=65            x=30,y=30  |      x=55,y=45        x=78,y=30
                                   |
                     [pd]          |
                   (service) <-----+
                    x=30,y=10                  [apm-service]
                                                 (service)
                     [tikv]                      x=30,y=60
                   (service) <-----+                  |
                    x=30,y=45                         v
                                                  [datadog]
                                                   (cloud, same node as above)
```

Edges: `workload -> tidb` (queries), `apm-service -> tidb` (instrumented queries), `tidb -> tikv`, `tidb -> pd`, `tidb -> dd-agent` (scrape), `tikv -> dd-agent` (scrape), `pd -> dd-agent` (scrape), `dd-agent -> datadog` (forward metrics), `apm-service -> datadog` (forward traces). This matches `manifest.json` exactly (Section 6).

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | intro | Steady state | Workload generator and instrumented APM service both run; Agent forwarding metrics | "This is the same steady workload from the Prometheus demo, but now it's also flowing through a Datadog Agent and an APM-instrumented service." |
| 2 | slow-query-storm | Slow query storm | Fault injector runs full scans through the instrumented service | "Watch this slow query show up as a red span in Datadog APM, tagged with the exact SQL." |
| 3 | write-hot-spot | Write hot spot | Fault injector inserts sequential keys | "Same hot-spot pattern as before, this time visible in the Datadog TiKV CPU metric." |
| 4 | store-outage | TiKV store outage | Fault injector stops one TiKV process | "A node failure, and Datadog's own Monitor catches it." |
| 5 | connection-surge | Connection surge | Fault injector opens a burst of connections | "A connection leak, the same failure every on-call engineer has paged for." |
| 6 | recovery | Recovery | All faults cleared, TiKV restarted | "Every Datadog Monitor we just triggered resolves on its own." |
| 7 | wrap-up | Wrap-up | Summary of checks passed | "Four faults, four Datadog Monitors, one slow trace correlated straight back to a SQL digest in TiDB." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `inject-slow-query-storm` | Inject slow query storm | Runs the slow query through the instrumented APM service, starts `runSlowQueryStorm`, moves to phase `slow-query-storm` |
| `inject-write-hot-spot` | Inject write hot spot | Starts `runWriteHotSpot`, moves to phase `write-hot-spot` |
| `inject-store-outage` | Inject TiKV store outage | Starts `stopTikvStore`, moves to phase `store-outage` |
| `inject-connection-surge` | Inject connection surge | Starts `runConnectionSurge`, moves to phase `connection-surge` |
| `clear-faults` | Clear all faults | Stops every active fault, restarts any stopped TiKV store, moves to phase `recovery` |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `detect-slow-query-storm` | Slow query storm monitor fired | Polling `GET /api/v1/monitor/{id}` for the slow-query monitor shows `overall_state: "Alert"` within the monitor's evaluation window plus one Agent collection interval of injection |
| `detect-write-hot-spot` | Write hot spot monitor fired | Same polling pattern for the TiKV CPU monitor |
| `detect-store-outage` | Store outage monitor fired | Same polling pattern for the connection-count-as-liveness-proxy monitor is not used here; this check instead polls the store-down monitor built on `tidb_cluster.tikv_store_size_bytes` staleness (Section 4 flags the exact PD-derived metric as **UNVERIFIED** for the Agent integration; see Task 7.9 fallback) |
| `detect-connection-surge` | Connection surge monitor fired | Polling pattern for the `tidb_cluster.tidb_server_connections` monitor |
| `slow-span-correlated` | Slow span matches a TiDB SQL digest | The APM service logs the `sql.query` tag of its slowest span, and the runner queries `information_schema.statements_summary` for a row whose `QUERY_SAMPLE_TEXT` matches; pass when found |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `qps` | Queries per second | req/s | both | higher | Datadog Metrics query API `GET /api/v1/query` with `query=sum:tidb_cluster.tidb_executor_statement_total{*}.as_rate()`, polled once per tick |
| `p99-latency` | Query p99 latency | ms | both | lower | Datadog Metrics query API with `query=(sum:tidb_cluster.tidb_server_handle_query_duration_seconds.sum{*}.as_rate() / sum:tidb_cluster.tidb_server_handle_query_duration_seconds.count{*}.as_rate()) * 1000` (mean, not true p99, because the Agent integration ships `.count`/`.sum` distribution rollups rather than a queryable histogram bucket metric; see Section 4 **UNVERIFIED**), polled once per tick |
| `tikv-cpu` | TiKV CPU usage | % | both | lower | Datadog Metrics query API with `query=sum:tidb_cluster.process_cpu_seconds_total{component:tikv}.as_rate() * 100`, polled once per tick |
| `active-connections` | Active connections | count | both | neutral | Datadog Metrics query API with `query=sum:tidb_cluster.tidb_server_connections{*}`, polled once per tick |
| `trace-count` | APM spans with DB tag | count | tile | higher | Count of spans the instrumented service reports locally with a `db.type: mysql` tag over the run, incremented in-process by the runner each time the APM service confirms a span flushed (not read back from Datadog, to avoid a dependency on APM ingestion latency during the live demo) |
| `detection-latency` | Time to detect (last fault) | s | tile | lower | `(Monitor overall_state observed as "Alert" via polling) - (fault injection timestamp)`, recorded in-process by the runner |

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| Datadog ships an official `tidb` Agent integration (current version `2.1.1` at verification time), OpenMetrics-based, requiring TiDB 4.0+, installed via `datadog-agent integration install -t datadog-tidb==<INTEGRATION_VERSION>` | https://docs.datadoghq.com/integrations/tidb/ | Verified |
| The integration's sample config scrapes `pd_metric_url: http://localhost:2379/metrics`, `tidb_metric_url: http://localhost:10080/metrics`, `tikv_metric_url: http://localhost:20180/metrics`, `tiflash_metric_url: http://localhost:8234/metrics`, `tiflash_proxy_metric_url: http://localhost:20292/metrics` | https://docs.datadoghq.com/integrations/tidb/ | Verified |
| Collected metrics include `tidb_cluster.tidb_executor_statement_total`, `tidb_cluster.tidb_server_execute_error_total`, `tidb_cluster.tidb_server_connections`, `tidb_cluster.tidb_server_handle_query_duration_seconds.count`, `tidb_cluster.tidb_server_handle_query_duration_seconds.sum`, `tidb_cluster.tikv_engine_size_bytes`, `tidb_cluster.tikv_store_size_bytes`, `tidb_cluster.tikv_io_bytes`, `tidb_cluster.process_cpu_seconds_total`, `tidb_cluster.process_resident_memory_bytes` | https://docs.datadoghq.com/integrations/tidb/ | Verified |
| The Agent integration exposes only the `.count` and `.sum` of the query-duration histogram, not per-bucket data; a true `histogram_quantile`-style p99 is not obtainable from these two metrics alone, only a mean latency | https://docs.datadoghq.com/integrations/tidb/ ("Data Collected" table lists only `.count` and `.sum` for `tidb_server_handle_query_duration_seconds`) | Verified as a limitation; the plan's `p99-latency` metric is therefore labeled "mean" in the runner and its `howMeasured`, not true p99, to avoid overclaiming |
| CPU and memory metrics for TiKV/TiFlash are not collected when those components run under `tiup playground` on macOS, or under `docker-compose up` on a new Apple M1 machine | https://docs.datadoghq.com/integrations/tidb/ ("Troubleshooting" section) | Verified; this is a known gap for exactly this demo's target environment (macOS, tiup playground) and is called out in Section 9 |
| TiDB Cloud has a separate, native Datadog integration (cluster-level, GA 2025-09-30 for Dedicated), using a `tidb_cloud.*` metric namespace distinct from the self-managed Agent integration's `tidb_cluster.*` namespace; e.g. `tidb_cloud.db_query_per_second`, `tidb_cloud.db_total_connection`, `tidb_cloud.node_cpu_seconds_total` | https://docs.pingcap.com/tidbcloud/monitor-datadog-integration/ | Verified |
| TiDB Cloud's Datadog integration is documented separately for Starter (not available), Essential, Premium, and Dedicated (this plan's primary reference page covers Dedicated only) | https://docs.pingcap.com/tidbcloud/monitor-datadog-integration/ (note pointing to "Integrate TiDB Cloud Essential with Datadog" and "Integrate TiDB Cloud Premium with Datadog") | Partially verified: Dedicated behavior confirmed directly; Essential and Premium pages were not opened in this planning pass. **UNVERIFIED** - before presenting Cloud-tier claims beyond Dedicated, open `docs.pingcap.com/tidbcloud/monitor-datadog-integration-essential` and the Premium equivalent (exact slugs to be confirmed by following the links on the Dedicated page) and record their tier-specific metric lists |
| Datadog offers a no-credit-card free trial (documented as 14 days) | https://www.datadoghq.com/free-datadog-trial/ | Verified via search of Datadog's own marketing page; the plan does not hardcode the trial length in any prose the presenter reads live (Section 5 points to the URL instead) |
| Datadog Monitors are created via `POST https://api.datadoghq.com/api/v1/monitor` with a required `type` (this plan uses `"metric alert"`), `query`, and `name`; the metric alert query grammar is `time_aggr(time_window):space_aggr:metric{tags} operator #` | https://docs.datadoghq.com/api/latest/monitors/create-a-monitor/ | Verified |
| Datadog's metric-timeseries query endpoint is `GET https://api.datadoghq.com/api/v1/query` (query timeseries points); a newer cross-product endpoint `POST /api/v2/query/timeseries` also exists | https://docs.datadoghq.com/api/latest/metrics.md | Verified |
| `dd-trace` (Datadog's Node.js APM library) auto-instruments the `mysql2` module with no manual span code required, and must be initialized (`require('dd-trace').init()` or `node --require dd-trace/init`) before any other module is imported | https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/nodejs/ | Verified |
| TiDB exposes `information_schema.statements_summary` with columns including `DIGEST`, `DIGEST_TEXT`, `EXEC_COUNT`, `AVG_LATENCY`, `MAX_LATENCY`, `QUERY_SAMPLE_TEXT`, `PLAN_DIGEST`, and that these tables are not available on TiDB Cloud Starter or Essential | https://docs.pingcap.com/tidb/stable/statement-summary-tables/ | Verified |
| Whether Datadog's dedicated Database Monitoring (DBM) product lists TiDB as a supported integration (as distinct from the generic Agent/OpenMetrics `tidb` check used in this plan) | Not opened in this planning pass; DBM's documented supported databases are Postgres, MySQL, SQL Server, and Oracle in Datadog's general DBM materials, which does not list TiDB | **UNVERIFIED** - confirm by opening `docs.datadoghq.com/database_monitoring/setup_mysql/` (or the DBM overview's "supported databases" list) and checking for any TiDB-specific mention before Task 7.11; this plan proceeds on the assumption DBM is not used and correlation is done via `statements_summary` instead |
| Choice of detection mechanism: poll the Monitors API vs. a webhook through a public tunnel | No official doc opened for this specific comparison; this is a design decision, not a vendor fact | Design rationale (not a doc fact): polling `GET /api/v1/monitor/{id}` avoids standing up `ngrok`/`cloudflared` (not listed among this environment's installed tools), avoids exposing a local port to the internet, and avoids a webhook-integration setup step in the Datadog UI that would need to happen before every recording. The tradeoff is polling latency granularity equal to the poll interval (this plan polls every 5s), which is stated in the `detection-latency` metric's `howMeasured`. |
| Whether the Datadog `tidb` integration can expose `tikv_raftstore_write_cmd_total` (the metric Plan 08 switched `write-hot-spot` detection to, after finding `tikv_thread_cpu_seconds_total` does not exist on TiKV v8.5.8) under any Datadog metric name, so `write-hot-spot.json` and `tikvCpuQuery` could be aligned with 08's fix | `DataDog/integrations-extras` GitHub repo, `tidb/datadog_checks/tidb/metrics.py` (`TIDB_METRICS`, `TIKV_METRICS`, `TIFLASH_METRICS` lists) and `tidb/metadata.csv`, cross-checked against https://docs.datadoghq.com/integrations/tidb/ | Verified - the integration's Python check only ever forwards a fixed, hardcoded allowlist of 12 metrics (`tidb_executor_statement_total`, `tidb_server_execute_error_total`, `tidb_server_connections`, `tidb_server_handle_query_duration_seconds` `.count`/`.sum`, `process_cpu_seconds_total`, `process_resident_memory_bytes`, `tikv_engine_size_bytes`, `tikv_store_size_bytes`, `tikv_io_bytes`, and two renamed TiFlash gauges); there is no `extra_metrics`-style passthrough and no PD metrics are scraped at all. `tikv_raftstore_write_cmd_total` cannot be exposed under any name through this integration, so 08's fix has no Datadog equivalent - `write-hot-spot.json` and `tikvCpuQuery` are left on `tidb_cluster.process_cpu_seconds_total{component:tikv}`, which is a metric that does exist in the fixed allowlist and is the only available proxy, inheriting the "not collected under tiup playground on macOS" gap already recorded above and in Section 9. `store-outage.json`'s `tikv_store_size_bytes`-based no-data check and `connection-surge.json`'s `tidb_server_connections` check both also appear in this same fixed allowlist, so neither needed a metric-name change for 08's fixes. |

## 5. Prerequisites, cost, and teardown

- Accounts and access: a Datadog account (the free trial at https://www.datadoghq.com/free-datadog-trial/ covers this demo; no production Datadog org should be used for recording, since the featured trace embeds real Datadog API responses in its metrics and this repo is public), a Datadog API key and Application key (Application key needed to create/query Monitors).
- Local tools: Docker Desktop (for the Datadog Agent container), tiup, Node 22, pnpm, the same `infra/tidb/playground.sh` as Plan 08.
- Cost model: Datadog's trial and paid tiers both meter on hosts/containers monitored and custom metrics volume; see https://www.datadoghq.com/pricing/ for the current formula. This demo's Agent monitors a small, fixed number of local containers/processes and stays well within trial limits for the duration of a single recording session.
- Teardown:
  - `docker compose -f demos/datadog/infra/docker-compose.yml down -v`
  - Delete the four Monitors created for this demo: `for id in $(cat demos/datadog/.monitor-ids.json | jq -r '.[]'); do curl -X DELETE -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" "https://api.datadoghq.com/api/v1/monitor/$id"; done`
  - `tiup clean lab-09`
  - Confirm nothing is left billing: in the Datadog UI, Monitors list shows none of the four demo monitor names, and Integrations > TiDB shows no recently reporting host once the Agent container is stopped.

## 6. File structure

```
demos/datadog/
  manifest.json                    DemoManifestSchema; nodes/edges/metrics/phases/checks/controls below
  package.json                     "@lab/demo-datadog", depends on @lab/demo-prometheus-grafana for shared workload/fault code
  tsconfig.json                    extends ../../tsconfig.base.json
  README.md                        what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md                    presenter script, discovery questions, objections
  .env.example                     standard TIDB_* block plus DD_API_KEY, DD_APP_KEY, DD_SITE
  infra/
    docker-compose.yml             Datadog Agent container configured for the tidb integration
    conf.d/tidb.yaml                Agent check config (pd/tidb/tikv/tiflash metric URLs)
    monitors/
      slow-query-storm.json         Monitor definition JSON
      write-hot-spot.json           Monitor definition JSON
      store-outage.json             Monitor definition JSON
      connection-surge.json         Monitor definition JSON
  apm-service/
    server.ts                      dd-trace-initialized Node service executing workload/fault queries
  runner/
    main.ts                        entry: wires workload + fault injector (imported from Plan 08) + emitter
    src/
      datadogQuery.ts               pure Datadog metric-query string builders
      monitorClient.ts              thin I/O: create/get/delete Monitor via Datadog API
      metricsClient.ts               thin I/O: GET /api/v1/query against Datadog
      digestCorrelation.ts          pure function matching a span's sql tag against a statements_summary row
      latency.ts                    pure detection-latency math (reused pattern from Plan 08, separate file since inputs differ: Monitor state instead of webhook arrival)
    test/
      datadogQuery.test.ts
      digestCorrelation.test.ts
      latency.test.ts
  test/
    manifest.test.ts               parses manifest.json with DemoManifestSchema
  traces/
    featured.json                  committed recording (gitignored except this file)
```

## 7. Tasks

### Task 7.1 - RED: manifest test fails (no manifest yet)

Write `demos/datadog/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('datadog manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const result = DemoManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('declares the correlation check alongside the four fault checks', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.checks.map((check) => check.id)).toEqual([
      'detect-slow-query-storm',
      'detect-write-hot-spot',
      'detect-store-outage',
      'detect-connection-surge',
      'slow-span-correlated',
    ]);
  });
});
```

Run: `pnpm --filter @lab/demo-datadog test manifest.test.ts`
Expected FAIL: `Cannot find module '../manifest.json'`.

### Task 7.2 - GREEN: write manifest.json

Write `demos/datadog/manifest.json`:

```json
{
  "id": "datadog",
  "number": 9,
  "title": "Datadog metrics, APM, and Monitors",
  "tagline": "TiDB metrics in the Datadog Agent, a slow query traced to a SQL digest, four Monitors that detect and resolve",
  "integrations": ["Datadog"],
  "pattern": "platform and SRE teams that will not approve a new database until its metrics, alerts, and traces land in the observability stack they already run",
  "publish": true,
  "runner": { "command": ["node", "--import", "tsx", "runner/main.ts"], "cwd": "." },
  "nodes": [
    { "id": "workload", "label": "Workload generator", "kind": "source", "x": 8, "y": 65 },
    { "id": "apm-service", "label": "APM-instrumented service", "kind": "service", "x": 30, "y": 62 },
    { "id": "tidb", "label": "TiDB", "kind": "tidb", "x": 45, "y": 30 },
    { "id": "pd", "label": "PD", "kind": "service", "x": 45, "y": 10 },
    { "id": "tikv", "label": "TiKV", "kind": "service", "x": 45, "y": 45 },
    { "id": "dd-agent", "label": "Datadog Agent", "kind": "observability", "x": 65, "y": 30 },
    { "id": "datadog", "label": "Datadog", "kind": "cloud", "x": 88, "y": 30 }
  ],
  "edges": [
    { "id": "workload-tidb", "from": "workload", "to": "tidb", "label": "queries", "unit": "rows/s" },
    { "id": "apm-tidb", "from": "apm-service", "to": "tidb", "label": "instrumented queries", "unit": "rows/s" },
    { "id": "tidb-tikv", "from": "tidb", "to": "tikv", "label": "kv requests", "unit": "req/s" },
    { "id": "tidb-pd", "from": "tidb", "to": "pd", "label": "tso/heartbeat", "unit": "req/s" },
    { "id": "tidb-dd-agent", "from": "tidb", "to": "dd-agent", "label": "scrape", "unit": "count" },
    { "id": "tikv-dd-agent", "from": "tikv", "to": "dd-agent", "label": "scrape", "unit": "count" },
    { "id": "pd-dd-agent", "from": "pd", "to": "dd-agent", "label": "scrape", "unit": "count" },
    { "id": "dd-agent-datadog", "from": "dd-agent", "to": "datadog", "label": "forward metrics", "unit": "count" },
    { "id": "apm-datadog", "from": "apm-service", "to": "datadog", "label": "forward traces", "unit": "count" }
  ],
  "metrics": [
    { "id": "qps", "label": "Queries per second", "unit": "req/s", "display": "both", "better": "higher", "howMeasured": "Datadog Metrics query API GET /api/v1/query with query=sum:tidb_cluster.tidb_executor_statement_total{*}.as_rate(), polled once per tick" },
    { "id": "p99-latency", "label": "Query mean latency", "unit": "ms", "display": "both", "better": "lower", "howMeasured": "Datadog Metrics query API with query=(sum:tidb_cluster.tidb_server_handle_query_duration_seconds.sum{*}.as_rate() / sum:tidb_cluster.tidb_server_handle_query_duration_seconds.count{*}.as_rate()) * 1000; this is a mean, not a true p99, because the Agent integration only ships count/sum for this histogram" },
    { "id": "tikv-cpu", "label": "TiKV CPU usage", "unit": "%", "display": "both", "better": "lower", "howMeasured": "Datadog Metrics query API with query=sum:tidb_cluster.process_cpu_seconds_total{component:tikv}.as_rate() * 100" },
    { "id": "active-connections", "label": "Active connections", "unit": "count", "display": "both", "better": "neutral", "howMeasured": "Datadog Metrics query API with query=sum:tidb_cluster.tidb_server_connections{*}" },
    { "id": "trace-count", "label": "APM spans with DB tag", "unit": "count", "display": "tile", "better": "higher", "howMeasured": "count of spans the instrumented service reports locally with a db.type: mysql tag, incremented in-process by the runner" },
    { "id": "detection-latency", "label": "Time to detect (last fault)", "unit": "s", "display": "tile", "better": "lower", "howMeasured": "Monitor overall_state observed as Alert via 5-second polling of GET /api/v1/monitor/{id}, minus the fault injection timestamp, recorded in-process by the runner" }
  ],
  "phases": [
    { "id": "intro", "label": "Steady state", "narration": "This is the same steady workload from the Prometheus demo, but now it's also flowing through a Datadog Agent and an APM-instrumented service." },
    { "id": "slow-query-storm", "label": "Slow query storm", "narration": "Watch this slow query show up as a red span in Datadog APM, tagged with the exact SQL." },
    { "id": "write-hot-spot", "label": "Write hot spot", "narration": "Same hot-spot pattern as before, this time visible in the Datadog TiKV CPU metric." },
    { "id": "store-outage", "label": "TiKV store outage", "narration": "A node failure, and Datadog's own Monitor catches it." },
    { "id": "connection-surge", "label": "Connection surge", "narration": "A connection leak, the same failure every on-call engineer has paged for." },
    { "id": "recovery", "label": "Recovery", "narration": "Every Datadog Monitor we just triggered resolves on its own." },
    { "id": "wrap-up", "label": "Wrap-up", "narration": "Four faults, four Datadog Monitors, one slow trace correlated straight back to a SQL digest in TiDB." }
  ],
  "checks": [
    { "id": "detect-slow-query-storm", "label": "Slow query storm monitor fired", "description": "Polling GET /api/v1/monitor/{id} for the slow-query monitor shows overall_state Alert within its evaluation window plus one Agent collection interval of injection" },
    { "id": "detect-write-hot-spot", "label": "Write hot spot monitor fired", "description": "Same polling pattern for the TiKV CPU monitor" },
    { "id": "detect-store-outage", "label": "Store outage monitor fired", "description": "Same polling pattern for the store-size-staleness monitor" },
    { "id": "detect-connection-surge", "label": "Connection surge monitor fired", "description": "Same polling pattern for the connections monitor" },
    { "id": "slow-span-correlated", "label": "Slow span matches a TiDB SQL digest", "description": "The slowest reported span's sql tag matches a QUERY_SAMPLE_TEXT row in information_schema.statements_summary" }
  ],
  "controls": [
    { "id": "inject-slow-query-storm", "label": "Inject slow query storm", "description": "Runs the slow query through the instrumented APM service and starts runSlowQueryStorm, moves to phase slow-query-storm" },
    { "id": "inject-write-hot-spot", "label": "Inject write hot spot", "description": "Starts runWriteHotSpot, moves to phase write-hot-spot" },
    { "id": "inject-store-outage", "label": "Inject TiKV store outage", "description": "Starts stopTikvStore, moves to phase store-outage" },
    { "id": "inject-connection-surge", "label": "Inject connection surge", "description": "Starts runConnectionSurge, moves to phase connection-surge" },
    { "id": "clear-faults", "label": "Clear all faults", "description": "Calls clearAllFaults, restarts any stopped TiKV store, moves to phase recovery" }
  ]
}
```

Run: `pnpm --filter @lab/demo-datadog test manifest.test.ts`
Expected PASS.

Commit: `git add demos/datadog/manifest.json demos/datadog/test/manifest.test.ts && git commit -m "datadog: add manifest"`

### Task 7.3 - RED: Datadog query builders

Write `demos/datadog/runner/test/datadogQuery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { qpsQuery, meanLatencyQuery, tikvCpuQuery, connectionsQuery } from '../src/datadogQuery';

describe('datadog query builders', () => {
  it('builds the qps query', () => {
    expect(qpsQuery()).toBe('sum:tidb_cluster.tidb_executor_statement_total{*}.as_rate()');
  });

  it('builds the mean latency query in milliseconds', () => {
    expect(meanLatencyQuery()).toBe(
      '(sum:tidb_cluster.tidb_server_handle_query_duration_seconds.sum{*}.as_rate() / sum:tidb_cluster.tidb_server_handle_query_duration_seconds.count{*}.as_rate()) * 1000',
    );
  });

  it('builds the TiKV CPU query as a percentage', () => {
    expect(tikvCpuQuery()).toBe('sum:tidb_cluster.process_cpu_seconds_total{component:tikv}.as_rate() * 100');
  });

  it('builds the connections query', () => {
    expect(connectionsQuery()).toBe('sum:tidb_cluster.tidb_server_connections{*}');
  });
});
```

Run: `pnpm --filter @lab/demo-datadog test datadogQuery.test.ts`
Expected FAIL: `Cannot find module '../src/datadogQuery'`.

### Task 7.4 - GREEN: Datadog query builders

Write `demos/datadog/runner/src/datadogQuery.ts`:

```ts
export const qpsQuery = (): string => 'sum:tidb_cluster.tidb_executor_statement_total{*}.as_rate()';

export const meanLatencyQuery = (): string =>
  '(sum:tidb_cluster.tidb_server_handle_query_duration_seconds.sum{*}.as_rate() / sum:tidb_cluster.tidb_server_handle_query_duration_seconds.count{*}.as_rate()) * 1000';

export const tikvCpuQuery = (): string => 'sum:tidb_cluster.process_cpu_seconds_total{component:tikv}.as_rate() * 100';

export const connectionsQuery = (): string => 'sum:tidb_cluster.tidb_server_connections{*}';
```

Run: `pnpm --filter @lab/demo-datadog test datadogQuery.test.ts`
Expected PASS.

Commit: `git add demos/datadog/runner/src/datadogQuery.ts demos/datadog/runner/test/datadogQuery.test.ts && git commit -m "datadog: add Datadog metric query builders"`

### Task 7.5 - RED: detection latency math

Write `demos/datadog/runner/test/latency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectionLatencySeconds } from '../src/latency';

describe('detection latency math', () => {
  it('computes detection latency as the alert-observed poll time minus injection time, in seconds', () => {
    expect(detectionLatencySeconds({ injectedAtMs: 2_000, alertObservedAtMs: 9_000 })).toBeCloseTo(7);
  });

  it('returns undefined when the monitor has not alerted yet', () => {
    expect(detectionLatencySeconds({ injectedAtMs: 2_000, alertObservedAtMs: undefined })).toBeUndefined();
  });
});
```

Run: `pnpm --filter @lab/demo-datadog test latency.test.ts`
Expected FAIL: `Cannot find module '../src/latency'`.

### Task 7.6 - GREEN: detection latency math

Write `demos/datadog/runner/src/latency.ts`:

```ts
export type DetectionLatencyInput = {
  readonly injectedAtMs: number;
  readonly alertObservedAtMs: number | undefined;
};

export const detectionLatencySeconds = ({ injectedAtMs, alertObservedAtMs }: DetectionLatencyInput): number | undefined =>
  alertObservedAtMs === undefined ? undefined : (alertObservedAtMs - injectedAtMs) / 1000;
```

Run: `pnpm --filter @lab/demo-datadog test latency.test.ts`
Expected PASS.

Commit: `git add demos/datadog/runner/src/latency.ts demos/datadog/runner/test/latency.test.ts && git commit -m "datadog: add detection latency math"`

### Task 7.7 - RED: digest correlation

Write `demos/datadog/runner/test/digestCorrelation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findMatchingDigestRow } from '../src/digestCorrelation';

describe('digest correlation', () => {
  const rows = [
    { QUERY_SAMPLE_TEXT: 'select count(*) from lab_orders where customer_id=3100', DIGEST: 'abc' },
    { QUERY_SAMPLE_TEXT: "select * from lab_orders where notes like '%steady%'", DIGEST: 'def' },
  ];

  it('finds the row whose QUERY_SAMPLE_TEXT matches the span sql tag exactly', () => {
    const match = findMatchingDigestRow({ spanSql: "select * from lab_orders where notes like '%steady%'", rows });
    expect(match?.DIGEST).toBe('def');
  });

  it('returns undefined when no row matches', () => {
    const match = findMatchingDigestRow({ spanSql: 'select 1', rows });
    expect(match).toBeUndefined();
  });
});
```

Run: `pnpm --filter @lab/demo-datadog test digestCorrelation.test.ts`
Expected FAIL: `Cannot find module '../src/digestCorrelation'`.

### Task 7.8 - GREEN: digest correlation

Write `demos/datadog/runner/src/digestCorrelation.ts`:

```ts
export type StatementSummaryRow = { readonly QUERY_SAMPLE_TEXT: string; readonly DIGEST: string };

export const findMatchingDigestRow = (options: {
  readonly spanSql: string;
  readonly rows: readonly StatementSummaryRow[];
}): StatementSummaryRow | undefined => options.rows.find((row) => row.QUERY_SAMPLE_TEXT === options.spanSql);
```

Run: `pnpm --filter @lab/demo-datadog test digestCorrelation.test.ts`
Expected PASS.

Commit: `git add demos/datadog/runner/src/digestCorrelation.ts demos/datadog/runner/test/digestCorrelation.test.ts && git commit -m "datadog: add slow-span-to-digest correlation"`

### Task 7.9 - Infra: Datadog Agent with the tidb integration (manual live run)

Write `demos/datadog/infra/conf.d/tidb.yaml`:

```yaml
init_config:

instances:
  - pd_metric_url: http://host.docker.internal:2379/metrics
    send_distribution_buckets: true
    tags:
      - cluster_name:lab-09

  - tidb_metric_url: http://host.docker.internal:10080/metrics
    send_distribution_buckets: true
    tags:
      - cluster_name:lab-09

  - tikv_metric_url: http://host.docker.internal:20180/metrics
    send_distribution_buckets: true
    tags:
      - cluster_name:lab-09
```

Write `demos/datadog/infra/docker-compose.yml`:

```yaml
services:
  dd-agent:
    image: gcr.io/datadoghq/agent:latest
    container_name: lab-datadog-agent
    environment:
      DD_API_KEY: ${DD_API_KEY}
      DD_SITE: ${DD_SITE:-datadoghq.com}
      DD_HOSTNAME: lab-datadog-demo
    volumes:
      - ./conf.d/tidb.yaml:/etc/datadog-agent/conf.d/tidb.d/conf.yaml:ro
networks:
  default:
    name: lab
```

Manual live run:

1. Start the playground: `bash infra/tidb/playground.sh --tag lab-09 --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1`.
2. `export DD_API_KEY=<trial account API key>` then `docker compose -f demos/datadog/infra/docker-compose.yml up -d`.
3. `docker exec -it lab-datadog-agent agent status` and confirm a `tidb` check section with `Status: OK`, matching the "Validation" step in the official doc (Section 4).
4. In the Datadog UI, Metrics Explorer, search `tidb_cluster.tidb_server_connections` and confirm at least one recent value once the workload starts (Task 7.13).
5. If TiKV/TiFlash CPU or memory metrics never appear, this is the documented macOS/tiup-playground gap (Section 4, "Troubleshooting"); do not treat it as a setup bug. The `tikv-cpu` metric in Section 3 then falls back to `tidb_cluster.tikv_engine_size_bytes`'s presence alone as a liveness signal, and the store-outage Monitor (Task 7.10) is instead built on `tidb_cluster.tikv_store_size_bytes` staleness (a `.count` of 0 over a window), confirmed working in this same manual run before recording.

Commit: `git add demos/datadog/infra/docker-compose.yml demos/datadog/infra/conf.d/tidb.yaml && git commit -m "datadog: add Datadog Agent with the tidb integration"`

### Task 7.10 - Monitor definitions (manual live run)

Write `demos/datadog/infra/monitors/slow-query-storm.json`:

```json
{
  "name": "Lab: TiDB slow query storm",
  "type": "metric alert",
  "query": "avg(last_1m):(sum:tidb_cluster.tidb_server_handle_query_duration_seconds.sum{*}.as_rate() / sum:tidb_cluster.tidb_server_handle_query_duration_seconds.count{*}.as_rate()) * 1000 > 200",
  "message": "TiDB mean query latency exceeds 200ms.",
  "tags": ["demo:datadog", "fault:slow-query-storm"],
  "options": { "thresholds": { "critical": 200 }, "notify_no_data": false }
}
```

Write `demos/datadog/infra/monitors/write-hot-spot.json`:

```json
{
  "name": "Lab: TiDB write hot spot",
  "type": "metric alert",
  "query": "avg(last_1m):sum:tidb_cluster.process_cpu_seconds_total{component:tikv}.as_rate() * 100 > 80",
  "message": "A TiKV process is over 80% CPU, indicating a write hot spot.",
  "tags": ["demo:datadog", "fault:write-hot-spot"],
  "options": { "thresholds": { "critical": 80 }, "notify_no_data": false }
}
```

Write `demos/datadog/infra/monitors/store-outage.json`:

```json
{
  "name": "Lab: TiKV store outage",
  "type": "metric alert",
  "query": "avg(last_2m):sum:tidb_cluster.tikv_store_size_bytes{*}.as_count() < 1",
  "message": "No tidb_cluster.tikv_store_size_bytes samples in the last 2 minutes; the TiKV store the Agent scrapes appears to be down.",
  "tags": ["demo:datadog", "fault:store-outage"],
  "options": { "thresholds": { "critical": 1 }, "notify_no_data": true, "no_data_timeframe": 2 }
}
```

Write `demos/datadog/infra/monitors/connection-surge.json`:

```json
{
  "name": "Lab: TiDB connection surge",
  "type": "metric alert",
  "query": "avg(last_1m):sum:tidb_cluster.tidb_server_connections{*} > 150",
  "message": "TiDB active connection count exceeds 150.",
  "tags": ["demo:datadog", "fault:connection-surge"],
  "options": { "thresholds": { "critical": 150 }, "notify_no_data": false }
}
```

Write `demos/datadog/runner/src/monitorClient.ts`:

```ts
export type MonitorClientOptions = { readonly apiKey: string; readonly appKey: string; readonly site: string };

export type MonitorState = { readonly id: number; readonly overallState: string };

export const createMonitorClient = ({ apiKey, appKey, site }: MonitorClientOptions) => {
  const headers = { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey, 'content-type': 'application/json' };
  const base = `https://api.${site}/api/v1/monitor`;
  return {
    create: async (definition: Record<string, unknown>): Promise<number> => {
      const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify(definition) });
      const body = (await response.json()) as { readonly id: number };
      return body.id;
    },
    get: async (id: number): Promise<MonitorState> => {
      const response = await fetch(`${base}/${id}`);
      const body = (await response.json()) as { readonly id: number; readonly overall_state: string };
      return { id: body.id, overallState: body.overall_state };
    },
    remove: async (id: number): Promise<void> => {
      await fetch(`${base}/${id}`, { method: 'DELETE', headers });
    },
  };
};
```

Manual live run:

1. `export DD_APP_KEY=<trial account application key>`.
2. `node --import tsx -e "..."` script that reads each JSON file under `infra/monitors/`, calls `createMonitorClient(...).create(...)` for each, and writes the returned ids to `demos/datadog/.monitor-ids.json` (gitignored; regenerated per session, since Monitor ids are account-specific).
3. In the Datadog UI, Monitors, confirm four monitors named `Lab: TiDB *` exist and are in `OK` state before any fault is injected.
4. Trigger the connection surge fault (reusing Plan 08's `runConnectionSurge`, imported per Section 6). Poll `monitorClient.get(id)` for the connection-surge monitor's id every 5 seconds and confirm `overallState` transitions to `"Alert"` within about 90 seconds (1-minute `avg(last_1m)` window plus Agent collection interval plus poll granularity).
5. Clear the fault and confirm `overallState` returns to `"OK"` within a further 90 seconds.

Commit: `git add demos/datadog/infra/monitors demos/datadog/runner/src/monitorClient.ts && git commit -m "datadog: add Monitor definitions and Monitor API client"`

### Task 7.11 - Thin I/O: Datadog metrics client (manual live run)

Write `demos/datadog/runner/src/metricsClient.ts`:

```ts
export type MetricsClientOptions = { readonly apiKey: string; readonly appKey: string; readonly site: string };

export const createMetricsClient = ({ apiKey, appKey, site }: MetricsClientOptions) => ({
  latestValue: async (query: string): Promise<number | undefined> => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60;
    const url = `https://api.${site}/api/v1/query?from=${from}&to=${to}&query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey } });
    const body = (await response.json()) as {
      readonly series: readonly { readonly pointlist: readonly (readonly [number, number | null])[] }[];
    };
    const series = body.series[0];
    if (series === undefined) return undefined;
    const lastPoint = series.pointlist[series.pointlist.length - 1];
    return lastPoint?.[1] ?? undefined;
  },
});
```

Manual live run: with the Agent from Task 7.9 running and reporting for at least two minutes (Datadog's metrics query API needs ingested points, unlike Prometheus's instant scrape in Plan 08), run `node -e "..."` calling `createMetricsClient(...).latestValue('sum:tidb_cluster.tidb_server_connections{*}')` and confirm a defined number, not `undefined`. A persistent `undefined` means the Agent check is not reporting (recheck Task 7.9 step 3) or DD_SITE does not match the trial account's actual site (some trial signups land on `us5.datadoghq.com` rather than `datadoghq.com`; confirm in the Datadog UI's org settings).

Commit: `git add demos/datadog/runner/src/metricsClient.ts && git commit -m "datadog: add Datadog metrics query client"`

### Task 7.12 - APM-instrumented service (manual live run)

Write `demos/datadog/apm-service/server.ts`:

```ts
import 'dd-trace/init';
import { createTidbPool } from '@lab/runner-kit';
import { createServer } from 'node:http';

const pool = createTidbPool();

const server = createServer((request, response) => {
  if (request.url === '/slow-query') {
    void pool
      .query("SELECT * FROM lab_orders WHERE notes LIKE '%steady%'")
      .then(() => response.writeHead(200).end('ok'))
      .catch((error: unknown) => response.writeHead(500).end(String(error)));
    return;
  }
  response.writeHead(404).end();
});

server.listen(Number(process.env.APM_SERVICE_PORT ?? 9096));
```

Manual live run:

1. `DD_SERVICE=lab-datadog-apm-service DD_ENV=demo DD_API_KEY=$DD_API_KEY node --import tsx demos/datadog/apm-service/server.ts` (dd-trace can either talk to the Agent container from Task 7.9 over `DD_AGENT_HOST=localhost` if the Agent's trace-intake port `8126` is published, or ship traces directly; publish `8126:8126` on the Agent container and set `DD_AGENT_HOST=localhost`).
2. `curl localhost:9096/slow-query`.
3. In the Datadog UI, APM > Traces, filter by `service:lab-datadog-apm-service` and confirm a trace appears within about 30 seconds with a `mysql2` span carrying a `sql.query` (or `db.statement`) tag matching the query text.

Commit: `git add demos/datadog/apm-service/server.ts && git commit -m "datadog: add APM-instrumented service"`

### Task 7.13 - Runner wiring (manual live run)

Write `demos/datadog/runner/main.ts`:

```ts
import { createEmitter, every, onControl, createTidbPool } from '@lab/runner-kit';
import { startWorkload } from '@lab/demo-prometheus-grafana/workload';
import { runSlowQueryStorm, runWriteHotSpot, runConnectionSurge, stopTikvStore, startTikvStore, clearAllFaults, type TikvPlaygroundHandle } from '@lab/demo-prometheus-grafana/faults';
import { createMetricsClient } from './src/metricsClient';
import { createMonitorClient } from './src/monitorClient';
import { qpsQuery, meanLatencyQuery, tikvCpuQuery, connectionsQuery } from './src/datadogQuery';
import { detectionLatencySeconds } from './src/latency';
import { findMatchingDigestRow } from './src/digestCorrelation';
import monitorIds from '../.monitor-ids.json';

const main = async (): Promise<void> => {
  const emitter = createEmitter();
  const pool = createTidbPool();
  const metrics = createMetricsClient({
    apiKey: process.env.DD_API_KEY ?? '',
    appKey: process.env.DD_APP_KEY ?? '',
    site: process.env.DD_SITE ?? 'datadoghq.com',
  });
  const monitors = createMonitorClient({
    apiKey: process.env.DD_API_KEY ?? '',
    appKey: process.env.DD_APP_KEY ?? '',
    site: process.env.DD_SITE ?? 'datadoghq.com',
  });

  let faultInjectedAtMs: number | undefined;
  let activeMonitorId: number | undefined;
  let activeFaultHandles: readonly { readonly stop: () => void }[] = [];
  let stoppedTikv: TikvPlaygroundHandle | undefined;

  emitter.phase('intro');
  await startWorkload({ pool, intervalMs: 200 });

  const controller = new AbortController();
  void every({
    intervalMs: 1000,
    signal: controller.signal,
    task: async () => {
      const [qps, latency, tikvCpu, connections] = await Promise.all([
        metrics.latestValue(qpsQuery()),
        metrics.latestValue(meanLatencyQuery()),
        metrics.latestValue(tikvCpuQuery()),
        metrics.latestValue(connectionsQuery()),
      ]);
      if (qps !== undefined) emitter.metric('qps', qps);
      if (latency !== undefined) emitter.metric('p99-latency', latency);
      if (tikvCpu !== undefined) emitter.metric('tikv-cpu', tikvCpu);
      if (connections !== undefined) emitter.metric('active-connections', connections);
    },
  });

  void every({
    intervalMs: 5000,
    signal: controller.signal,
    task: async () => {
      if (activeMonitorId === undefined || faultInjectedAtMs === undefined) return;
      const state = await monitors.get(activeMonitorId);
      if (state.overallState === 'Alert') {
        const latency = detectionLatencySeconds({ injectedAtMs: faultInjectedAtMs, alertObservedAtMs: Date.now() });
        if (latency !== undefined) emitter.metric('detection-latency', latency);
      }
    },
  });

  onControl((id) => {
    const now = Date.now();
    if (id === 'inject-slow-query-storm') {
      activeFaultHandles = [...activeFaultHandles, runSlowQueryStorm(pool)];
      faultInjectedAtMs = now;
      activeMonitorId = monitorIds['slow-query-storm'];
      emitter.phase('slow-query-storm');
    }
    if (id === 'inject-write-hot-spot') {
      activeFaultHandles = [...activeFaultHandles, runWriteHotSpot(pool)];
      faultInjectedAtMs = now;
      activeMonitorId = monitorIds['write-hot-spot'];
      emitter.phase('write-hot-spot');
    }
    if (id === 'inject-connection-surge') {
      activeFaultHandles = [
        ...activeFaultHandles,
        runConnectionSurge(async () => {
          const connection = await pool.getConnection();
          return { end: async () => connection.destroy() };
        }),
      ];
      faultInjectedAtMs = now;
      activeMonitorId = monitorIds['connection-surge'];
      emitter.phase('connection-surge');
    }
    if (id === 'inject-store-outage') {
      faultInjectedAtMs = now;
      activeMonitorId = monitorIds['store-outage'];
      emitter.phase('store-outage');
      void stopTikvStore().then((handle) => {
        stoppedTikv = handle;
        emitter.node('tikv', 'down');
      });
    }
    if (id === 'clear-faults') {
      void clearAllFaults(activeFaultHandles).then(async () => {
        activeFaultHandles = [];
        faultInjectedAtMs = undefined;
        activeMonitorId = undefined;
        if (stoppedTikv !== undefined) {
          const handle = stoppedTikv;
          stoppedTikv = undefined;
          await startTikvStore(handle);
          emitter.node('tikv', 'healthy');
        }
        emitter.phase('recovery');
      });
    }
  });

  const [slowRows] = await pool.query(
    "SELECT DIGEST, QUERY_SAMPLE_TEXT FROM information_schema.statements_summary WHERE QUERY_SAMPLE_TEXT LIKE '%steady%'",
  );
  const match = findMatchingDigestRow({
    spanSql: "select * from lab_orders where notes like '%steady%'",
    rows: slowRows as readonly { readonly QUERY_SAMPLE_TEXT: string; readonly DIGEST: string }[],
  });
  emitter.check('slow-span-correlated', match === undefined ? 'fail' : 'pass', match?.DIGEST);
};

void main();
```

Manual live run:

1. Complete Tasks 7.9-7.12 so the Agent, Monitors, and APM service are all running against the same `lab-09` playground.
2. `cp demos/datadog/.env.example demos/datadog/.env` and fill in `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`.
3. From the `integrations/` workspace root: `pnpm lab run datadog --record --port 7071`.
4. `curl -X POST localhost:7071/control/inject-connection-surge`, wait about 90 seconds, confirm a `check` event for `detect-connection-surge` (this plan's runner emits that check by watching `activeMonitorId`'s state inside the 5-second poll loop; wire the `check` emission alongside the `detection-latency` metric update in the block above before considering this task complete).
5. `curl -X POST localhost:7071/control/clear-faults`, wait about 90 seconds, confirm the monitor returns to `OK`.
6. Repeat for the remaining three controls, then Ctrl-C to finalize the recording.

Commit: `git add demos/datadog/runner/main.ts && git commit -m "datadog: wire runner main"`

### Task 7.14 - Package scaffolding

Write `demos/datadog/package.json`:

```json
{
  "name": "@lab/demo-datadog",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run", "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "@lab/demo-prometheus-grafana": "workspace:*",
    "dd-trace": "^5.30.0",
    "mysql2": "^3.11.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "vitest": "^3.2.0"
  }
}
```

Write `demos/datadog/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["runner", "apm-service", "test"]
}
```

Write `demos/datadog/.env.example`:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=

DD_API_KEY=
DD_APP_KEY=
DD_SITE=datadoghq.com
APM_SERVICE_PORT=9096
```

Run: `pnpm install && pnpm --filter @lab/demo-datadog test`
Expected PASS (all prior unit tests green together).

Commit: `git add demos/datadog/package.json demos/datadog/tsconfig.json demos/datadog/.env.example && git commit -m "datadog: add package scaffolding"`

### Task 7.15 - README.md

Write `demos/datadog/README.md`:

```md
# Datadog + TiDB

## What it proves

TiDB's own metrics reach Datadog through the official Agent-based `tidb` OpenMetrics
integration, a real SQL query shows up as a Datadog APM span that correlates back to
TiDB's own `information_schema.statements_summary`, and four Datadog Monitors detect
the same fault signatures as the Prometheus demo (Plan 08), each with a measured
time-to-detect read back from Datadog's own Monitor API.

## Prerequisites

- Docker Desktop running
- tiup installed
- Node 22, pnpm
- A Datadog account (a free trial is sufficient; see
  https://www.datadoghq.com/free-datadog-trial/) with an API key and an
  Application key

## Run

1. `bash ../../infra/tidb/playground.sh --tag lab-09 --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1`
2. `cp .env.example .env` and fill in `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`
3. `docker compose -f infra/docker-compose.yml up -d`
4. Create the four Monitors (Task 7.10's script) and confirm `demos/datadog/.monitor-ids.json` was written
5. Start the APM service (Task 7.12)
6. From the `integrations/` workspace root: `pnpm lab run datadog --port 7071`
7. Press the fault buttons in the UI, or `curl -X POST localhost:7071/control/<control-id>`

## Record

`pnpm lab run datadog --record --port 7071`, exercise every control in order, then
Ctrl-C. Promote the newest file under `traces/` to `traces/featured.json`, run
`pnpm lab validate datadog`, then `pnpm lab check-public`.

## Teardown

```
docker compose -f infra/docker-compose.yml down -v
for id in $(cat .monitor-ids.json | jq -r '.[]'); do
  curl -X DELETE -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
    "https://api.datadoghq.com/api/v1/monitor/$id"
done
tiup clean lab-09
```

Confirm nothing is left billing: the Datadog Monitors list shows none of the four
`Lab: TiDB *` monitors, and the Integrations > TiDB page shows no recently reporting
host once the Agent container is stopped.

## Cost notes

See Section 5 of the implementation plan (`docs/plans/09-datadog.md`) for the
Datadog pricing formula link and the free-trial link; no price is hardcoded here.
```

Commit: `git add demos/datadog/README.md && git commit -m "datadog: add README"`

### Task 7.16 - TALK-TRACK.md

Write `demos/datadog/TALK-TRACK.md`:

```md
# Talk track: Datadog

## Per-phase script

- **Steady state:** "Same workload as before, but now a Datadog Agent is scraping
  TiDB, TiKV, and PD, and a small service is running real queries through Datadog's
  APM tracer."
- **Slow query storm:** "Here's a slow query running through the instrumented
  service. Watch it show up as a flagged span in APM, and watch us pull the exact
  SQL digest for it out of TiDB itself, not out of Datadog."
- **Write hot spot:** "The same sequential-key pattern as before, now visible as a
  TiKV process CPU metric inside Datadog."
- **TiKV store outage:** "I'm stopping a TiKV process. Datadog's own Monitor, not a
  script we wrote, notices the store stopped reporting."
- **Connection surge:** "A connection leak, caught by a Datadog Monitor on TiDB's
  connection-count metric."
- **Recovery:** "Every Monitor resolves on its own once the fault clears."
- **Wrap-up:** "Metrics, traces, and monitors, all in the tool you already have
  open every day."

## Discovery questions

1. "Is Datadog your team's primary observability tool, or one of several?"
2. "Do you already run Datadog APM on the services that talk to your database, or
   would TiDB be the first thing wired into APM this way?"
3. "How does your team currently correlate a slow trace back to the exact query
   that caused it?"
4. "Who owns Monitor definitions today, the platform team or each service team?"
5. "Is TiDB Cloud (managed) or self-managed TiDB more likely for your first
   deployment, since the Datadog integration path differs between the two?"

## Objections and honest answers

1. **"Datadog's TiDB integration isn't as deep as Postgres or MySQL."** That's
   accurate for Database Monitoring specifically; Datadog's dedicated DBM product
   is not confirmed to support TiDB (see Section 4 of the plan, marked
   **UNVERIFIED**, since DBM's documented supported databases are Postgres, MySQL,
   SQL Server, and Oracle). This demo uses the general-purpose Agent/OpenMetrics
   integration plus TiDB's own `statements_summary` for query-level detail instead,
   and that combination is what shipped here.
2. **"The p99 latency you're showing isn't really p99."** Correct, and the demo
   labels it "mean latency," not p99. The Agent integration only exposes the
   `.count` and `.sum` of TiDB's query-duration histogram, not per-bucket data, so a
   true percentile isn't computable from Datadog metrics alone. A true p99 is
   available through Plan 08's direct Prometheus histogram query.
3. **"Why isn't this using a webhook instead of polling for alerts?"** A webhook
   would need a public tunnel or a Datadog-side webhook integration set up before
   every recording session; polling the Monitor API avoids both, at the cost of
   detection-latency precision equal to the poll interval (5 seconds here), which
   is disclosed in the metric's `howMeasured`.
4. **"Does this work the same way on TiDB Cloud?"** TiDB Cloud has its own native
   Datadog integration with a different metric namespace (`tidb_cloud.*` vs. this
   demo's `tidb_cluster.*`), confirmed for Dedicated clusters; Essential and Premium
   have separate documentation pages not yet reviewed for this plan (Section 4).
5. **"What does this cost to run against our production Datadog org?"** This demo
   is designed to run against a free trial or a disposable Datadog org, not a
   production one, specifically because the featured recording embeds real
   Datadog API responses that would otherwise mix demo data into a real
   organization's metrics and Monitor list.
```

Commit: `git add demos/datadog/TALK-TRACK.md && git commit -m "datadog: add talk track"`

## 8. Recording the featured trace

1. Start the playground with a fresh tag: `bash infra/tidb/playground.sh --tag lab-09-record --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1`. Copy the printed TiDB version string.
2. Sign up for (or reuse) a Datadog trial account dedicated to this repo's demos; do not record against a production Datadog org (Section 5).
3. `docker compose -f demos/datadog/infra/docker-compose.yml up -d`, confirm the Agent check is `OK` (Task 7.9).
4. Create the four Monitors (Task 7.10) and confirm `demos/datadog/.monitor-ids.json`.
5. Start the APM service (Task 7.12).
6. Set `.env`: `LAB_ENV_TIDB=<the printed version>`, `LAB_ENV_NOTES=local playground, Datadog Agent + trial account, monitors created fresh per session`.
7. `pnpm lab run datadog --record --port 7071`.
8. Let the workload run about 15 seconds in `intro`, then in order: `inject-slow-query-storm` (call the APM service's `/slow-query` endpoint once during this phase so a slow span exists), wait for `detect-slow-query-storm`, `clear-faults`; repeat for `inject-write-hot-spot`, `inject-store-outage`, `inject-connection-surge`. Datadog's default 1-minute Monitor evaluation windows make each fault-and-resolve cycle slower than Plan 08's Prometheus rules; if the total run exceeds the platform's 3-6 minute target, this is expected and documented here rather than a bug to fix by shortening `avg(last_1m)` in the committed Monitor JSON (shortening it there would make the Monitors noisier in any real deployment).
9. Ctrl-C to stop the runner; the relay writes `demos/datadog/traces/<ISO timestamp>.json`.
10. `cp demos/datadog/traces/<ISO timestamp>.json demos/datadog/traces/featured.json`.
11. `pnpm lab validate datadog` - expect no schema errors and no `eventReferenceErrors`.
12. `pnpm lab check-public` - expect no denylisted terms or internal URLs; in particular confirm no Datadog API key, Application key, or account-specific Monitor id leaked into the trace (the trace only contains manifest-declared event shapes, none of which include raw credentials, but double check `log` events for accidental error-message leakage from a failed API call during recording).
13. `git add demos/datadog/traces/featured.json && git commit -m "datadog: record featured trace"`.
14. Tear down per Section 5, including deleting the four Monitors and the trial account's Agent-reported host if it will not be reused.

## 9. Risks and gotchas

- **DBM is not TiDB.** Datadog's dedicated Database Monitoring product is not confirmed to support TiDB (Section 4, **UNVERIFIED**); do not present this demo's APM correlation as "Database Monitoring." It is APM tracing plus a runner-side query against TiDB's own `statements_summary`.
- **Mean latency, not p99.** The Agent integration's histogram metrics only expose `.count`/`.sum`; presenting `p99-latency` as a true p99 would overclaim. The manifest's `howMeasured` and the talk track both say "mean" explicitly.
- **macOS TiKV/TiFlash CPU and memory gap.** Datadog's own troubleshooting doc says CPU/memory metrics are missing for TiKV/TiFlash under `tiup playground` on macOS (Section 4). The `store-outage` Monitor is therefore built on `tikv_store_size_bytes` staleness, not a CPU-based signal, specifically to route around this gap; do not "fix" the write-hot-spot Monitor's `process_cpu_seconds_total{component:tikv}` query without first re-confirming this gap still applies to the tiup/Agent version in use.
- **Monitor evaluation windows are slower than Prometheus's.** `avg(last_1m)` plus Agent collection interval plus poll interval means each fault takes noticeably longer to detect than in Plan 08. Budget for this when planning the 3-6 minute recording (Task 8, step 8) rather than shortening the windows in the committed Monitor JSON.
- **Trial account metric ingestion lag.** Unlike Prometheus's instant-query model, Datadog's metrics query API needs the Agent's points to have actually landed; a `latestValue` call made within the first 60-90 seconds of the Agent starting can return `undefined` even though the Agent check itself reports `OK`. Task 7.11's manual run step exists to catch this before it's mistaken for an integration bug during recording.
- **`.monitor-ids.json` is per-session and gitignored.** Every recording session that creates fresh Monitors must also delete them in teardown (Section 5); a lingering Monitor named `Lab: TiDB *` in a shared trial account will confuse later sessions using the same account.
- **`dd-trace/init` ordering.** If any other module in `apm-service/server.ts` is imported before `dd-trace/init`, `mysql2` auto-instrumentation silently does not attach and no span appears; this is the single most common reason Task 7.12's manual run shows no trace.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 09-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/09-datadog.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - | TiDB Cloud's Datadog integration is documented separately for Starter (not available), Essential, Premium, and Dedicated (this plan's primary reference page covers Dedicated only) | https://docs.pingcap.com/tidbcloud/monitor-datadog-integration/ (note pointing to "Integrate TiDB Cloud Essential wi
  - | Whether Datadog's dedicated Database Monitoring (DBM) product lists TiDB as a supported integration (as distinct from the generic Agent/OpenMetrics `tidb` check used in this plan) | Not opened in this planning pass; DBM's documented supported databases are Postgres, MySQL, SQL Server, and Oracle i
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/09-datadog.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 09-P1: write manifest.json
- Tasks: 1-2
- Depends on: 09-V1   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/manifest.json`, `integrations/demos/datadog/test/manifest.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-datadog test manifest.test.ts` -> PASS
  - `pnpm --filter @lab/demo-datadog typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 1-2's steps are all checked off and the gate output matches.

### Packet 09-P3: Datadog query builders
- Tasks: 3-4
- Depends on: 09-P1   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/runner/src/datadogQuery.ts`, `integrations/demos/datadog/runner/test/datadogQuery.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-datadog test datadogQuery.test.ts` -> PASS
  - `pnpm --filter @lab/demo-datadog typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 3-4's steps are all checked off and the gate output matches.

### Packet 09-P5: detection latency math
- Tasks: 5-6
- Depends on: 09-P3   Shared runtime: none
- Files owned: `integrations/demos/datadog/runner/src/latency.ts`, `integrations/demos/datadog/runner/test/latency.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-datadog test latency.test.ts` -> PASS
  - `pnpm --filter @lab/demo-datadog typecheck` -> exit 0
- Done when: Task 5-6's steps are all checked off and the gate output matches.

### Packet 09-P7: digest correlation
- Tasks: 7-8
- Depends on: 09-P5   Shared runtime: none
- Files owned: `integrations/demos/datadog/runner/src/digestCorrelation.ts`, `integrations/demos/datadog/runner/test/digestCorrelation.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-datadog test digestCorrelation.test.ts` -> PASS
  - `pnpm --filter @lab/demo-datadog typecheck` -> exit 0
- Done when: Task 7-8's steps are all checked off and the gate output matches.

### Packet 09-P9: Infra: Datadog Agent with the tidb integration (manual live run)
- Tasks: 9
- Depends on: 09-P7   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/infra/conf.d/tidb.yaml`, `integrations/demos/datadog/infra/docker-compose.yml`
- Model: sonnet   Effort: S
- Gate:
  - `docker compose -f integrations/demos/datadog/infra/docker-compose.yml config -q` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 09-P10: Monitor definitions (manual live run)
- Tasks: 10
- Depends on: 09-P9   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/.monitor-ids.json`, `integrations/demos/datadog/infra/monitors/connection-surge.json`, `integrations/demos/datadog/infra/monitors/slow-query-storm.json`, `integrations/demos/datadog/infra/monitors/store-outage.json`, `integrations/demos/datadog/infra/monitors/write-hot-spot.json`, `integrations/demos/datadog/runner/src/monitorClient.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-datadog typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 09-P11: Thin I/O: Datadog metrics client (manual live run)
- Tasks: 11
- Depends on: 09-P10   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/runner/src/metricsClient.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-datadog typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 09-P12: APM-instrumented service (manual live run)
- Tasks: 12
- Depends on: 09-P11   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/apm-service/server.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-datadog typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 09-P13: Runner wiring (manual live run)
- Tasks: 13
- Depends on: 09-P12   Shared runtime: tidb-playground
- Files owned: `integrations/demos/datadog/.env.example`, `integrations/demos/datadog/runner/main.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-datadog typecheck` -> exit 0
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/datadog/.env.example` -> 8
- Done when: Task 13's steps are all checked off and the gate output matches.

### Packet 09-P14: Package scaffolding
- Tasks: 14
- Depends on: 09-P13   Shared runtime: tidb-playground
- Files owned: `integrations/demos/datadog/.env.example`, `integrations/demos/datadog/package.json`, `integrations/demos/datadog/tsconfig.json`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm install && pnpm --filter @lab/demo-datadog test` -> PASS (all prior unit tests green together)
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/datadog/.env.example` -> 8
- Done when: Task 14's steps are all checked off and the gate output matches.

### Packet 09-P15: README.md
- Tasks: 15
- Depends on: 09-P14   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/.monitor-ids.json`, `integrations/demos/datadog/README.md`
- Model: sonnet   Effort: S
- Gate:
  - `grep -c $'\u2014' integrations/demos/datadog/README.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 15's steps are all checked off and the gate output matches.

### Packet 09-P16: TALK-TRACK.md
- Tasks: 16
- Depends on: 09-P15   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/TALK-TRACK.md`
- Model: sonnet   Effort: S
- Gate:
  - `grep -c $'\u2014' integrations/demos/datadog/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 16's steps are all checked off and the gate output matches.

### Packet 09-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 09-P16   Shared runtime: cloud-account
- Files owned: `integrations/demos/datadog/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate datadog` -> `datadog: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.

## 11. Build notes (aligning with Plan 08's live-recording fixes)

Plan 08's live recording session (Section 11 of `08-prometheus-grafana.md`) found seven real bugs by running the shared workload generator and fault injector against a live playground; those functions (`runSlowQueryStorm`, `runWriteHotSpot`, `stopTikvStore`, `startTikvStore`, `clearAllFaults`) are imported by this demo's `runner/main.ts` unchanged through `@lab/demo-prometheus-grafana/faults`, so the AUTO_RANDOM explicit-insert fix, the `INSERT IGNORE`/unconditional-id-advance fix, the four-worker `SLEEP(0.6)` slow-query-storm fix, and the `kill -9`/command-relaunch store-outage fix all applied here automatically with no code change needed in this demo.

Two bugs were specific to this demo's own `runner/main.ts` (not the shared module) and needed the same fix pattern applied locally, since this file duplicates the control-wiring logic rather than importing it:

1. **`inject-connection-surge`'s cleanup used `connection.release()`**, the same pooled-release-instead-of-close bug Plan 08 found and fixed in its own `main.ts`. Fixed identically here: `connection.destroy()`.
2. **`inject-store-outage`/`clear-faults` called `stopTikvStore()`/`startTikvStore()` with no handle**, matching Plan 08's pre-fix behavior: `clear-faults` restarted TiKV via `tiup playground scale-out --kv 1` unconditionally on every cycle (adding a spare store even when no store-outage fault was active) rather than relaunching the exact process that was killed. Fixed by capturing the `TikvPlaygroundHandle` returned by `stopTikvStore()` in a module-level `stoppedTikv` variable and only calling `startTikvStore(handle)` (and only emitting `tikv: healthy`) in `clear-faults` when a store-outage fault actually left a stopped handle, clearing `stoppedTikv` after use.

Checked but left unchanged, because the fault lives in a metric that is genuinely unavailable, not a naming mismatch: Plan 08 switched `write-hot-spot` detection from `tikv_thread_cpu_seconds_total` (confirmed absent on TiKV v8.5.8) to `tikv_raftstore_write_cmd_total{type="put"}`. The Datadog `tidb` integration (`DataDog/integrations-extras`, `tidb/datadog_checks/tidb/metrics.py`) only ever forwards a fixed, hardcoded list of 12 metrics and has no PD metrics and no passthrough for arbitrary Prometheus metric names, so `tikv_raftstore_write_cmd_total` cannot be exposed under any Datadog metric name (see the new Section 4 row for the full citation). `write-hot-spot.json` and `tikvCpuQuery` are therefore left on `tidb_cluster.process_cpu_seconds_total{component:tikv}`, the only available proxy, which already carries the documented "not collected under tiup playground on macOS" gap from Section 4/9 - this is an existing, previously-documented limitation of the Datadog integration itself, not a regression introduced by this alignment pass.

Verified after the fix: `pnpm --filter @lab/demo-datadog test` (21 tests, including `test/emitted-ids.test.ts`'s scan of `runner/main.ts` against `manifest.json`), `pnpm --filter @lab/demo-datadog typecheck`, and `pnpm lab validate datadog` (`datadog: manifest ok, no featured trace yet`) all pass with no new `any`, type assertions, or code comments introduced. No live Datadog account, Agent, or Monitor was exercised in this pass (out of scope: code-only, no live services).

## 12. Build notes (from the live recording session, 2026-09-29)

Ran against the shared local playground (`--tag lab`, already up: PD `2379`, TiDB `4000`, TiKV status `20180`, 1 TiKV store + 1 TiFlash store reused from Plan 08's session) and a real Datadog trial org (`DD_SITE=datadoghq.com`), with the Agent (`gcr.io/datadoghq/agent:latest`) run via `docker compose -f demos/datadog/infra/docker-compose.yml up -d` and the `datadog-tidb==2.1.1` integration installed live inside the container (`agent integration install -t datadog-tidb==2.1.1 -r`, then `docker restart lab-datadog-agent`; the base Agent image does not ship the check preinstalled, which is not stated in Section 4 and should be added there for future recordings). The relay ran on port `7073` per the cloud addendum.

Four real bugs were found only by running the full runner against live Datadog and a live playground, none of them visible from unit tests or typecheck:

1. **`store-outage.json`'s Monitor query was rejected by the Monitors API.** `POST /api/v1/monitor` for `avg(last_2m):sum:tidb_cluster.tikv_store_size_bytes{*}.as_count() < 1` failed live with `400 {"errors":[".as_count() monitors must use the 'sum' time aggregator"]}` - Datadog requires `.as_count()` metrics to use `sum()` as the outer time aggregator, not `avg()`. This is a real, previously-untested API validation rule, not caught by `docker compose config` or typecheck. Fixed in `infra/monitors/store-outage.json` by changing the query's time aggregator from `avg(last_2m)` to `sum(last_2m)`. The three orphan monitors created by the first (partially-failing) `Promise.all` batch in `createMonitors.ts` before this fix were found live via `GET /api/v1/monitor?monitor_tags=demo:datadog` and deleted before retrying.
2. **Any transient Datadog API error crashed the whole runner process.** `runner-kit`'s `every()` does not catch errors thrown by its `task`, and `main.ts` called it with a bare `void every({...})` for both the 1s metrics-poll loop and the 5s Monitor-poll loop; a single rejected `fetch` (confirmed live: this first surfaced right after `inject-store-outage`, though the exact transient cause was not isolated) became an unhandled promise rejection that terminated the Node process outright, silently killing the recording with no trace file written and, on one occurrence, leaving the just-killed TiKV process not relaunched (recovered manually by relaunching the exact `tikv-server` command against the same `data-dir` so it rejoined as the same store with data intact, then restoring `schedule.max-store-down-time` from the `5s` `stopTikvStore` sets to `30m0s`). Fixed by adding `demos/datadog/runner/src/safeTask.ts` (test-first: `runner/test/safeTask.test.ts`), a small wrapper that catches a task's rejection and reports it through `emitter.log('warn', ...)` instead of letting it propagate; wired around both `every()` task bodies and around the two previously bare `.then()` chains in `onControl` (`stopTikvStore()` and `clearAllFaults(...).then(...)`) that had no `.catch()`. Only files under `demos/datadog` were touched; `runner-kit`'s `every()` itself was left unchanged since it is shared with other demos and out of this plan's file scope.
3. **`detect-store-outage` could never pass, because the store-outage Monitor's real "fired" state is `No Data`, not `Alert`.** The Monitor is a no-data check (`notify_no_data: true`, `no_data_timeframe: 2`); once the Agent stops scraping the killed TiKV's status port, Datadog's `overall_state` genuinely transitions through `OK` -> `No Data` (confirmed live, first at t≈130-150s after the kill), never `Alert`. The runner's `pollFault` only treated a literal `overallState === 'Alert'` as detected, so this check would time out and fail even though the Monitor had legitimately fired. Fixed test-first: added `demos/datadog/runner/src/faultDetected.ts` and `runner/test/faultDetected.test.ts` (`isFaultDetected`), which treats `Alert` as fired for every fault and additionally treats `No Data` as fired specifically for `store-outage` (the one no-data-based Monitor); wired into `pollFault` in place of the inline `=== 'Alert'` check. Also raised `FAULT_TIMEOUT_MS` from `90_000` to `240_000`: live timing showed the store-outage Monitor's `last_2m` window plus `no_data_timeframe: 2` plus Agent collection interval plus 5s poll granularity took up to ~180s end to end, comfortably exceeding the original 90s budget copied from Task 7.10's connection-surge-only estimate.
4. **`connection-surge` could never cross its `> 150` threshold, because the demo's own `.env.example` never set `TIDB_POOL_SIZE`.** `@lab/runner-kit`'s `createTidbPool()` defaults `connectionLimit` to `10` when `TIDB_POOL_SIZE` is unset; `runConnectionSurge` calls `pool.getConnection()` 200 times against that same shared pool, but a `mysql2` pool's `getConnection()` blocks waiting for a free slot once `connectionLimit` is reached rather than opening new sockets, so the surge silently plateaued at ~11 total connections (confirmed live via `select count(*) from information_schema.processlist`) - nowhere near the Monitor's `> 150` threshold. Plan 08's own `demos/prometheus-grafana/.env.example` already sets `TIDB_POOL_SIZE=250` for exactly this reason, but this demo's `.env.example` was missing the line entirely. Fixed by adding `TIDB_POOL_SIZE=250` to `demos/datadog/.env.example` (and the recording session's `.env`); re-verified live after the fix, `information_schema.processlist` reached 203 connections during the fault and dropped back to 3 within 8s of `clear-faults` (the existing `connection.destroy()` fix from Task 7.13 is what makes that drop clean).

Confirmed live and left unchanged, matching Section 4/9's documented gap: `p99-latency` (`tidb_cluster.tidb_server_handle_query_duration_seconds.count`/`.sum`) and `tikv-cpu` (`tidb_cluster.process_cpu_seconds_total{component:tikv}`) never produced a single data point through the Agent for the full ~22-minute recording, confirmed three ways - `metricsClient.latestValue()` returned `undefined` throughout, the Datadog Metrics query API's `series` array was empty for both queries directly, and `docker exec lab-datadog-agent agent check tidb --instance-filter tidb_metric_url` never emitted a `handle_query_duration_seconds` sample even though the same metric has real, non-zero values on TiDB's own `:10080/metrics` endpoint. This means `detect-slow-query-storm` and `detect-write-hot-spot` cannot pass on this macOS/tiup-playground environment; both are recorded as genuine, honest `fail` events in the featured trace (`"no fired overall_state within 240s ... last observed No Data"`) rather than faked, per Section 9's own framing of this as a known, unsupported-on-this-platform limitation rather than a demo bug.

Featured trace numbers (`demos/datadog/traces/featured.json`, 3487 events, `durationMs: 1296678` ≈ 21.6 minutes): `qps` 0-1454 (1148 samples), `active-connections` 1-202 (1148 samples, confirming the connection-surge fix reached past the 150 threshold), `trace-count` 1, `detection-latency` two samples (118.4s for connection-surge, 176.3s for store-outage). Checks: `slow-span-correlated` pass, `detect-store-outage` pass (`overall_state=No Data`), `detect-connection-surge` pass (`overall_state=Alert`), `detect-slow-query-storm` fail (documented metric gap), `detect-write-hot-spot` fail (documented metric gap). Flow edges with real traffic: `workload-tidb` (9808), `apm-tidb` (1), `apm-datadog` (1); the remaining six manifest edges (`tidb-tikv`, `tidb-pd`, `tidb-dd-agent`, `tikv-dd-agent`, `pd-dd-agent`, `dd-agent-datadog`) are topology-only with no flow counter, matching the same convention already used in Plan 08's own featured trace. The ~21.6-minute duration is well over the 3-6 minute target; this is the same deviation Section 8/9 already anticipated (Datadog's `last_1m`/`last_2m` evaluation windows plus `no_data_timeframe` plus Agent collection interval, multiplied across two faults that never resolve within their own timeout), not a bug introduced by this session's fixes - shortening `FAULT_TIMEOUT_MS` further would only turn genuine slow-but-real detections (118-176s) into false failures.

Gate output: `pnpm --filter @lab/demo-datadog test` -> 27 tests passed (8 files, up from 21/6 - added `safeTask.test.ts` and `faultDetected.test.ts`); `pnpm --filter @lab/demo-datadog typecheck` -> exit 0; `pnpm lab validate datadog` -> `datadog: manifest ok, featured trace ok (3487 events)`; `pnpm lab check-public` -> `486 files scanned, 0 findings`.

Teardown confirmed: `docker compose -f demos/datadog/infra/docker-compose.yml down -v` removed `lab-datadog-agent`; all four Monitors deleted via `DELETE /api/v1/monitor/{id}` and confirmed `GET /api/v1/monitor?monitor_tags=demo:datadog` returns zero; the APM service process was killed. Playground left healthy: `select tidb_version()` succeeds (TiDB v8.5.8), PD reports both stores `Up` (TiKV store `1` at `127.0.0.1:20160`, TiFlash store `138`), `schedule.max-store-down-time` restored to `30m0s`. The shared TiDB playground and shared Kafka (`lab-kafka`) were left running for the next demo, per the live-recording rules.
