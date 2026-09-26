# Plan 07: Chalk + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a fintech ML platform team exactly where TiDB sits relative to a real-time feature platform (Chalk): TiDB is the strongly consistent system of record and the fresh-aggregate engine; Chalk is the layer that turns SQL against TiDB into named, cached, servable features. The audience watches the same fraud features (transaction velocity, spend, merchant diversity) computed two ways at once - through Chalk's online query API and through a direct SQL baseline against TiDB - and sees them agree, and sees a fraud flag flip within seconds of a burst of transactions.

**Architecture:** A Python runner writes transactions into TiDB (the system of record), then on every tick issues (a) a Chalk online query for a `User`'s fraud features, resolved by Chalk SQL resolvers that run parameterized SQL against TiDB through Chalk's MySQL data source, and (b) the same aggregates computed by a direct SQL query against TiDB, bypassing Chalk entirely. The runner times both paths, diffs their values for the correctness check, and emits `metric`/`flow`/`check` events. Chalk's feature and resolver definitions live in a separate `chalk/` sub-project deployed with the Chalk CLI; the runner only talks to Chalk over its online query API.

**Tech Stack:** Python 3.11+ runner using `lab_runner` (Python runner-kit), pymysql via `tidb_connect_from_env`, `chalkpy` (`chalk.client.ChalkClient`) for online queries, pytest for pure-logic tests. Chalk feature/resolver definitions in Python (`chalk.features`, SQL file resolvers) deployed via the Chalk CLI (`chalk apply`).

**Depends on:** Plan 00 (platform).

---

## 1. Why this demo

- **The question customers ask:** "We already have Chalk (or a similar feature platform) computing our fraud features - why would we also need TiDB, and isn't a key-value store like DynamoDB/Redis enough for the metrics feeding our model?"
- **Pattern:** fintech ML platform team asking where TiDB fits versus a real-time feature platform (Chalk) and versus a key-value metric store.
- **What TiDB proves here:**
  - TiDB is a transactional, strongly consistent system of record for the raw events (transactions) that features are computed from - a key-value metric store has nowhere to put the source rows or run ad hoc SQL against them.
  - TiDB can answer the same windowed aggregate SQL that Chalk's resolvers issue, directly and fast, which is why Chalk's SQL resolvers can point at it in the first place (HTAP: the same cluster takes the transactional writes and the aggregate reads).
  - Freshness is provable: a transaction written to TiDB is reflected in both the Chalk-served feature and the direct-SQL baseline within a bounded, measured lag - not "eventually," but on a stopwatch the audience watches.
  - The boundary is real and complementary: Chalk owns feature naming, caching (`max_staleness`), online/offline consistency, and the serving API; TiDB owns the durable, queryable, consistent data underneath all of that.
- **What this demo does not claim:**
  - It does not claim TiDB replaces Chalk's online store, caching layer, point-in-time training-data generation, or feature governance - those are Chalk's job and this demo does not attempt to rebuild them.
  - It does not claim official TiDB support inside Chalk's product; Chalk's MySQL data source is being pointed at TiDB because TiDB speaks the MySQL wire protocol, and this compatibility is verified empirically in Task 10, not asserted from a support matrix (see Section 4).
  - It does not benchmark Chalk's own internal resolver execution time; `resolver-sql-baseline-p99` measures the same SQL run directly by the runner, which is a proxy for resolver cost, not an instrumented measurement of Chalk's internals (see Section 4).

## 2. What the audience sees

### Flow diagram

```
[generator]  --transaction writes-->   [tidb]
 (source)                             (tidb, x=50 y=50)
                                        |          \
                              resolver SQL       baseline SQL
                                        v               v
                                    [chalk]        [baseline]
                                  (service,        (service,
                                   x=78 y=20)       x=78 y=80)
                                        \               /
                                   online queries   baseline queries
                                          \           /
                                           v         v
                                          [client]
                                     (client, x=95 y=50)
```

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | seed | Seed data | Runner creates the `users` and `transactions` tables in TiDB and seeds a set of users with a history of ordinary transactions. | "We start with a normal book of transactions in TiDB - this is the system of record, nothing Chalk-specific about it yet." |
| 2 | steady-state | Steady state | Runner writes transactions at a steady rate; every tick it asks Chalk for `txn_count_1h`, `amount_sum_24h`, `distinct_merchants_24h`, `velocity_flag` for a sampled user, and separately runs the same aggregates directly against TiDB. | "Chalk is answering feature queries here by running SQL resolvers against TiDB. We're also running the exact same SQL ourselves, live, so you can see the two agree." |
| 3 | velocity-burst | Velocity burst | The `velocity-burst` control fires a rapid burst of transactions for one user. The runner polls until the Chalk-served `velocity_flag` flips to `true`. | "Watch one user's card get used sixty times in ninety seconds. That's TiDB taking the write load, and Chalk's feature flipping the moment the SQL resolver sees it." |
| 4 | staleness-knob | Staleness knob | The `tighten-staleness` control toggles the query-time `max_staleness` override Chalk is asked for between a cached window and `0s` (cache-busted), showing the latency and cache-hit-rate tradeoff. | "This is the caching knob that's entirely Chalk's job - not TiDB's. Loosen it and queries get cheaper and staler; tighten it and every query re-runs the SQL resolver against TiDB." |
| 5 | wrapup | Wrap-up | Runner stops the workload, prints a summary of the run's checks and metrics, and exits cleanly. | "TiDB was the source of truth and the aggregate engine the whole time. Chalk gave us naming, caching, and a serving API on top of it." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `velocity-burst` | Fire velocity burst | Inserts 60 transactions for one designated "burst user" into TiDB over roughly 90 seconds, then polls the Chalk online query for that user's `velocity_flag` every 500 ms until it reads `true` or a 30 s timeout elapses, emitting the `fraud-flip` check. |
| `tighten-staleness` | Toggle staleness (cached / fresh) | Flips a boolean in the runner between requesting Chalk queries with the feature-level default `max_staleness` (cached path) and an explicit `staleness` override of `0s` for every output feature (fully fresh, cache-busted path); the next tick's metrics reflect the new mode. |
| `burst-writes` | Burst write rate | Raises the transaction-generator's write rate for 20 seconds (steady-state rate x10, spread across many users, not just the burst user) so `tidb-write-rate` visibly spikes without triggering the single-user fraud flag. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `feature-parity` | Chalk feature equals direct-SQL baseline | On each steady-state tick, the runner compares the Chalk-served `txn_count_1h`, `amount_sum_24h`, and `distinct_merchants_24h` for the sampled user against the values computed by its own direct SQL query against TiDB for the same user and the same `${now}` timestamp; `pass` when all three match exactly (integers) or within 1e-6 (the float sum), `fail` otherwise, with `observed` set to the two value sets. |
| `fraud-flip` | Velocity flag flips within the burst | Starting when the `velocity-burst` control event is received, the runner polls the Chalk-served `velocity_flag` for the burst user every 500 ms; `pass` with `observed` set to the elapsed seconds if it reads `true` within 30 s of the burst starting, `fail` with `observed` set to `"timed out after 30s"` otherwise. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `chalk-query-p50` | Chalk online query p50 | ms | series | lower | `lab_runner.timed()` wraps every `ChalkClient.query(...)` call issued in the tick; samples collected in a `SampleWindow`, drained and passed to `lab_runner.summarize()` once per 1000 ms tick; the `.p50` field of the result is emitted. |
| `chalk-query-p99` | Chalk online query p99 | ms | series | lower | Same sample window as `chalk-query-p50`; the `.p99` field of `summarize()` is emitted. |
| `baseline-sql-p99` | Direct-SQL baseline p99 | ms | series | lower | `lab_runner.timed()` wraps the runner's own direct SQL query (the same three aggregate `SELECT`s Chalk's resolvers run, built by `build_baseline_query`, Section 7 Task 3) executed over the pooled TiDB connection from `tidb_connect_from_env`; `.p99` of `summarize()` over the tick's samples is emitted. |
| `freshness-lag-ms` | Write-to-feature freshness lag | ms | both | lower | For each transaction the generator writes, the runner records the write's commit-return wall-clock time (`emitter.elapsed_ms()` immediately after the `INSERT` returns), then issues a cache-busted Chalk query (`staleness` override `"0s"` on every output feature) once per 100 ms until the returned `txn_count_1h` includes that transaction (the count strictly increases past its pre-write value), and emits `freshness_lag_ms(write_ts, observed_ts)` (Section 7 Task 4) as the elapsed milliseconds between the two timestamps. |
| `tidb-write-rate` | TiDB write rate | rows/s | series | higher | Runner counts `INSERT` rows committed to `transactions` since the previous tick (its own counter, incremented once per successful insert) and divides by the tick interval in seconds (1.0). |
| `cache-hit-rate` | Chalk cache hit rate | % | tile | higher | Fraction of the tick's `ChalkClient.query(..., include_meta=True)` calls whose response `meta`/`FeatureResolutionMeta` indicates the value came from the online store rather than a fresh resolver run. **UNVERIFIED**: the exact JSON field name for this indicator was not confirmed against a live response (see Section 4); Task 11 confirms the field name against Chalk's actual response before this metric is wired into the emitter, and the manifest/runner code is written so only the one field-name constant in `chalk_client.py` needs to change once confirmed. |
| `fraud-flag-flip-s` | Fraud flag flip latency | s | tile | lower | Seconds between the `control` event timestamp for `velocity-burst` and the tick at which the Chalk-served `velocity_flag` for the burst user first reads `true`, as measured by the `fraud-flip` check's polling loop (Section 2 Checks table); emitted once per burst run. |

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| Chalk lists MySQL as a "Native" SQL data source with a C++ integration, alongside PostgreSQL, ClickHouse, Presto/Trino, DuckDB. | https://docs.chalk.ai/docs/integrations | Verified |
| Chalk's MySQL source is configured with `from chalk.sql import MySQLSource; risk = MySQLSource(name="RISK")`, referenced in `.chalk.sql` resolver files via `-- source: RISK`; named integrations inject environment variables prefixed by the integration name, e.g. `RISK_MYSQL_HOST`. | https://docs.chalk.ai/docs/mysql | Verified |
| TiDB itself is not named anywhere in Chalk's docs as a supported or tested MySQL-protocol target. Chalk's MySQL source is being pointed at TiDB on the strength of MySQL wire-protocol compatibility alone. | Absence confirmed by reviewing https://docs.chalk.ai/docs/integrations and https://docs.chalk.ai/docs/mysql | **UNVERIFIED** - confirm empirically in Task 10 by configuring a `MySQLSource` against a running `tiup playground` TiDB instance and running a real SQL resolver query end to end before building anything further on top of it. |
| The full set of environment variables a `MySQLSource` integration expects (beyond the confirmed `<NAME>_MYSQL_HOST` pattern - e.g. port, user, password, database names) is set via the Chalk dashboard "Add a data source" form, not fully enumerated in the docs page fetched. | https://docs.chalk.ai/docs/mysql | **UNVERIFIED** - confirm the exact variable names in the dashboard's MySQL integration form during Task 9, before writing `.env.example`. |
| SQL file resolvers use `.chalk.sql` files with YAML-parsed leading comments (`-- type:`, `-- resolves:`, `-- source:`), support `${feature.path}` and the special `${now}` argument for parameterization, and Chalk automatically pushes query inputs into the `WHERE` clause ("push-down filtering"). | https://docs.chalk.ai/docs/sql | Verified |
| Feature classes are defined with `@features` from `chalk.features`; online resolvers use the `@online` decorator from `chalk` (or `chalk.features`) with plain Python type annotations for inputs and outputs, e.g. `@online def f(x: User.x) -> User.y: ...`. | https://docs.chalk.ai/docs/resolver-overview, https://docs.chalk.ai/docs/query-online | Verified |
| Windowed aggregation features (`Windowed[int]`, `windowed(...)`, `_.chalk_window`, `_.chalk_now`) exist as a first-class alternative to SQL resolvers for time-windowed features. This demo intentionally uses SQL file resolvers instead (per the assignment), not this mechanism, so its exact expression-operator semantics are not depended on. | https://docs.chalk.ai/docs/aggregations | Verified (noted, not used) |
| The Python client is `chalkpy` (`pip install chalkpy`, Python 3.10-3.13), imported as `from chalk.client import ChalkClient`, constructed with `ChalkClient(client_id=..., client_secret=...)`, and queried with `client.query(input={...}, output=[...])` (some docs pages show `inputs`/`outputs` instead of `input`/`output` - both spellings appear across the docs; Task 11 confirms which the installed `chalkpy` version accepts before the runner is finalized). | https://docs.chalk.ai/docs/client-python, https://docs.chalk.ai/docs/query-online, https://docs.chalk.ai/docs/online-authentication | Verified (import/construction); **UNVERIFIED** exact parameter name `input` vs `inputs` - confirm against installed `chalkpy`'s function signature in Task 11. |
| Authentication uses OAuth client-credentials: a `client_id`/`client_secret` pair created as a service token in the Chalk dashboard, exchanged for an access token by the client library; `CHALK_CLIENT_ID`/`CHALK_CLIENT_SECRET` environment variables are a documented convention. | https://docs.chalk.ai/docs/online-authentication | Verified |
| A query response's `meta` field (`FeatureResolutionMeta`) carries "metadata pertaining to the feature, including the resolver run and whether the result was a cache hit," but the exact JSON/attribute field name for the cache-hit boolean was not shown on the pages fetched. | https://docs.chalk.ai/docs/query-basics | Verified (capability); **UNVERIFIED** exact field name - confirm in Task 11 by calling `client.query(..., include_meta=True)` against a real deployment and inspecting the returned object. |
| By default, Chalk features are not cached (`max_staleness` defaults to `0s` equivalent - recomputed every request); setting `max_staleness` on a feature caches it in the online store; a query can override staleness per feature via `staleness={...}` (Python) / `--staleness` (CLI), and `"0s"` busts the cache. | https://docs.chalk.ai/docs/feature-caching, https://docs.chalk.ai/docs/query-caching | Verified |
| Chalk offers two deployment models: "Chalk Cloud" (Chalk-hosted) and "Customer Cloud" (customer runs the data plane in their own cloud, Chalk runs the metadata plane, or both planes can be self-hosted). | https://chalk.ai/blog/deploy-in-your-cloud (via search summary), https://docs.chalk.ai/docs/deployment | Verified (deployment models exist); exact steps to provision either for this demo are **UNVERIFIED** - see Section 5. |
| Getting started requires an existing Chalk project/account (`chalk init`, `chalk login`, a dashboard "Projects" page) and the marketing site's primary CTAs are "Login" and "Book Demo"; no self-serve signup flow (e.g. a public "Sign up free" form) was found on the pages fetched. | https://docs.chalk.ai/docs/getting-started, https://chalk.ai/ | **UNVERIFIED** - see Section 5 for the exact request-access step to confirm before Task 9. |
| Chalk's online query REST endpoint is `POST https://api.chalk.ai/v1/query/online`, taking `inputs`, `outputs`, `staleness` (map of feature to duration), and an optional `context` (`environment`, `tags`, `branch`, ...); the response has `data: FeatureResult[]` plus optional `meta`. | https://docs.chalk.ai/docs/query-basics | Verified |

## 5. Prerequisites, cost, and teardown

- Accounts and access:
  - A Chalk project and a service token (`client_id`/`client_secret`) scoped to an environment. **UNVERIFIED** exact self-serve path to obtain one - the docs describe `chalk login` against an existing project and a dashboard "Projects" page, and the marketing site's CTAs are "Login" / "Book Demo". Confirm before Task 9 by visiting `https://chalk.ai` and either following "Book Demo" or checking for a self-serve signup at `https://dashboard.chalk.ai`; if only sales-gated access exists, request a trial/sandbox environment through that channel and record the actual steps here once known.
  - Everything through Task 8 (TiDB schema, seed data, workload generator, direct-SQL baseline) needs no Chalk access at all and can be built and tested first.
- Local tools: `tiup` (TiDB playground), Docker Desktop (not required for this demo specifically - no Kafka/queue component), `python3` (3.11+), `pip`, the Chalk CLI (`curl -s -L https://api.chalk.ai/install.sh | sh`), `pnpm`/Node 22 (for the shared `@lab/contract` manifest test only).
- Cost model: TiDB via `tiup playground` is local and free. Chalk's pricing is not published with numbers in its docs; point to `https://chalk.ai` and the account team reached via "Book Demo" for current pricing and any trial-environment terms - no price, quota, or plan name is hardcoded in this plan or its generated files.
- Teardown: `tiup clean lab` removes the local TiDB data directory. For Chalk, deactivate or delete the demo's branch/environment from the Chalk dashboard (Settings > Service Tokens to revoke the token used; Environments to remove the demo environment) - **UNVERIFIED** exact CLI command for deleting a branch/environment; confirm via `chalk --help` once CLI access exists, and record the exact command here before recording the featured trace.

## 6. File structure

```
demos/chalk/
  manifest.json                     DemoManifestSchema-valid manifest for this demo (Section 2/3 as data)
  package.json                      "@lab/demo-chalk", depends on @lab/contract + @lab/runner-kit (workspace:*)
  tsconfig.json                     extends ../../tsconfig.base.json (only used by test/manifest.test.ts)
  README.md                         what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md                     presenter script per phase, discovery questions, objections and answers
  .env.example                      standard TIDB_*/LAB_ENV_* block plus CHALK_CLIENT_ID/CHALK_CLIENT_SECRET/CHALK_ENVIRONMENT/CHALK_API_HOST and RISK_MYSQL_* (Task 9's confirmed names)
  test/
    manifest.test.ts                parses manifest.json with DemoManifestSchema (TypeScript, uses @lab/contract, per platform contract)
  chalk/                            the Chalk project deployed with the Chalk CLI (not run by the relay)
    chalk.yaml                      Chalk project config (created by `chalk init`, project name set to match the dashboard project)
    requirements.txt                chalkpy pinned to the version installed in Task 9
    src/
      user.py                      User feature class: id, txn_count_1h, amount_sum_24h, distinct_merchants_24h, velocity_flag
      resolvers/
        txn_count_1h.chalk.sql     SQL file resolver, source RISK (MySQLSource -> TiDB), parameterized on ${user.id} and ${now}
        amount_sum_24h.chalk.sql   SQL file resolver, same source, sums amount over the last 24h
        distinct_merchants_24h.chalk.sql  SQL file resolver, same source, counts distinct merchant_id over the last 24h
        velocity_flag.py           Python resolver combining txn_count_1h into a boolean flag against a fixed threshold
  runner/
    main.py                        entry point: wires phases, controls, emitter, and the tick loop
    src/
      __init__.py
      schema.py                    DDL strings for `users` and `transactions` tables (pure data, no I/O)
      baseline_sql.py               PURE: build_baseline_query(feature_id, user_id, now) -> (sql, params)
      freshness.py                 PURE: freshness_lag_ms(write_ts_ms, observed_ts_ms) -> int
      velocity.py                  PURE: evaluate_velocity_flag(txn_count_1h, threshold) -> bool
      workload.py                  PURE: next_transaction(user_id, tick, rate_state) -> TransactionRow (frozen dataclass)
      tidb_io.py                   I/O: seed_users, insert_transaction, run_baseline_query (uses tidb_connect_from_env)
      chalk_io.py                  I/O: thin wrapper around ChalkClient.query for the four output features
    test/
      test_baseline_sql.py         pytest for build_baseline_query
      test_freshness.py            pytest for freshness_lag_ms
      test_velocity.py             pytest for evaluate_velocity_flag
      test_workload.py             pytest for next_transaction
  traces/
    featured.json                  committed after Section 8 recording (gitignored otherwise)
```


## 7. Tasks

### Task 1: Scaffold the demo package

- [ ] Create `demos/chalk/package.json`:

```json
{
  "name": "@lab/demo-chalk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*"
  }
}
```

- [ ] Create `demos/chalk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["test/**/*.ts"]
}
```

- [ ] Create `demos/chalk/.env.example`:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=

CHALK_CLIENT_ID=
CHALK_CLIENT_SECRET=
CHALK_ENVIRONMENT=dev
CHALK_API_HOST=https://api.chalk.ai

RISK_MYSQL_HOST=127.0.0.1
RISK_MYSQL_PORT=4000
RISK_MYSQL_USER=root
RISK_MYSQL_PASSWORD=
RISK_MYSQL_DATABASE=lab
```

`RISK_MYSQL_*` values are placeholders confirmed against the Chalk dashboard's MySQL integration form in Task 9 (see Section 4's UNVERIFIED note on the full variable list); if the dashboard requires different names, update this file to match exactly before Task 9's `chalk apply`.

- [ ] Run: `ls demos/chalk` - expected: `package.json`, `tsconfig.json`, `.env.example` present. This is scaffolding, not logic, so there is no failing test for this task.
- [ ] Commit: `git add demos/chalk/package.json demos/chalk/tsconfig.json demos/chalk/.env.example && git commit -m "chalk demo: scaffold package"`

### Task 2: Manifest and its validation test

- [ ] Write the failing test first, `demos/chalk/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DemoManifestSchema } from '@lab/contract';

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));

describe('chalk demo manifest', () => {
  it('parses as a valid DemoManifest', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const result = DemoManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('has exactly the four checks and controls this plan documents', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const manifest = DemoManifestSchema.parse(raw);
    expect(manifest.checks.map((c) => c.id).sort()).toEqual(['feature-parity', 'fraud-flip']);
    expect(manifest.controls.map((c) => c.id).sort()).toEqual([
      'burst-writes',
      'tighten-staleness',
      'velocity-burst',
    ]);
  });
});
```

- [ ] Run: `pnpm --filter @lab/demo-chalk test` - expected FAIL: `ENOENT: no such file or directory, open '.../demos/chalk/manifest.json'` (the file does not exist yet).

- [ ] Create `demos/chalk/manifest.json`:

```json
{
  "id": "chalk",
  "number": 7,
  "title": "Fraud Features: TiDB as the System of Record Behind a Feature Platform",
  "tagline": "Chalk resolvers read fresh TiDB aggregates for online fraud features, checked live against direct SQL.",
  "integrations": ["chalk", "mysql-protocol"],
  "pattern": "fintech ML platform team asking where TiDB fits versus a real-time feature platform (Chalk) and versus a key-value metric store.",
  "publish": true,
  "runner": {
    "command": ["python3", "main.py"],
    "cwd": "runner"
  },
  "nodes": [
    { "id": "generator", "label": "Transaction generator", "kind": "source", "x": 10, "y": 20 },
    { "id": "tidb", "label": "TiDB", "kind": "tidb", "x": 50, "y": 50 },
    { "id": "chalk", "label": "Chalk feature platform", "kind": "service", "x": 78, "y": 20 },
    { "id": "baseline", "label": "Direct-SQL baseline", "kind": "service", "x": 78, "y": 80 },
    { "id": "client", "label": "Fraud-check client", "kind": "client", "x": 95, "y": 50 }
  ],
  "edges": [
    { "id": "writes", "from": "generator", "to": "tidb", "label": "transaction writes", "unit": "rows/s" },
    { "id": "resolver-sql", "from": "tidb", "to": "chalk", "label": "resolver SQL", "unit": "rows/s" },
    { "id": "baseline-sql", "from": "tidb", "to": "baseline", "label": "baseline SQL", "unit": "rows/s" },
    { "id": "online-queries", "from": "chalk", "to": "client", "label": "online queries", "unit": "req/s" },
    { "id": "baseline-queries", "from": "baseline", "to": "client", "label": "baseline queries", "unit": "req/s" }
  ],
  "metrics": [
    {
      "id": "chalk-query-p50",
      "label": "Chalk online query p50",
      "unit": "ms",
      "display": "series",
      "better": "lower",
      "howMeasured": "lab_runner.timed() wraps every ChalkClient.query call issued in the tick; samples are drained through lab_runner.summarize() once per 1000ms tick and the p50 field is emitted."
    },
    {
      "id": "chalk-query-p99",
      "label": "Chalk online query p99",
      "unit": "ms",
      "display": "series",
      "better": "lower",
      "howMeasured": "Same sample window as chalk-query-p50; the p99 field of summarize() is emitted."
    },
    {
      "id": "baseline-sql-p99",
      "label": "Direct-SQL baseline p99",
      "unit": "ms",
      "display": "series",
      "better": "lower",
      "howMeasured": "lab_runner.timed() wraps the runner's own direct SQL query built by build_baseline_query and executed over the pooled TiDB connection; p99 of summarize() over the tick's samples is emitted."
    },
    {
      "id": "freshness-lag-ms",
      "label": "Write-to-feature freshness lag",
      "unit": "ms",
      "display": "both",
      "better": "lower",
      "howMeasured": "freshness_lag_ms(write_ts_ms, observed_ts_ms) is computed between a transaction's commit-return timestamp and the first cache-busted (staleness=0s) Chalk query whose txn_count_1h reflects it, polled every 100ms."
    },
    {
      "id": "tidb-write-rate",
      "label": "TiDB write rate",
      "unit": "rows/s",
      "display": "series",
      "better": "higher",
      "howMeasured": "Count of transaction INSERT rows committed since the previous tick, divided by the 1.0s tick interval."
    },
    {
      "id": "cache-hit-rate",
      "label": "Chalk cache hit rate",
      "unit": "%",
      "display": "tile",
      "better": "higher",
      "howMeasured": "Fraction of the tick's ChalkClient.query(include_meta=True) calls whose response meta indicates the value was served from the online store rather than a fresh resolver run; exact response field name confirmed in Task 11 before this metric is wired up (see Section 4)."
    },
    {
      "id": "fraud-flag-flip-s",
      "label": "Fraud flag flip latency",
      "unit": "s",
      "display": "tile",
      "better": "lower",
      "howMeasured": "Seconds between the velocity-burst control event timestamp and the tick at which the Chalk-served velocity_flag for the burst user first reads true, from the fraud-flip check's polling loop."
    }
  ],
  "phases": [
    { "id": "seed", "label": "Seed data", "narration": "We start with a normal book of transactions in TiDB - this is the system of record, nothing Chalk-specific about it yet." },
    { "id": "steady-state", "label": "Steady state", "narration": "Chalk is answering feature queries here by running SQL resolvers against TiDB. We're also running the exact same SQL ourselves, live, so you can see the two agree." },
    { "id": "velocity-burst", "label": "Velocity burst", "narration": "Watch one user's card get used sixty times in ninety seconds. That's TiDB taking the write load, and Chalk's feature flipping the moment the SQL resolver sees it." },
    { "id": "staleness-knob", "label": "Staleness knob", "narration": "This is the caching knob that's entirely Chalk's job, not TiDB's. Loosen it and queries get cheaper and staler; tighten it and every query re-runs the SQL resolver against TiDB." },
    { "id": "wrapup", "label": "Wrap-up", "narration": "TiDB was the source of truth and the aggregate engine the whole time. Chalk gave us naming, caching, and a serving API on top of it." }
  ],
  "checks": [
    { "id": "feature-parity", "label": "Chalk feature equals direct-SQL baseline", "description": "The Chalk-served txn_count_1h, amount_sum_24h, and distinct_merchants_24h for the sampled user match the runner's own direct SQL query against TiDB for the same user and timestamp." },
    { "id": "fraud-flip", "label": "Velocity flag flips within the burst", "description": "The Chalk-served velocity_flag for the burst user reads true within 30 seconds of the velocity-burst control firing." }
  ],
  "controls": [
    { "id": "velocity-burst", "label": "Fire velocity burst", "description": "Inserts 60 transactions for one designated burst user over about 90 seconds, then polls until velocity_flag flips true or 30s elapses." },
    { "id": "tighten-staleness", "label": "Toggle staleness (cached / fresh)", "description": "Flips Chalk queries between the feature-level default max_staleness and an explicit 0s override on every output feature." },
    { "id": "burst-writes", "label": "Burst write rate", "description": "Raises the transaction generator's write rate tenfold across many users for 20 seconds." }
  ]
}
```

- [ ] Run: `pnpm --filter @lab/demo-chalk test` - expected PASS: both tests green.
- [ ] Commit: `git add demos/chalk/manifest.json demos/chalk/test/manifest.test.ts && git commit -m "chalk demo: add manifest and validation test"`

### Task 3: Pure logic - baseline SQL builder

- [ ] Write the failing test first, `demos/chalk/runner/test/test_baseline_sql.py`:

```python
from datetime import datetime, timezone

from src.baseline_sql import build_baseline_query


def test_txn_count_1h_query_and_params():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    sql, params = build_baseline_query("txn-count-1h", user_id=42, now=now)
    assert "count(*)" in sql.lower()
    assert "transactions" in sql.lower()
    assert params == {"user_id": 42, "window_start": datetime(2026, 1, 1, 11, 0, 0, tzinfo=timezone.utc)}


def test_amount_sum_24h_query_and_params():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    sql, params = build_baseline_query("amount-sum-24h", user_id=7, now=now)
    assert "sum(amount)" in sql.lower()
    assert params["window_start"] == datetime(2025, 12, 31, 12, 0, 0, tzinfo=timezone.utc)


def test_distinct_merchants_24h_query_and_params():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    sql, params = build_baseline_query("distinct-merchants-24h", user_id=7, now=now)
    assert "count(distinct merchant_id)" in sql.lower()
    assert params["window_start"] == datetime(2025, 12, 31, 12, 0, 0, tzinfo=timezone.utc)


def test_unknown_feature_id_raises():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    try:
        build_baseline_query("not-a-real-feature", user_id=1, now=now)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "not-a-real-feature" in str(exc)
```

- [ ] Run: `cd demos/chalk/runner && python3 -m pytest test/test_baseline_sql.py` - expected FAIL: `ModuleNotFoundError: No module named 'src.baseline_sql'`.

- [ ] Create `demos/chalk/runner/src/baseline_sql.py`:

```python
from datetime import datetime, timedelta
from typing import Any

_WINDOWS: dict[str, timedelta] = {
    "txn-count-1h": timedelta(hours=1),
    "amount-sum-24h": timedelta(hours=24),
    "distinct-merchants-24h": timedelta(hours=24),
}

_SELECTS: dict[str, str] = {
    "txn-count-1h": "select count(*) as value from transactions where user_id = %(user_id)s and created_at > %(window_start)s",
    "amount-sum-24h": "select coalesce(sum(amount), 0) as value from transactions where user_id = %(user_id)s and created_at > %(window_start)s",
    "distinct-merchants-24h": "select count(distinct merchant_id) as value from transactions where user_id = %(user_id)s and created_at > %(window_start)s",
}


def build_baseline_query(feature_id: str, user_id: int, now: datetime) -> tuple[str, dict[str, Any]]:
    if feature_id not in _WINDOWS:
        raise ValueError(f"unknown baseline feature id: {feature_id}")
    window_start = now - _WINDOWS[feature_id]
    return _SELECTS[feature_id], {"user_id": user_id, "window_start": window_start}
```

- [ ] Run: `cd demos/chalk/runner && python3 -m pytest test/test_baseline_sql.py` - expected PASS: 4 passed.
- [ ] Commit: `git add demos/chalk/runner/src/baseline_sql.py demos/chalk/runner/test/test_baseline_sql.py && git commit -m "chalk demo: TDD baseline SQL builder"`

### Task 4: Pure logic - freshness lag

- [ ] Write the failing test first, `demos/chalk/runner/test/test_freshness.py`:

```python
from src.freshness import freshness_lag_ms


def test_lag_is_difference_in_milliseconds():
    assert freshness_lag_ms(write_ts_ms=1_000, observed_ts_ms=1_450) == 450


def test_lag_is_zero_when_observed_equals_write():
    assert freshness_lag_ms(write_ts_ms=2_000, observed_ts_ms=2_000) == 0


def test_negative_lag_raises():
    try:
        freshness_lag_ms(write_ts_ms=2_000, observed_ts_ms=1_000)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "observed_ts_ms" in str(exc)
```

- [ ] Run: `cd demos/chalk/runner && python3 -m pytest test/test_freshness.py` - expected FAIL: `ModuleNotFoundError: No module named 'src.freshness'`.

- [ ] Create `demos/chalk/runner/src/freshness.py`:

```python
def freshness_lag_ms(write_ts_ms: int, observed_ts_ms: int) -> int:
    if observed_ts_ms < write_ts_ms:
        raise ValueError("observed_ts_ms must not precede write_ts_ms")
    return observed_ts_ms - write_ts_ms
```

- [ ] Run: `cd demos/chalk/runner && python3 -m pytest test/test_freshness.py` - expected PASS: 3 passed.
- [ ] Commit: `git add demos/chalk/runner/src/freshness.py demos/chalk/runner/test/test_freshness.py && git commit -m "chalk demo: TDD freshness lag calculation"`

### Task 5: Pure logic - velocity flag evaluation

- [ ] Write the failing test first, `demos/chalk/runner/test/test_velocity.py`:

```python
from src.velocity import VELOCITY_THRESHOLD, evaluate_velocity_flag


def test_flag_false_below_threshold():
    assert evaluate_velocity_flag(txn_count_1h=VELOCITY_THRESHOLD - 1) is False


def test_flag_true_at_threshold():
    assert evaluate_velocity_flag(txn_count_1h=VELOCITY_THRESHOLD) is True


def test_flag_true_above_threshold():
    assert evaluate_velocity_flag(txn_count_1h=VELOCITY_THRESHOLD + 10) is True


def test_custom_threshold_overrides_default():
    assert evaluate_velocity_flag(txn_count_1h=3, threshold=3) is True
    assert evaluate_velocity_flag(txn_count_1h=2, threshold=3) is False
```

- [ ] Run: `cd demos/chalk/runner && python3 -m pytest test/test_velocity.py` - expected FAIL: `ModuleNotFoundError: No module named 'src.velocity'`.

- [ ] Create `demos/chalk/runner/src/velocity.py`:

```python
VELOCITY_THRESHOLD = 10


def evaluate_velocity_flag(txn_count_1h: int, threshold: int = VELOCITY_THRESHOLD) -> bool:
    return txn_count_1h >= threshold
```

- [ ] Run: `cd demos/chalk/runner && python3 -m pytest test/test_velocity.py` - expected PASS: 4 passed.
- [ ] Commit: `git add demos/chalk/runner/src/velocity.py demos/chalk/runner/test/test_velocity.py && git commit -m "chalk demo: TDD velocity flag threshold"`

### Task 6: Pure logic - transaction generator

- [ ] Write the failing test first, `demos/chalk/runner/test/test_workload.py`:

```python
from src.workload import TransactionRow, next_transaction


def test_steady_state_produces_one_row_for_designated_user():
    row = next_transaction(user_id=1, tick=5, merchant_pool=["m1", "m2"], amount_cents=1234, burst=False)
    assert isinstance(row, TransactionRow)
    assert row.user_id == 1
    assert row.merchant_id in ("m1", "m2")
    assert row.amount_cents == 1234


def test_burst_mode_marks_the_row():
    row = next_transaction(user_id=9, tick=1, merchant_pool=["m1"], amount_cents=500, burst=True)
    assert row.burst is True


def test_merchant_pool_must_be_non_empty():
    try:
        next_transaction(user_id=1, tick=0, merchant_pool=[], amount_cents=100, burst=False)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "merchant_pool" in str(exc)


def test_row_is_immutable():
    row = next_transaction(user_id=1, tick=0, merchant_pool=["m1"], amount_cents=100, burst=False)
    try:
        row.amount_cents = 999  # type: ignore[misc]
        assert False, "expected FrozenInstanceError"
    except Exception:
        pass
```

- [ ] Run: `cd demos/chalk/runner && python3 -m pytest test/test_workload.py` - expected FAIL: `ModuleNotFoundError: No module named 'src.workload'`.

- [ ] Create `demos/chalk/runner/src/workload.py`:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class TransactionRow:
    user_id: int
    tick: int
    merchant_id: str
    amount_cents: int
    burst: bool


def next_transaction(
    user_id: int,
    tick: int,
    merchant_pool: list[str],
    amount_cents: int,
    burst: bool,
) -> TransactionRow:
    if not merchant_pool:
        raise ValueError("merchant_pool must be non-empty")
    merchant_id = merchant_pool[tick % len(merchant_pool)]
    return TransactionRow(
        user_id=user_id,
        tick=tick,
        merchant_id=merchant_id,
        amount_cents=amount_cents,
        burst=burst,
    )
```

- [ ] Run: `cd demos/chalk/runner && python3 -m pytest test/test_workload.py` - expected PASS: 4 passed.
- [ ] Commit: `git add demos/chalk/runner/src/workload.py demos/chalk/runner/test/test_workload.py && git commit -m "chalk demo: TDD transaction generator"`

### Task 7: Manual - TiDB schema (thin I/O, no TDD)

- [ ] Start local TiDB: `infra/tidb/playground.sh` (from Plan 00). Wait for the line reporting the connect command, and record the printed TiDB version for `LAB_ENV_TIDB` later.
- [ ] Create `demos/chalk/runner/src/schema.py`:

```python
USERS_DDL = """
create table if not exists users (
    id bigint primary key,
    name varchar(128) not null
)
"""

TRANSACTIONS_DDL = """
create table if not exists transactions (
    id bigint auto_increment primary key,
    user_id bigint not null,
    merchant_id varchar(64) not null,
    amount decimal(12, 2) not null,
    created_at timestamp(3) not null default current_timestamp(3),
    key idx_user_created (user_id, created_at)
)
"""
```

- [ ] Run, using the standard `.env.example` values against the local playground:

```
mysql -h 127.0.0.1 -P 4000 -u root -e "create database if not exists lab;"
mysql -h 127.0.0.1 -P 4000 -u root lab -e "$(python3 -c 'from demos.chalk.runner.src.schema import USERS_DDL, TRANSACTIONS_DDL; print(USERS_DDL); print(TRANSACTIONS_DDL)')"
mysql -h 127.0.0.1 -P 4000 -u root lab -e "show tables;"
```

Expected output: `show tables` lists `transactions` and `users`.
- [ ] Commit: `git add demos/chalk/runner/src/schema.py && git commit -m "chalk demo: TiDB schema for users and transactions"`

### Task 8: Manual - seed data and transaction writer (thin I/O)

- [ ] Create `demos/chalk/runner/src/tidb_io.py`:

```python
from datetime import datetime, timezone
from typing import Any

from lab_runner import tidb_connect_from_env

from src.baseline_sql import build_baseline_query
from src.workload import TransactionRow


def seed_users(env: dict[str, str] | None, user_ids: list[int]) -> None:
    conn = tidb_connect_from_env(env)
    try:
        with conn.cursor() as cur:
            for user_id in user_ids:
                cur.execute(
                    "insert ignore into users (id, name) values (%s, %s)",
                    (user_id, f"user-{user_id}"),
                )
        conn.commit()
    finally:
        conn.close()


def insert_transaction(conn: Any, row: TransactionRow) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "insert into transactions (user_id, merchant_id, amount) values (%s, %s, %s)",
            (row.user_id, row.merchant_id, row.amount_cents / 100.0),
        )
    conn.commit()


def run_baseline_query(conn: Any, feature_id: str, user_id: int, now: datetime) -> float:
    sql, params = build_baseline_query(feature_id, user_id, now)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
        return float(row["value"] if isinstance(row, dict) else row[0])
```

- [ ] Run, with `demos/chalk/.env` copied from `.env.example` and pointed at the local playground:

```
cd demos/chalk/runner
python3 -c "
from src.tidb_io import seed_users
seed_users(None, [1, 2, 3, 4, 5])
"
mysql -h 127.0.0.1 -P 4000 -u root lab -e "select count(*) from users;"
```

Expected output: `count(*)` returns `5`.
- [ ] Commit: `git add demos/chalk/runner/src/tidb_io.py && git commit -m "chalk demo: TiDB seed and baseline query I/O"`

### Task 9: Manual - Chalk project, MySQL source against TiDB, SQL resolvers

- [ ] Confirm Chalk access per Section 5. If access is sales-gated, request a trial/sandbox environment before continuing; record the actual steps taken here once known (replacing the UNVERIFIED note in Section 4/5).
- [ ] `mkdir -p demos/chalk/chalk && cd demos/chalk/chalk && chalk init` - expected output: `Created project config file chalk.yaml` and `Created .chalkignore file`.
- [ ] Edit the generated `chalk.yaml`, setting `project` to the dashboard project name.
- [ ] In the Chalk dashboard, add a MySQL data source named `RISK` pointed at the local TiDB playground's host/port/user/password/database (the same values as `.env.example`'s `TIDB_*` block). Record the exact environment variable names the dashboard's form requires in `demos/chalk/.env.example`, replacing the placeholder `RISK_MYSQL_*` names from Task 1 if they differ.
- [ ] Create `demos/chalk/chalk/requirements.txt`:

```
chalkpy
```

- [ ] Create `demos/chalk/chalk/src/user.py`:

```python
from chalk.features import features


@features
class User:
    id: int
    txn_count_1h: int
    amount_sum_24h: float
    distinct_merchants_24h: int
    velocity_flag: bool
```

- [ ] Create `demos/chalk/chalk/src/resolvers/txn_count_1h.chalk.sql`:

```sql
-- type: online
-- resolves: user
-- source: RISK
select
    count(*) as txn_count_1h
from transactions
where user_id = ${user.id}
  and created_at > date_sub(${now}, interval 1 hour)
```

- [ ] Create `demos/chalk/chalk/src/resolvers/amount_sum_24h.chalk.sql`:

```sql
-- type: online
-- resolves: user
-- source: RISK
select
    coalesce(sum(amount), 0) as amount_sum_24h
from transactions
where user_id = ${user.id}
  and created_at > date_sub(${now}, interval 24 hour)
```

- [ ] Create `demos/chalk/chalk/src/resolvers/distinct_merchants_24h.chalk.sql`:

```sql
-- type: online
-- resolves: user
-- source: RISK
select
    count(distinct merchant_id) as distinct_merchants_24h
from transactions
where user_id = ${user.id}
  and created_at > date_sub(${now}, interval 24 hour)
```

- [ ] Create `demos/chalk/chalk/src/resolvers/velocity_flag.py`:

```python
from chalk import online

from src.user import User


@online
def compute_velocity_flag(
    txn_count_1h: User.txn_count_1h,
) -> User.velocity_flag:
    from src.velocity import evaluate_velocity_flag

    return evaluate_velocity_flag(txn_count_1h)
```

`velocity_flag.py` imports `evaluate_velocity_flag` from the runner's `src/velocity.py` (Task 5) so the threshold used by Chalk and the threshold the runner's own checks assert against can never drift apart; copy or symlink `runner/src/velocity.py` into `demos/chalk/chalk/src/` so the Chalk deployment bundle is self-contained, since Chalk's build does not read outside its project directory.

- [ ] Run: `cd demos/chalk/chalk && chalk apply --branch chalk-tidb-demo` - expected output: a deployment summary reporting the `User` feature class and its resolvers with no errors.
- [ ] Run this SQL-source-against-TiDB smoke test - the single most important verification in this plan, per Section 4's UNVERIFIED note:

```
chalk query --branch chalk-tidb-demo --in user.id=1 --out user.txn_count_1h --out user.amount_sum_24h --out user.distinct_merchants_24h --out user.velocity_flag
```

Expected output: a result for each of the four features with no error, and integer/float values (0 or more, consistent with the seed data's 0 transactions for user 1 so far). If this fails, Chalk's MySQL native driver does not accept a TiDB endpoint as configured and the UNVERIFIED item in Section 4 becomes a confirmed blocker - do not proceed past this task until it passes, and record whatever error appears here.
- [ ] Commit: `git add demos/chalk/chalk && git commit -m "chalk demo: feature class and SQL resolvers against TiDB"`

### Task 10: Manual - confirm the Chalk Python client's exact call shape

- [ ] `pip install chalkpy` inside a virtualenv for `demos/chalk/runner`, and record the installed version in `demos/chalk/README.md`'s prerequisites.
- [ ] Run, from a Python shell with `CHALK_CLIENT_ID`/`CHALK_CLIENT_SECRET` exported:

```python
from chalk.client import ChalkClient
import os

client = ChalkClient(
    client_id=os.environ["CHALK_CLIENT_ID"],
    client_secret=os.environ["CHALK_CLIENT_SECRET"],
    environment=os.environ.get("CHALK_ENVIRONMENT", "dev"),
    branch="chalk-tidb-demo",
)
result = client.query(
    input={"user.id": 1},
    output=["user.txn_count_1h", "user.velocity_flag"],
    include_meta=True,
)
print(result)
print(type(result).__mro__)
```

Expected output: a successful result object; if `input`/`output` raise a `TypeError`, retry with `inputs`/`outputs` and record which one the installed version actually accepts in `demos/chalk/README.md` and in `chalk_io.py`'s call (Task 11). Inspect the printed object (or `result.meta`) for a boolean field indicating cache status; record its exact attribute name here, replacing the UNVERIFIED note in Section 4 and the `cache-hit-rate` metric's `howMeasured`.
- [ ] No commit for this task - its only output is the two confirmed facts recorded into Task 11's code and Section 4.

### Task 11: Manual - Chalk client wrapper (thin I/O)

- [ ] Create `demos/chalk/runner/src/chalk_io.py`, using the exact parameter names and cache-hit field confirmed in Task 10 (this listing assumes `input`/`output`/`result.meta.cache_hit` were confirmed; replace with the confirmed names if different - this is the one file this plan expects to change if Task 10's findings differ):

```python
import os
from dataclasses import dataclass
from typing import Any

from chalk.client import ChalkClient

FEATURE_OUTPUTS = [
    "user.txn_count_1h",
    "user.amount_sum_24h",
    "user.distinct_merchants_24h",
    "user.velocity_flag",
]


@dataclass(frozen=True)
class ChalkFeatureResult:
    txn_count_1h: int
    amount_sum_24h: float
    distinct_merchants_24h: int
    velocity_flag: bool
    cache_hit: bool


def build_chalk_client(env: dict[str, str] | None = None) -> ChalkClient:
    source = env if env is not None else os.environ
    return ChalkClient(
        client_id=source["CHALK_CLIENT_ID"],
        client_secret=source["CHALK_CLIENT_SECRET"],
        environment=source.get("CHALK_ENVIRONMENT", "dev"),
        branch="chalk-tidb-demo",
    )


def query_user_features(
    client: ChalkClient,
    user_id: int,
    fresh: bool,
) -> ChalkFeatureResult:
    staleness = {feature: "0s" for feature in FEATURE_OUTPUTS} if fresh else None
    kwargs: dict[str, Any] = {
        "input": {"user.id": user_id},
        "output": FEATURE_OUTPUTS,
        "include_meta": True,
    }
    if staleness is not None:
        kwargs["staleness"] = staleness
    result = client.query(**kwargs)
    values = {row.field: row.value for row in result.data}
    cache_hit = bool(getattr(result.meta, "cache_hit", False)) if result.meta else False
    return ChalkFeatureResult(
        txn_count_1h=int(values["user.txn_count_1h"]),
        amount_sum_24h=float(values["user.amount_sum_24h"]),
        distinct_merchants_24h=int(values["user.distinct_merchants_24h"]),
        velocity_flag=bool(values["user.velocity_flag"]),
        cache_hit=cache_hit,
    )
```

- [ ] Run, against the deployed branch from Task 9:

```
cd demos/chalk/runner
python3 -c "
from src.chalk_io import build_chalk_client, query_user_features
client = build_chalk_client()
print(query_user_features(client, user_id=1, fresh=True))
"
```

Expected output: a `ChalkFeatureResult` with `txn_count_1h=0` (no transactions yet for user 1) and `velocity_flag=False`.
- [ ] Commit: `git add demos/chalk/runner/src/chalk_io.py && git commit -m "chalk demo: Chalk online query client wrapper"`

### Task 12: Manual - wire the steady-state tick loop and feature-parity check

- [ ] Create `demos/chalk/runner/main.py`:

```python
import asyncio
import os
import time
from datetime import datetime, timezone

from lab_runner import createEmitter, createSampleWindow, every, onControl, summarize, tidb_connect_from_env

from src.chalk_io import build_chalk_client, query_user_features
from src.freshness import freshness_lag_ms
from src.tidb_io import insert_transaction, run_baseline_query, seed_users
from src.workload import next_transaction

SAMPLED_USER_ID = 1
BURST_USER_ID = 2
MERCHANTS = ["coffee-shop", "grocery", "gas-station", "online-retail"]

emitter = createEmitter()
chalk_client = build_chalk_client()
tidb_conn = tidb_connect_from_env(os.environ)

fresh_mode = False
tick_count = 0
write_count = 0
chalk_samples = createSampleWindow()
baseline_samples = createSampleWindow()


async def steady_state_tick() -> None:
    global tick_count, write_count
    tick_count += 1

    row = next_transaction(
        user_id=SAMPLED_USER_ID,
        tick=tick_count,
        merchant_pool=MERCHANTS,
        amount_cents=1500,
        burst=False,
    )
    write_start = emitter.elapsedMs()
    insert_transaction(tidb_conn, row)
    write_count += 1
    emitter.flow("writes", 1)

    now = datetime.now(timezone.utc)

    chalk_start = time.perf_counter()
    chalk_result = query_user_features(chalk_client, SAMPLED_USER_ID, fresh=fresh_mode)
    chalk_samples.add((time.perf_counter() - chalk_start) * 1000)
    emitter.flow("online-queries", 1)

    baseline_start = time.perf_counter()
    baseline_count = run_baseline_query(tidb_conn, "txn-count-1h", SAMPLED_USER_ID, now)
    baseline_sum = run_baseline_query(tidb_conn, "amount-sum-24h", SAMPLED_USER_ID, now)
    baseline_merchants = run_baseline_query(tidb_conn, "distinct-merchants-24h", SAMPLED_USER_ID, now)
    baseline_samples.add((time.perf_counter() - baseline_start) * 1000)
    emitter.flow("baseline-sql", 1)
    emitter.flow("resolver-sql", 1)

    parity = (
        chalk_result.txn_count_1h == int(baseline_count)
        and abs(chalk_result.amount_sum_24h - baseline_sum) < 1e-6
        and chalk_result.distinct_merchants_24h == int(baseline_merchants)
    )
    emitter.check(
        "feature-parity",
        "pass" if parity else "fail",
        observed=f"chalk={chalk_result} baseline=({baseline_count},{baseline_sum},{baseline_merchants})",
    )

    lag_ms = freshness_lag_ms(write_ts_ms=write_start, observed_ts_ms=emitter.elapsedMs())
    emitter.metric("freshness-lag-ms", lag_ms)
    emitter.metric("tidb-write-rate", float(write_count))
    write_count = 0

    chalk_summary = summarize(chalk_samples.drain())
    if chalk_summary is not None:
        emitter.metric("chalk-query-p50", chalk_summary.p50)
        emitter.metric("chalk-query-p99", chalk_summary.p99)

    baseline_summary = summarize(baseline_samples.drain())
    if baseline_summary is not None:
        emitter.metric("baseline-sql-p99", baseline_summary.p99)

    emitter.metric("cache-hit-rate", 100.0 if chalk_result.cache_hit else 0.0)


def handle_control(control_id: str) -> None:
    global fresh_mode
    if control_id == "tighten-staleness":
        fresh_mode = not fresh_mode
        emitter.log("info", f"fresh_mode now {fresh_mode}")


async def main() -> None:
    seed_users(None, [SAMPLED_USER_ID, BURST_USER_ID, 3, 4, 5])
    emitter.phase("seed")
    emitter.phase("steady-state")
    onControl(handle_control)

    stop = asyncio.Event()
    await every(intervalMs=1000, task=steady_state_tick, signal=stop_signal(stop))


def stop_signal(stop: "asyncio.Event") -> "asyncio.AbstractEventLoop":
    raise NotImplementedError("wired in Task 15 once the control loop and phase transitions are final")


if __name__ == "__main__":
    asyncio.run(main())
```

This first pass intentionally leaves `stop_signal` unfinished as a marker for Task 15, which replaces the steady-state-only loop with the full phase/control state machine; everything above it (writes, both query paths, `feature-parity`, freshness, rate, and cache metrics) is complete and independently runnable up to that point.
- [ ] Run, with `demos/chalk/.env` sourced and both TiDB and the Chalk branch reachable, for about 15 seconds then Ctrl-C:

```
cd demos/chalk/runner
python3 -c "
import asyncio
from main import seed_users, SAMPLED_USER_ID, BURST_USER_ID, steady_state_tick
seed_users(None, [SAMPLED_USER_ID, BURST_USER_ID, 3, 4, 5])
asyncio.run(steady_state_tick())
asyncio.run(steady_state_tick())
"
```

Expected output: no exceptions, and the process's stdout (via the emitter) contains two `check` events for `feature-parity` with `status: "pass"`.
- [ ] Commit: `git add demos/chalk/runner/main.py && git commit -m "chalk demo: steady-state tick loop with feature-parity check"`

### Task 13: Manual - wire the velocity-burst control and fraud-flip check

- [ ] Replace `handle_control` and add a burst coroutine in `main.py`:

```python
burst_task: "asyncio.Task | None" = None


async def run_velocity_burst() -> None:
    burst_start_ms = emitter.elapsedMs()
    emitter.check("fraud-flip", "pending")
    for i in range(60):
        row = next_transaction(
            user_id=BURST_USER_ID,
            tick=i,
            merchant_pool=MERCHANTS,
            amount_cents=2500,
            burst=True,
        )
        insert_transaction(tidb_conn, row)
        emitter.flow("writes", 1)
        await asyncio.sleep(1.5)

    deadline = emitter.elapsedMs() + 30_000
    while emitter.elapsedMs() < deadline:
        result = query_user_features(chalk_client, BURST_USER_ID, fresh=True)
        if result.velocity_flag:
            flip_seconds = (emitter.elapsedMs() - burst_start_ms) / 1000.0
            emitter.metric("fraud-flag-flip-s", flip_seconds)
            emitter.check("fraud-flip", "pass", observed=f"flipped after {flip_seconds:.1f}s")
            return
        await asyncio.sleep(0.5)
    emitter.check("fraud-flip", "fail", observed="timed out after 30s")


def handle_control(control_id: str) -> None:
    global fresh_mode, burst_task
    if control_id == "tighten-staleness":
        fresh_mode = not fresh_mode
        emitter.log("info", f"fresh_mode now {fresh_mode}")
    elif control_id == "velocity-burst":
        emitter.phase("velocity-burst")
        burst_task = asyncio.get_event_loop().create_task(run_velocity_burst())
    elif control_id == "burst-writes":
        emitter.log("info", "burst-writes control received")
```

- [ ] Run, with the runner started and, from a second terminal, `curl -X POST http://127.0.0.1:7070/control/velocity-burst` (per the relay protocol in Plan 00) once `lab run chalk` is available (Task 14) - until then, invoke `run_velocity_burst()` directly:

```
cd demos/chalk/runner
python3 -c "
import asyncio
from main import run_velocity_burst
asyncio.run(run_velocity_burst())
"
```

Expected output: a `check` event for `fraud-flip` with `status: "pending"`, then, within roughly 90-120 seconds, one with `status: "pass"` and an `observed` string reporting the flip time, plus a `metric` event for `fraud-flag-flip-s`.
- [ ] Commit: `git add demos/chalk/runner/main.py && git commit -m "chalk demo: velocity burst control and fraud-flip check"`

### Task 14: Manual - wire burst-writes control and finish the phase state machine

- [ ] Add a `burst_writes_active` flag and a background task in `main.py` that, while active, calls `next_transaction`/`insert_transaction` for 10 randomly chosen non-burst user ids once every 100ms for 20 seconds, then clears the flag; wire `handle_control`'s `burst-writes` branch to start this task via `asyncio.get_event_loop().create_task(...)`, mirroring `run_velocity_burst`'s task-creation pattern.
- [ ] Replace the placeholder `stop_signal` function with a real `asyncio.Event`-based signal wired to `SIGINT`/`SIGTERM` (`loop.add_signal_handler`), and add a final `emitter.phase("wrapup")` plus a printed summary of the last `check` events before exit.
- [ ] Run: `cd demos/chalk/runner && python3 main.py` for about 60 seconds, then Ctrl-C - expected output: a continuous stream of `metric`/`flow`/`check` JSON lines on stdout, a clean `phase: wrapup` event, and process exit code `0`.
- [ ] Commit: `git add demos/chalk/runner/main.py && git commit -m "chalk demo: burst-writes control and full phase state machine"`

### Task 15: Manual - run through the relay end to end

- [ ] From the `integrations/` workspace root: `pnpm lab validate chalk` - expected output: `manifest.json is valid` (and, once `traces/featured.json` exists after Section 8, that it validates too).
- [ ] `pnpm lab run chalk --port 7070` - expected output: the relay reports it spawned `python3 main.py` in `demos/chalk/`, and `curl http://127.0.0.1:7070/health` returns `{"ok":true,"demo":"chalk"}`.
- [ ] `curl http://127.0.0.1:7070/manifest` - expected output: the parsed manifest JSON, matching Task 2's file.
- [ ] `curl -N http://127.0.0.1:7070/events` in one terminal while the runner is live - expected output: a stream of `metric`/`flow`/`check`/`phase` JSON lines.
- [ ] `curl -X POST http://127.0.0.1:7070/control/velocity-burst` - expected output: `204` (or the relay's documented success response) and, in the events stream, a `control` event followed eventually by the `fraud-flip` check events from Task 13.
- [ ] Commit: no code changes in this task; if any command's actual output differs from what is written above, fix the discrepancy in the relevant task's code first, then re-run this task before moving on.

## 8. Recording the featured trace

- [ ] Write `demos/chalk/README.md` covering: what it proves (Section 1), prerequisites (Chalk service token, TiDB playground, `chalkpy` version pinned per Task 10), exact run commands (`infra/tidb/playground.sh`, `chalk apply --branch chalk-tidb-demo` from `demos/chalk/chalk`, `pnpm lab run chalk --record`), how to open the UI against the live relay, and teardown (`tiup clean lab`, revoking the Chalk service token and deleting the `chalk-tidb-demo` branch per Section 5).
- [ ] Write `demos/chalk/TALK-TRACK.md` with one section per phase from Section 2's table (id, label, the exact narration string, and 1-2 sentences of presenter color), then:
  - Five discovery questions: "What's computing your fraud features today, and where does the source data for them live?" / "How do you know a feature value Chalk served you five minutes ago is still correct?" / "What's your current write path for the raw events your features are built from - can it also run ad hoc SQL against that same data?" / "How do you decide `max_staleness` per feature today, and who owns that tradeoff?" / "If your feature platform's resolver SQL got slow, would you know whether the bottleneck is the database or the platform?"
  - Five objections with honest answers: "Chalk already has an online store, why do we need TiDB underneath it?" -> Chalk's online store caches computed feature values; it does not hold your raw transactional data or let you run ad hoc SQL against it, and it is not the system that gives you a durable, consistent copy of the events themselves. "Isn't this just Postgres with extra steps?" -> Chalk treats TiDB exactly like any other native SQL source in this demo; the case for TiDB over a single-node Postgres is horizontal write/read scale and built-in HTAP, which this demo's local playground does not itself prove at scale - say so plainly if asked. "We don't want two places to look when a feature is wrong" -> the direct-SQL baseline in this demo is a debugging aid, not a second system to run in production; the point is that when a resolver's SQL runs against TiDB, you can always drop into a SQL client and run the identical query to explain a value. "What if Chalk's MySQL driver doesn't behave well against TiDB at scale?" -> this demo confirms functional compatibility at demo scale (Task 9), not a load-tested certification; say that plainly and offer to scope a load test with the account's own resolver SQL. "Why not just use Redis/DynamoDB as the metric store and skip TiDB?" -> a key-value store has nowhere to put the raw transactions or run new ad hoc aggregates you didn't pre-compute; TiDB is where the source-of-truth events live, which is what Chalk's SQL resolvers are reading in the first place.
- [ ] Start `infra/tidb/playground.sh`, wait for it to report ready, and record the printed TiDB version into `LAB_ENV_TIDB`.
- [ ] Ensure the Chalk branch `chalk-tidb-demo` from Task 9 is deployed and reachable, and `demos/chalk/.env` has real `CHALK_CLIENT_ID`/`CHALK_CLIENT_SECRET` values.
- [ ] Run `pnpm lab run chalk --record --port 7070` and, from a second terminal, open the UI against it; step through phases by watching the runner's own `phase` events (seed and steady-state happen automatically), then hit `POST /control/velocity-burst`, wait for the fraud-flip check to pass, then `POST /control/tighten-staleness` twice to show both cache modes, then `POST /control/burst-writes`, then let `wrapup` occur naturally or Ctrl-C the runner.
- [ ] A good run has: at least one `feature-parity` check with `status: "pass"` per tick throughout steady-state, exactly one `fraud-flip` check reaching `status: "pass"` with `observed` under 120 seconds, a visible `tidb-write-rate` spike during `burst-writes`, and both a cached and a fresh `cache-hit-rate` value shown across the two `tighten-staleness` toggles.
- [ ] Copy the resulting `demos/chalk/traces/<ISO timestamp>.json` to `demos/chalk/traces/featured.json`.
- [ ] Run: `pnpm lab validate chalk` - expected output: manifest and `traces/featured.json` both valid, including `eventReferenceErrors` returning an empty list for every event.
- [ ] Run: `pnpm lab check-public` - expected output: no denylisted terms or internal URLs found in any published file under `demos/chalk/`.
- [ ] Commit: `git add demos/chalk/README.md demos/chalk/TALK-TRACK.md demos/chalk/traces/featured.json && git commit -m "chalk demo: README, talk track, and featured trace"`

## 9. Risks and gotchas

- **Chalk access may be sales-gated.** Section 5 flags that no self-serve signup was found in the docs fetched. If a trial environment cannot be obtained promptly, build and fully test everything through Task 8 (TiDB schema, seed data, workload generator, baseline SQL, all four pure-logic test suites) first - none of it depends on Chalk - and only block on Tasks 9-15.
- **TiDB-as-MySQL-source is unverified until Task 9's smoke test passes.** If Chalk's native MySQL driver rejects TiDB (unexpected `SHOW VARIABLES` output, unsupported system variable, or a TLS handshake mismatch), the fallback is to front TiDB with a small MySQL-protocol-compatible proxy is out of scope for this plan - instead, report the exact error back before continuing, since the whole demo's premise depends on this path working.
- **`input`/`inputs` and `output`/`outputs` naming drift across chalkpy versions.** Task 10 exists specifically to catch this before Task 11 is written against a guess; if it changes again after Task 11, only `chalk_io.py` needs to change.
- **The cache-hit response field is unverified.** `chalk_io.py`'s `getattr(result.meta, "cache_hit", False)` defaults to `False` rather than raising, so a wrong field name degrades `cache-hit-rate` to always reporting 0% instead of crashing the runner - Task 10's manual inspection step is what actually confirms and corrects the field name before recording.
- **Clock skew between the runner process and TiDB.** `freshness_lag_ms` and the `${now}` SQL parameter both assume the runner's wall clock and TiDB's are close enough to not matter at demo scale (single machine, local playground); this would need revisiting for a distributed or cloud recording.
- **The velocity burst takes 90-120 seconds end to end**, which is a meaningful fraction of a 3-6 minute recording; keep the rest of the phases tight (steady-state only needs to run long enough to show a handful of matching `feature-parity` ticks before the burst starts) so the total recording stays in budget.
- **`chalk apply --branch` reuses the same branch name across re-recordings.** Re-running Task 9's `chalk apply` on an existing `chalk-tidb-demo` branch updates it in place; if a stale resolver definition is cached, redeploy with a fresh branch name and update `demos/chalk/.env` and `chalk_io.py`'s `branch=` argument together.
