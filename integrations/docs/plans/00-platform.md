# Plan 00: TiDB Integration Lab Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared shell every integration demo plugs into: an event contract, runner kits (TypeScript and Python), a local relay that streams a running demo to the browser and records it, and a React UI that animates the data flow and charts the metrics, in live mode or replaying a recording on a static website.

**Architecture:** Every demo is a *runner* process (any language) that prints one JSON event per line to stdout. The *relay* spawns the runner, validates each line against the contract, fans events out over Server-Sent Events, forwards UI button presses to the runner's stdin, and records the whole run to a trace file. The *UI* is a pure function of `manifest + events`: a reducer folds events into state, and the same reducer powers live mode (SSE) and replay mode (a recorded trace with play, pause, speed and scrub). Hosting is a static build of the UI plus one featured trace per demo.

**Tech Stack:** pnpm workspaces, TypeScript (strict), Zod 4, Vitest, React 19 + Vite, @testing-library/react, mysql2, Node 22. Python 3.11+ with pymysql for runners that need a Python-only vendor SDK.

---

## Why the platform comes first

Twelve demos with twelve bespoke UIs would never get finished or hosted. The platform makes each demo three small artifacts: a `manifest.json` (what the diagram and metrics are), a runner (what actually happens), and a recorded trace (what the website plays back). Build this once, then each demo plan in this folder is a self-contained few days of work.

## Global rules (apply to every plan in this folder)

1. **This repo is public.** No customer or prospect names anywhere: code, manifests, traces, READMEs, talk tracks, commit messages. Describe the *pattern* instead ("fintech risk pipeline: Aurora PostgreSQL to TiDB with full load + CDC"). No internal URLs (Feishu/Lark, internal Google Docs, Slack, Jira). Task 14 adds an automated gate for this (`pnpm lab check-public`).
2. **Every number shown is either measured or labeled.** Each metric in a manifest carries `howMeasured`. Replays carry the environment they were recorded on. A modeled or simulated value must say so in its label.
3. **No hardcoded prices, quotas, or version numbers in prose.** Point to the vendor's pricing or docs page and give the formula. Record actual versions in the trace `environment` at capture time.
4. **TDD for all logic.** Pure functions (metric math, parsing, reducers, layout) get failing tests first. Thin I/O adapters (database clients, HTTP calls, cloud SDK calls) are verified by the manual "live run" steps with expected output.
5. **Code style:** TypeScript strict, no `any`, no type assertions, `type` over `interface` for data, immutable data, small pure functions, early returns, options objects over positional params when there are more than two, no code comments.
6. **Writing style:** never use em dashes in any file; use a regular hyphen.
7. **Each demo is done when:** live run works end to end, a featured trace is recorded, the replay renders in the UI, `README.md` + `TALK-TRACK.md` exist, teardown is documented and tested, and `pnpm lab check-public` passes.

## Repository layout

Everything lives under `integrations/` inside `tidb-demos`.

```
integrations/
  package.json                  workspace root scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.workspace.ts
  .gitignore
  packages/
    contract/                   @lab/contract: Zod schemas for manifest, events, trace
    runner-kit/                 @lab/runner-kit: TS helpers for runners
    runner-kit-py/              lab_runner: Python mirror of runner-kit
    relay/                      @lab/relay: `lab` CLI (run, validate, check-public, collect-site)
    ui/                         @lab/ui: Vite + React app
  infra/
    tidb/playground.sh          local TiDB with TiFlash + TiCDC + Prometheus/Grafana
    kafka/docker-compose.yml    single-broker Kafka (KRaft) shared by several demos
  demos/
    example/                    synthetic demo used to build and test the platform (never published)
    <demo-id>/                  one folder per demo (see "Demo folder contract")
  docs/plans/                   this folder
```

## Interfaces (the contract every demo plan depends on)

These are the exact names and shapes. Demo plans must use them as written.

### Manifest (`packages/contract/src/manifest.ts`)

```ts
import { z } from 'zod';

export const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case');

export const NodeKindSchema = z.enum([
  'tidb',
  'source',
  'sink',
  'queue',
  'service',
  'identity',
  'cloud',
  'client',
  'cache',
  'observability',
]);

export const ManifestNodeSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  kind: NodeKindSchema,
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
});

export const ManifestEdgeSchema = z.object({
  id: SlugSchema,
  from: SlugSchema,
  to: SlugSchema,
  label: z.string().min(1),
  unit: z.string().min(1),
});

export const MetricUnitSchema = z.enum([
  'rows/s',
  'msgs/s',
  'req/s',
  'ms',
  's',
  '%',
  'count',
  'rows',
  'MB',
  'USD',
]);

export const ManifestMetricSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  unit: MetricUnitSchema,
  display: z.enum(['tile', 'series', 'both']),
  better: z.enum(['higher', 'lower', 'neutral']),
  target: z.number().optional(),
  group: z.string().min(1).optional(),
  howMeasured: z.string().min(1),
});

export const ManifestPhaseSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  narration: z.string().min(1),
});

export const ManifestCheckSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  description: z.string().min(1),
});

export const ManifestControlSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  description: z.string().min(1),
});

export const RunnerSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).default('.'),
});

const duplicateIds = (ids: readonly string[]): readonly string[] =>
  ids.filter((id, index) => ids.indexOf(id) !== index);

export const DemoManifestSchema = z
  .object({
    id: SlugSchema,
    number: z.number().int().min(0),
    title: z.string().min(1),
    tagline: z.string().min(1),
    integrations: z.array(z.string().min(1)).min(1),
    pattern: z.string().min(1),
    publish: z.boolean().default(true),
    runner: RunnerSchema,
    nodes: z.array(ManifestNodeSchema).min(2),
    edges: z.array(ManifestEdgeSchema),
    metrics: z.array(ManifestMetricSchema).min(1),
    phases: z.array(ManifestPhaseSchema).min(1),
    checks: z.array(ManifestCheckSchema),
    controls: z.array(ManifestControlSchema),
  })
  .superRefine((manifest, ctx) => {
    const nodeIds = new Set(manifest.nodes.map((node) => node.id));
    manifest.edges
      .filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
      .forEach((edge) =>
        ctx.addIssue({ code: 'custom', message: `edge ${edge.id} references an unknown node` }),
      );
    const collections = {
      nodes: manifest.nodes,
      edges: manifest.edges,
      metrics: manifest.metrics,
      phases: manifest.phases,
      checks: manifest.checks,
      controls: manifest.controls,
    };
    Object.entries(collections).forEach(([name, items]) =>
      duplicateIds(items.map((item) => item.id)).forEach((id) =>
        ctx.addIssue({ code: 'custom', message: `duplicate ${name} id: ${id}` }),
      ),
    );
  });

export type DemoManifest = z.infer<typeof DemoManifestSchema>;
export type ManifestNode = z.infer<typeof ManifestNodeSchema>;
export type ManifestEdge = z.infer<typeof ManifestEdgeSchema>;
export type ManifestMetric = z.infer<typeof ManifestMetricSchema>;
export type MetricUnit = z.infer<typeof MetricUnitSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type ManifestPhase = z.infer<typeof ManifestPhaseSchema>;
export type ManifestControl = z.infer<typeof ManifestControlSchema>;
```

Manifest conventions:

- `x`/`y` are percentages of the diagram canvas. Sources on the left (`x` 5-25), TiDB in the middle (`x` 45-55), sinks on the right (`x` 75-95).
- `pattern` is the anonymized customer pattern in one sentence.
- `publish: false` keeps a demo off the hosted site (the `example` demo uses this).
- `narration` is what the presenter says during that phase. The UI shows it as a caption, so it doubles as the talk track.

### Events (`packages/contract/src/events.ts`)

```ts
import { z } from 'zod';
import { SlugSchema, type DemoManifest } from './manifest';

const t = z.number().nonnegative();

export const NodeStatusSchema = z.enum(['idle', 'starting', 'healthy', 'busy', 'degraded', 'down', 'done']);
export const CheckStatusSchema = z.enum(['pending', 'pass', 'fail']);
export const LogLevelSchema = z.enum(['info', 'warn', 'error']);

export const MetricEventSchema = z.object({ type: z.literal('metric'), t, id: SlugSchema, value: z.number() });
export const FlowEventSchema = z.object({ type: z.literal('flow'), t, edge: SlugSchema, count: z.number().int().nonnegative() });
export const NodeEventSchema = z.object({ type: z.literal('node'), t, node: SlugSchema, status: NodeStatusSchema, note: z.string().optional() });
export const PhaseEventSchema = z.object({ type: z.literal('phase'), t, phase: SlugSchema });
export const CheckEventSchema = z.object({ type: z.literal('check'), t, id: SlugSchema, status: CheckStatusSchema, observed: z.string().optional() });
export const LogEventSchema = z.object({ type: z.literal('log'), t, level: LogLevelSchema, msg: z.string(), node: SlugSchema.optional() });
export const ControlEventSchema = z.object({ type: z.literal('control'), t, id: SlugSchema });

export const DemoEventSchema = z.discriminatedUnion('type', [
  MetricEventSchema,
  FlowEventSchema,
  NodeEventSchema,
  PhaseEventSchema,
  CheckEventSchema,
  LogEventSchema,
  ControlEventSchema,
]);

export type DemoEvent = z.infer<typeof DemoEventSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export type ParsedLine =
  | { readonly ok: true; readonly event: DemoEvent }
  | { readonly ok: false; readonly error: string };

const parseJson = (line: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
};

export const parseEventLine = (line: string): ParsedLine => {
  const json = parseJson(line);
  if (!json.ok) return { ok: false, error: `not JSON: ${line.slice(0, 120)}` };
  const result = DemoEventSchema.safeParse(json.value);
  if (result.success) return { ok: true, event: result.data };
  return {
    ok: false,
    error: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
  };
};

const has = (items: readonly { readonly id: string }[], id: string): boolean =>
  items.some((item) => item.id === id);

export const eventReferenceErrors = (manifest: DemoManifest, event: DemoEvent): readonly string[] => {
  switch (event.type) {
    case 'metric':
      return has(manifest.metrics, event.id) ? [] : [`unknown metric: ${event.id}`];
    case 'flow':
      return has(manifest.edges, event.edge) ? [] : [`unknown edge: ${event.edge}`];
    case 'node':
      return has(manifest.nodes, event.node) ? [] : [`unknown node: ${event.node}`];
    case 'phase':
      return has(manifest.phases, event.phase) ? [] : [`unknown phase: ${event.phase}`];
    case 'check':
      return has(manifest.checks, event.id) ? [] : [`unknown check: ${event.id}`];
    case 'control':
      return has(manifest.controls, event.id) ? [] : [`unknown control: ${event.id}`];
    case 'log':
      return event.node === undefined || has(manifest.nodes, event.node) ? [] : [`unknown node: ${event.node}`];
  }
};
```

Event semantics (runners must follow these):

| Event | Meaning | Emit when |
|---|---|---|
| `metric` | Latest value of a manifest metric | Once per tick (default 1000 ms) per metric. Rates are per second over the last tick. Latencies are the percentile over the last tick's samples. Counters are cumulative. |
| `flow` | `count` units moved along an edge since the last flow event for that edge | Once per tick per active edge. The UI turns this into animated particles and an edge rate label. |
| `node` | A component changed status | On change only. |
| `phase` | The demo moved to a new chapter | On change only. |
| `check` | A correctness proof changed (row counts match, checksum equal, token revoked) | `pending` when it starts, then `pass` or `fail` with `observed`. |
| `log` | Human-readable line for the console panel | Sparingly; one per notable action. |
| `control` | A UI button was pressed | Written by the relay, never by runners. |

`t` is milliseconds since the runner started. The emitter sets it.

### Trace (`packages/contract/src/trace.ts`)

```ts
import { z } from 'zod';
import { DemoManifestSchema } from './manifest';
import { DemoEventSchema } from './events';

export const TraceEnvironmentSchema = z.object({
  tidb: z.string().min(1),
  components: z.record(z.string(), z.string()),
  notes: z.string(),
});

export const TraceSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: DemoManifestSchema,
  recordedAt: z.iso.datetime(),
  environment: TraceEnvironmentSchema,
  durationMs: z.number().nonnegative(),
  events: z.array(DemoEventSchema),
});

export type Trace = z.infer<typeof TraceSchema>;
export type TraceEnvironment = z.infer<typeof TraceEnvironmentSchema>;
```

### Runner kit, TypeScript (`@lab/runner-kit`)

```ts
export type Clock = () => number;
export type LineWriter = (line: string) => void;

export type Emitter = {
  readonly metric: (id: string, value: number) => void;
  readonly flow: (edge: string, count: number) => void;
  readonly node: (node: string, status: NodeStatus, note?: string) => void;
  readonly phase: (phase: string) => void;
  readonly check: (id: string, status: CheckStatus, observed?: string) => void;
  readonly log: (level: LogLevel, msg: string, node?: string) => void;
  readonly elapsedMs: () => number;
};

export const createEmitter: (options?: { readonly clock?: Clock; readonly write?: LineWriter }) => Emitter;

export type LatencySummary = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};
export const percentile: (values: readonly number[], p: number) => number | undefined;
export const summarize: (values: readonly number[]) => LatencySummary | undefined;

export type SampleWindow = { readonly add: (value: number) => void; readonly drain: () => readonly number[] };
export const createSampleWindow: () => SampleWindow;

export const timed: <T>(task: () => Promise<T>, clock?: Clock) => Promise<{ readonly value: T; readonly ms: number }>;
export const sleep: (ms: number) => Promise<void>;
export const every: (options: { readonly intervalMs: number; readonly task: () => Promise<void>; readonly signal: AbortSignal }) => Promise<void>;

export const parseControlLine: (line: string) => string | undefined;
export const onControl: (handler: (id: string) => void, input?: NodeJS.ReadableStream) => void;

export const tidbConfigFromEnv: (env: NodeJS.ProcessEnv) => import('mysql2').PoolOptions;
export const createTidbPool: (env?: NodeJS.ProcessEnv) => import('mysql2/promise').Pool;
export const quoteIdentifier: (name: string) => string;
```

`every` runs `task`, waits out the rest of the interval (never overlapping runs), and resolves when `signal` aborts. `sleep` also accepts an optional `AbortSignal` as a second argument and resolves early when it aborts. `onControl` reads `{"control":"<id>"}` lines from stdin, which is how the relay delivers button presses. `quoteIdentifier` backtick-quotes a SQL identifier (doubling embedded backticks); every dynamic database, table, user, or role name goes through it.

### Runner kit, Python (`packages/runner-kit-py/lab_runner/__init__.py`)

Same surface, snake_case: `Emitter(clock=None, write=None)` with `metric`, `flow`, `node`, `phase`, `check`, `log`, `elapsed_ms`; `percentile(values, p)`; `summarize(values)`; `SampleWindow()` with `add(value)` and `drain()`; `timed(task, clock=None)` returning `(value, ms)`; `parse_control_line(line)`; `on_control(handler, stream=None)` (daemon thread); `tidb_config_from_env(env)`; `tidb_connect_from_env(env=None)` (pymysql). Use it only when a vendor SDK is Python-only.

### Environment variable conventions

Every demo's `.env.example` starts with this block, and runners read TiDB settings only through `tidbConfigFromEnv` / `tidb_config_from_env`:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=
```

Set `TIDB_TLS=true` for TiDB Cloud (TLS 1.2+, server certificate verified). `LAB_ENV_*` values are copied into the trace's `environment` by the relay: `LAB_ENV_TIDB` becomes `environment.tidb`, `LAB_ENV_NOTES` becomes `environment.notes`, and every `LAB_ENV_COMPONENT_<NAME>=<version>` becomes `environment.components["<name>"]` (lowercased), for example `LAB_ENV_COMPONENT_KAFKA=apache/kafka 4.1.0`. Optional: `TIDB_POOL_SIZE` (default 10), `TIDB_CA_PATH` (Python kit only, default `/etc/ssl/cert.pem`).

### Relay protocol (`@lab/relay`, CLI name `lab`)

| Command | What it does |
|---|---|
| `pnpm lab run <demo-id> [--record] [--port 7070]` | Loads `demos/<id>/manifest.json`, loads `demos/<id>/.env`, spawns `runner.command` in `demos/<id>/<runner.cwd>`, serves the HTTP API below. With `--record`, writes `demos/<id>/traces/<ISO timestamp>.json` when the runner exits or on Ctrl-C. |
| `pnpm lab validate <demo-id>` | Validates the manifest and, if present, `traces/featured.json`, including `eventReferenceErrors` for every event. |
| `pnpm lab db-init <demo-id>` | Reads the demo's `.env`, connects without a database, runs `CREATE DATABASE IF NOT EXISTS` for `TIDB_DATABASE`, prints the TiDB version. |
| `pnpm lab check-public` | Fails if any publishable file under `integrations/` contains a denylisted term or an internal URL pattern. The denylist is read from `LAB_DENYLIST` (newline-separated) or the file at `LAB_DENYLIST_FILE` (default `~/.config/tidb-lab/denylist.txt`), and the command fails closed when neither exists. The denylist never lives in the repo. |
| `pnpm lab collect-site` | Copies each published demo's manifest and `traces/featured.json` into `packages/ui/public/data/` and writes `data/catalog.json`. `LAB_INCLUDE_UNPUBLISHED=true` also includes `publish: false` demos (local dev only). |

HTTP API while `lab run` is active:

| Route | Behavior |
|---|---|
| `GET /health` | `{"ok":true,"demo":"<id>"}` |
| `GET /manifest` | The parsed manifest |
| `GET /events` | SSE stream. Each message carries `id: <runId>.<index>` (see `formatSseId` in `packages/contract/src/sse.ts`). A new connection gets every event recorded so far, then new ones live, so a browser that joins late catches up. A reconnecting browser sends `Last-Event-ID`; the relay resumes after it when the run id matches and replays the whole run when it does not (the relay was restarted). |
| `POST /control/:id` | 404 if `id` is not in `manifest.controls`. Otherwise writes `{"control":"<id>"}\n` to the runner's stdin and records a `control` event. |

Runner stdout lines that fail validation become `log` events at level `warn` (the run continues). Runner stderr lines become `log` events at level `warn`. CORS allows origins listed in `LAB_ALLOWED_ORIGINS` (comma-separated, default `http://localhost:5173`).

### Demo folder contract

```
demos/<demo-id>/
  manifest.json          validated by DemoManifestSchema
  package.json           name "@lab/demo-<demo-id>", depends on @lab/contract + @lab/runner-kit (workspace:*)
  tsconfig.json          extends ../../tsconfig.base.json
  README.md              what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md          presenter script per phase, discovery questions, objections and answers
  .env.example           the standard block plus demo-specific variables
  infra/                 docker-compose.yml and/or terraform/ for this demo only
  runner/                main.ts entry + src/*.ts (logic) + test/*.test.ts
  test/manifest.test.ts  parses manifest.json with DemoManifestSchema
  traces/featured.json   the recording the website plays (committed after capture)
```

Other traces in `traces/` are gitignored; only `featured.json` is committed.

Recommended `runner.command` for TypeScript runners: `["node", "--import", "tsx", "runner/main.ts"]` (stdin and signals pass straight through; `tsx` is a devDependency of the demo package). For Python runners: `[".venv/bin/python", "-u", "runner/main.py"]` (`-u` keeps stdout unbuffered).

### Site catalog (`packages/contract/src/site.ts`)

```ts
import { z } from 'zod';
import { SlugSchema } from './manifest';

export const CatalogEntrySchema = z.object({
  id: SlugSchema,
  number: z.number().int().min(0),
  title: z.string().min(1),
  tagline: z.string().min(1),
  integrations: z.array(z.string().min(1)),
  hasReplay: z.boolean(),
});

export const CatalogSchema = z.array(CatalogEntrySchema);

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
```

### Shared infrastructure

`infra/tidb/playground.sh` (local TiDB for every demo that can run locally):

```bash
#!/usr/bin/env bash
set -euo pipefail
exec tiup playground --tag lab --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1 "$@"
```

It uses tiup's default (latest) TiDB version; record the version printed at startup in `LAB_ENV_TIDB`. Ports: TiDB `4000`, PD `2379`, TiCDC `8300`, Prometheus `9090`, Grafana `3000`. Data persists under `~/.tiup/data/lab` until `tiup clean lab`.

`infra/kafka/docker-compose.yml` (shared by the Kafka, Debezium, Redis and Databricks demos):

```yaml
services:
  kafka:
    image: apache/kafka:latest
    container_name: lab-kafka
    ports:
      - "9092:9092"
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:29092,CONTROLLER://:29093,PLAINTEXT_HOST://:9092
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
      KAFKA_NUM_PARTITIONS: 3
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list"]
      interval: 5s
      timeout: 10s
      retries: 20
networks:
  default:
    name: lab
```

Host processes (TiCDC from the playground, Node runners) use `localhost:9092`. Containers on the `lab` network use `kafka:29092`. Containers reach the host's TiDB at `host.docker.internal:4000` (Docker Desktop on macOS).

## File structure

| File | Responsibility |
|---|---|
| `integrations/package.json` | Workspace scripts: `test`, `typecheck`, `lab`, `dev`, `build:site` |
| `integrations/pnpm-workspace.yaml` | Workspace globs `packages/*`, `demos/*` |
| `integrations/tsconfig.base.json` | Shared strict compiler options |
| `integrations/.gitignore` | node_modules, dist, `.env`, non-featured traces, generated site data |
| `packages/contract/src/manifest.ts` | Manifest schema (exact code in Interfaces) |
| `packages/contract/src/events.ts` | Event schemas, `parseEventLine`, `eventReferenceErrors` |
| `packages/contract/src/trace.ts` | Trace schema |
| `packages/contract/src/site.ts` | Catalog schema |
| `packages/contract/src/index.ts` | Barrel export |
| `packages/contract/test/fixtures.ts` | Test data factories, exported as `@lab/contract/testing` for relay and UI tests |
| `packages/runner-kit/src/emitter.ts` | `createEmitter` |
| `packages/runner-kit/src/stats.ts` | `percentile`, `summarize`, `createSampleWindow` |
| `packages/runner-kit/src/timing.ts` | `sleep`, `timed`, `every` |
| `packages/runner-kit/src/control.ts` | `parseControlLine`, `onControl` |
| `packages/runner-kit/src/tidb.ts` | `tidbConfigFromEnv`, `createTidbPool`, `quoteIdentifier` |
| `packages/runner-kit/src/index.ts` | Barrel export |
| `packages/runner-kit-py/lab_runner/__init__.py` | Python mirror of the runner kit |
| `packages/relay/src/paths.ts` | Lab root and demo directory resolution |
| `packages/relay/src/demo-files.ts` | Load manifest, `.env`, featured trace from disk |
| `packages/relay/src/lines.ts` | Runner line to event conversion, control line, SSE framing |
| `packages/relay/src/trace-builder.ts` | Build a `Trace` from recorded events and env |
| `packages/relay/src/hub.ts` | In-memory event history plus subscribers |
| `packages/relay/src/server.ts` | HTTP routes: health, manifest, events (SSE), control |
| `packages/relay/src/run.ts` | Spawn runner, wire stdout/stderr/stdin, record on exit |
| `packages/relay/src/validate.ts` | Manifest + trace validation report |
| `packages/relay/src/public-check.ts` | Denylist + internal URL scanner |
| `packages/relay/src/collect-site.ts` | Catalog builder and site data copier |
| `packages/relay/src/db-init.ts` | Create the demo database |
| `packages/relay/src/cli.ts` | `lab` command dispatcher |
| `demos/example/*` | Synthetic demo that exercises every event type (never published) |
| `packages/ui/src/state/*` | Pure reducer, selectors, replay folding |
| `packages/ui/src/format.ts` | Value and clock formatting |
| `packages/ui/src/route.ts` | Hash route parsing |
| `packages/ui/src/diagram/*` | Flow diagram geometry and component |
| `packages/ui/src/charts/*` | Sparkline path math and component |
| `packages/ui/src/components/*` | Metric tile, phase timeline, checks, logs, player, controls, environment badge |
| `packages/ui/src/sources/*` | Replay player and live SSE hooks |
| `packages/ui/src/pages/*` | Catalog and demo pages |
| `infra/tidb/playground.sh`, `infra/kafka/docker-compose.yml` | Shared infrastructure (exact content in Interfaces) |
| `.github/workflows/integrations-ci.yml` | Tests, typecheck, public-content gate on every push |

## Tasks

All commands run from `integrations/` unless a step says otherwise.

### Task 1: Workspace scaffold

**Files:**
- Create: `integrations/package.json`, `integrations/pnpm-workspace.yaml`, `integrations/tsconfig.base.json`, `integrations/.gitignore`

- [ ] **Step 1: Create the workspace files**

`integrations/package.json`:

```json
{
  "name": "tidb-integration-lab",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "lab": "pnpm --filter @lab/relay exec tsx src/cli.ts",
    "dev": "LAB_INCLUDE_UNPUBLISHED=true pnpm lab collect-site && pnpm --filter @lab/ui dev",
    "build:site": "pnpm lab check-public && pnpm lab collect-site && pnpm --filter @lab/ui build"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`integrations/pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - demos/*
```

`integrations/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`integrations/.gitignore`:

```
node_modules/
dist/
.env
.venv/
__pycache__/
demos/*/traces/*.json
!demos/*/traces/featured.json
packages/ui/public/data/
*.tfstate
*.tfstate.*
.terraform/
```

- [ ] **Step 2: Install and confirm the workspace resolves**

Run: `pnpm install`
Expected: completes with `Done in` and creates `pnpm-lock.yaml`.

Run: `pnpm test`
Expected: exits 0 with no packages run yet (`No projects matched` or empty output).

- [ ] **Step 3: Commit**

```bash
git add integrations/package.json integrations/pnpm-workspace.yaml integrations/tsconfig.base.json integrations/.gitignore integrations/pnpm-lock.yaml
git commit -m "feat(lab): scaffold integration lab workspace"
```

### Task 2: Contract package and manifest schema

**Files:**
- Create: `packages/contract/package.json`, `packages/contract/tsconfig.json`, `packages/contract/src/manifest.ts`, `packages/contract/test/fixtures.ts`, `packages/contract/test/manifest.test.ts`

- [ ] **Step 1: Create the package shell**

`packages/contract/package.json`:

```json
{
  "name": "@lab/contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./testing": "./test/fixtures.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": { "zod": "^4.1.0" },
  "devDependencies": { "typescript": "^5.9.0", "vitest": "^3.2.0" }
}
```

`packages/contract/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`
Expected: `+ zod` in the output.

- [ ] **Step 2: Write the test fixtures and failing manifest tests**

`packages/contract/test/fixtures.ts`:

```ts
import { DemoManifestSchema, type DemoManifest } from '../src/manifest';

export const manifestInput = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  id: 'example',
  number: 0,
  title: 'Example',
  tagline: 'Synthetic rows flowing through a pipeline',
  integrations: ['Synthetic'],
  pattern: 'Any team that wants to see the lab shell working',
  runner: { command: ['node', '--import', 'tsx', 'runner/main.ts'] },
  nodes: [
    { id: 'source', label: 'Source', kind: 'source', x: 10, y: 50 },
    { id: 'tidb', label: 'TiDB', kind: 'tidb', x: 50, y: 50 },
  ],
  edges: [{ id: 'source-to-tidb', from: 'source', to: 'tidb', label: 'rows', unit: 'rows' }],
  metrics: [
    {
      id: 'ingest-rate',
      label: 'Ingest',
      unit: 'rows/s',
      display: 'both',
      better: 'higher',
      howMeasured: 'Rows inserted per second over the last tick',
    },
  ],
  phases: [{ id: 'warmup', label: 'Warm up', narration: 'We start the pipeline.' }],
  checks: [{ id: 'counts-match', label: 'Counts match', description: 'Rows sent equal rows stored' }],
  controls: [{ id: 'burst', label: 'Burst', description: 'Ten times the write rate for 20 seconds' }],
  ...overrides,
});

export const aManifest = (overrides: Readonly<Record<string, unknown>> = {}): DemoManifest =>
  DemoManifestSchema.parse(manifestInput(overrides));
```

`packages/contract/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '../src/manifest';
import { manifestInput } from './fixtures';

const issuesOf = (input: unknown): string => {
  const result = DemoManifestSchema.safeParse(input);
  return result.success ? '' : JSON.stringify(result.error.issues);
};

describe('DemoManifestSchema', () => {
  it('accepts a valid manifest and applies defaults', () => {
    const parsed = DemoManifestSchema.parse(manifestInput());
    expect(parsed.publish).toBe(true);
    expect(parsed.runner.cwd).toBe('.');
  });

  it('rejects an edge that points at an unknown node', () => {
    const input = manifestInput({ edges: [{ id: 'bad', from: 'source', to: 'nowhere', label: 'x', unit: 'rows' }] });
    expect(issuesOf(input)).toContain('edge bad references an unknown node');
  });

  it('rejects duplicate metric ids', () => {
    const metric = { id: 'dup', label: 'A', unit: 'ms', display: 'tile', better: 'lower', howMeasured: 'timer' };
    expect(issuesOf(manifestInput({ metrics: [metric, metric] }))).toContain('duplicate metrics id: dup');
  });

  it('rejects ids that are not kebab-case', () => {
    expect(DemoManifestSchema.safeParse(manifestInput({ id: 'Not_Kebab' })).success).toBe(false);
  });

  it('rejects node coordinates outside 0-100', () => {
    const nodes = [
      { id: 'a', label: 'A', kind: 'tidb', x: 120, y: 0 },
      { id: 'b', label: 'B', kind: 'source', x: 0, y: 0 },
    ];
    expect(DemoManifestSchema.safeParse(manifestInput({ nodes, edges: [] })).success).toBe(false);
  });

  it('rejects a metric without howMeasured', () => {
    const metric = { id: 'm', label: 'M', unit: 'ms', display: 'tile', better: 'lower' };
    expect(DemoManifestSchema.safeParse(manifestInput({ metrics: [metric] })).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @lab/contract test`
Expected: FAIL with `Failed to resolve import "../src/manifest"`.

- [ ] **Step 4: Implement the manifest schema**

Create `packages/contract/src/manifest.ts` with exactly the code in the Interfaces section "Manifest".

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lab/contract test`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add integrations/packages/contract integrations/pnpm-lock.yaml
git commit -m "feat(contract): demo manifest schema"
```

### Task 3: Event schemas and line parsing

**Files:**
- Create: `packages/contract/src/events.ts`, `packages/contract/test/events.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/contract/test/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eventReferenceErrors, parseEventLine } from '../src/events';
import { aManifest } from './fixtures';

describe('parseEventLine', () => {
  it('parses a valid metric event', () => {
    expect(parseEventLine('{"type":"metric","t":1000,"id":"ingest-rate","value":42}')).toEqual({
      ok: true,
      event: { type: 'metric', t: 1000, id: 'ingest-rate', value: 42 },
    });
  });

  it('reports input that is not JSON', () => {
    const parsed = parseEventLine('hello world');
    expect(parsed.ok ? '' : parsed.error).toContain('not JSON');
  });

  it('rejects an unknown event type', () => {
    expect(parseEventLine('{"type":"banana","t":0}').ok).toBe(false);
  });

  it('rejects a negative flow count', () => {
    expect(parseEventLine('{"type":"flow","t":5,"edge":"source-to-tidb","count":-1}').ok).toBe(false);
  });

  it('rejects a negative timestamp', () => {
    expect(parseEventLine('{"type":"phase","t":-1,"phase":"warmup"}').ok).toBe(false);
  });
});

describe('eventReferenceErrors', () => {
  it('returns no errors for ids declared in the manifest', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'flow', t: 0, edge: 'source-to-tidb', count: 5 })).toEqual([]);
  });

  it('flags a metric id missing from the manifest', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'metric', t: 0, id: 'nope', value: 1 })).toEqual([
      'unknown metric: nope',
    ]);
  });

  it('flags an unknown control id', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'control', t: 0, id: 'launch' })).toEqual([
      'unknown control: launch',
    ]);
  });

  it('accepts a log event without a node', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'log', t: 0, level: 'info', msg: 'hi' })).toEqual([]);
  });

  it('flags a log event that names an unknown node', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'log', t: 0, level: 'info', msg: 'hi', node: 'ghost' })).toEqual([
      'unknown node: ghost',
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/contract exec vitest run test/events.test.ts`
Expected: FAIL with `Failed to resolve import "../src/events"`.

- [ ] **Step 3: Implement events**

Create `packages/contract/src/events.ts` with exactly the code in the Interfaces section "Events".

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/contract exec vitest run test/events.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/contract
git commit -m "feat(contract): event schemas and line parser"
```

### Task 4: Trace and catalog schemas, barrel export

**Files:**
- Create: `packages/contract/src/trace.ts`, `packages/contract/src/site.ts`, `packages/contract/src/index.ts`, `packages/contract/test/trace.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/contract/test/trace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CatalogSchema, TraceSchema } from '../src/index';
import { manifestInput } from './fixtures';

const traceInput = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  schemaVersion: 1,
  manifest: manifestInput(),
  recordedAt: '2026-09-25T15:00:00.000Z',
  environment: { tidb: 'tiup playground (local)', components: { kafka: 'apache/kafka 4.1.0' }, notes: '' },
  durationMs: 1000,
  events: [{ type: 'phase', t: 0, phase: 'warmup' }],
  ...overrides,
});

describe('TraceSchema', () => {
  it('accepts a valid trace', () => {
    expect(TraceSchema.safeParse(traceInput()).success).toBe(true);
  });

  it('rejects a recordedAt that is not an ISO datetime', () => {
    expect(TraceSchema.safeParse(traceInput({ recordedAt: 'yesterday' })).success).toBe(false);
  });

  it('rejects an unknown schema version', () => {
    expect(TraceSchema.safeParse(traceInput({ schemaVersion: 2 })).success).toBe(false);
  });
});

describe('CatalogSchema', () => {
  it('accepts catalog entries', () => {
    const entry = { id: 'kafka', number: 2, title: 'Kafka', tagline: 't', integrations: ['Kafka'], hasReplay: false };
    expect(CatalogSchema.safeParse([entry]).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/contract exec vitest run test/trace.test.ts`
Expected: FAIL with `Failed to resolve import "../src/index"`.

- [ ] **Step 3: Implement**

Create `packages/contract/src/trace.ts` with exactly the code in the Interfaces section "Trace", and `packages/contract/src/site.ts` with exactly the code in "Site catalog". Then `packages/contract/src/index.ts`:

```ts
export * from './manifest';
export * from './events';
export * from './trace';
export * from './site';
```

- [ ] **Step 4: Run all contract tests and typecheck**

Run: `pnpm --filter @lab/contract test && pnpm --filter @lab/contract typecheck`
Expected: PASS, 20 tests; `tsc` prints nothing and exits 0.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/contract
git commit -m "feat(contract): trace and catalog schemas"
```

### Task 5: Runner kit emitter

**Files:**
- Create: `packages/runner-kit/package.json`, `packages/runner-kit/tsconfig.json`, `packages/runner-kit/src/emitter.ts`, `packages/runner-kit/test/helpers.ts`, `packages/runner-kit/test/emitter.test.ts`

- [ ] **Step 1: Create the package shell**

`packages/runner-kit/package.json`:

```json
{
  "name": "@lab/runner-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "mysql2": "^3.14.0",
    "zod": "^4.1.0"
  },
  "devDependencies": { "@types/node": "^22.10.0", "typescript": "^5.9.0", "vitest": "^3.2.0" }
}
```

`packages/runner-kit/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`
Expected: `+ mysql2` in the output.

- [ ] **Step 2: Write test helpers and the failing emitter tests**

`packages/runner-kit/test/helpers.ts`:

```ts
export const clockFrom = (times: readonly number[]): (() => number) => {
  const iterator = times[Symbol.iterator]();
  const last = times[times.length - 1] ?? 0;
  return () => {
    const next = iterator.next();
    return next.done ? last : next.value;
  };
};

export const captureLines = (): { readonly lines: readonly string[]; readonly write: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, write: (line: string) => { lines.push(line); } };
};
```

`packages/runner-kit/test/emitter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseEventLine } from '@lab/contract';
import { createEmitter } from '../src/emitter';
import { captureLines, clockFrom } from './helpers';

describe('createEmitter', () => {
  it('stamps events with milliseconds since the emitter was created', () => {
    const out = captureLines();
    const emitter = createEmitter({ clock: clockFrom([1000, 1250]), write: out.write });
    emitter.metric('ingest-rate', 42);
    expect(JSON.parse(out.lines[0] ?? '')).toEqual({ type: 'metric', id: 'ingest-rate', value: 42, t: 250 });
  });

  it('writes one newline-terminated line per event that satisfies the contract', () => {
    const out = captureLines();
    const emitter = createEmitter({ clock: clockFrom([0, 1, 2, 3, 4, 5]), write: out.write });
    emitter.flow('source-to-tidb', 10);
    emitter.node('tidb', 'healthy', 'ready');
    emitter.phase('warmup');
    emitter.check('counts-match', 'pass', '100 = 100');
    emitter.log('info', 'started');
    expect(out.lines).toHaveLength(5);
    expect(out.lines.every((line) => line.endsWith('\n'))).toBe(true);
    expect(out.lines.every((line) => parseEventLine(line.trim()).ok)).toBe(true);
  });

  it('omits optional fields that were not given', () => {
    const out = captureLines();
    const emitter = createEmitter({ clock: clockFrom([0, 0]), write: out.write });
    emitter.node('tidb', 'down');
    expect(Object.keys(JSON.parse(out.lines[0] ?? '{}'))).not.toContain('note');
  });

  it('reports elapsed time', () => {
    const emitter = createEmitter({ clock: clockFrom([500, 900]), write: () => undefined });
    expect(emitter.elapsedMs()).toBe(400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @lab/runner-kit test`
Expected: FAIL with `Failed to resolve import "../src/emitter"`.

- [ ] **Step 4: Implement the emitter**

`packages/runner-kit/src/emitter.ts`:

```ts
import type { CheckStatus, DemoEvent, LogLevel, NodeStatus } from '@lab/contract';

export type Clock = () => number;
export type LineWriter = (line: string) => void;

export type Emitter = {
  readonly metric: (id: string, value: number) => void;
  readonly flow: (edge: string, count: number) => void;
  readonly node: (node: string, status: NodeStatus, note?: string) => void;
  readonly phase: (phase: string) => void;
  readonly check: (id: string, status: CheckStatus, observed?: string) => void;
  readonly log: (level: LogLevel, msg: string, node?: string) => void;
  readonly elapsedMs: () => number;
};

type WithoutTime<E> = E extends DemoEvent ? Omit<E, 't'> : never;
type EventBody = WithoutTime<DemoEvent>;

const stdoutWriter: LineWriter = (line) => {
  process.stdout.write(line);
};

export const createEmitter = (options: { readonly clock?: Clock; readonly write?: LineWriter } = {}): Emitter => {
  const clock = options.clock ?? Date.now;
  const write = options.write ?? stdoutWriter;
  const start = clock();
  const elapsedMs = (): number => clock() - start;
  const emit = (body: EventBody): void => write(`${JSON.stringify({ ...body, t: elapsedMs() })}\n`);
  return {
    metric: (id, value) => emit({ type: 'metric', id, value }),
    flow: (edge, count) => emit({ type: 'flow', edge, count }),
    node: (node, status, note) => emit({ type: 'node', node, status, note }),
    phase: (phase) => emit({ type: 'phase', phase }),
    check: (id, status, observed) => emit({ type: 'check', id, status, observed }),
    log: (level, msg, node) => emit({ type: 'log', level, msg, node }),
    elapsedMs,
  };
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lab/runner-kit test`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add integrations/packages/runner-kit integrations/pnpm-lock.yaml
git commit -m "feat(runner-kit): NDJSON event emitter"
```

### Task 6: Latency statistics

**Files:**
- Create: `packages/runner-kit/src/stats.ts`, `packages/runner-kit/test/stats.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/runner-kit/test/stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSampleWindow, percentile, summarize } from '../src/stats';

const oneToHundred = Array.from({ length: 100 }, (_, index) => index + 1);

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
    expect(percentile(oneToHundred, 0)).toBe(1);
  });

  it('returns undefined for no samples', () => {
    expect(percentile([], 99)).toBeUndefined();
  });

  it('does not reorder the caller array', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('summarize', () => {
  it('returns count, p50, p95, p99 and max', () => {
    expect(summarize(oneToHundred)).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('returns undefined for no samples', () => {
    expect(summarize([])).toBeUndefined();
  });
});

describe('createSampleWindow', () => {
  it('returns everything added since the last drain', () => {
    const window = createSampleWindow();
    window.add(5);
    window.add(7);
    expect(window.drain()).toEqual([5, 7]);
    window.add(9);
    expect(window.drain()).toEqual([9]);
    expect(window.drain()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/runner-kit exec vitest run test/stats.test.ts`
Expected: FAIL with `Failed to resolve import "../src/stats"`.

- [ ] **Step 3: Implement**

`packages/runner-kit/src/stats.ts`:

```ts
export type LatencySummary = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

export type SampleWindow = {
  readonly add: (value: number) => void;
  readonly drain: () => readonly number[];
};

const ascending = (values: readonly number[]): readonly number[] => [...values].sort((a, b) => a - b);

const nearestRank = (sorted: readonly number[], p: number): number | undefined => {
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
};

export const percentile = (values: readonly number[], p: number): number | undefined => {
  if (values.length === 0) return undefined;
  return nearestRank(ascending(values), p);
};

export const summarize = (values: readonly number[]): LatencySummary | undefined => {
  const sorted = ascending(values);
  const p50 = nearestRank(sorted, 50);
  const p95 = nearestRank(sorted, 95);
  const p99 = nearestRank(sorted, 99);
  const max = sorted[sorted.length - 1];
  if (p50 === undefined || p95 === undefined || p99 === undefined || max === undefined) return undefined;
  return { count: sorted.length, p50, p95, p99, max };
};

export const createSampleWindow = (): SampleWindow => {
  const values: number[] = [];
  return {
    add: (value) => {
      values.push(value);
    },
    drain: () => values.splice(0, values.length),
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/runner-kit exec vitest run test/stats.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/runner-kit
git commit -m "feat(runner-kit): percentile and sample window"
```

### Task 7: Timing helpers and control input

**Files:**
- Create: `packages/runner-kit/src/timing.ts`, `packages/runner-kit/src/control.ts`, `packages/runner-kit/test/timing.test.ts`, `packages/runner-kit/test/control.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/runner-kit/test/timing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { every, sleep, timed } from '../src/timing';
import { clockFrom } from './helpers';

describe('timed', () => {
  it('returns the task value and the elapsed milliseconds', async () => {
    const result = await timed(async () => 'done', clockFrom([10, 35]));
    expect(result).toEqual({ value: 'done', ms: 25 });
  });
});

describe('sleep', () => {
  it('resolves early when the signal aborts', async () => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 20);
    await sleep(5000, controller.signal);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('every', () => {
  it('runs the task repeatedly until aborted', async () => {
    const controller = new AbortController();
    const runs: number[] = [];
    setTimeout(() => controller.abort(), 260);
    await every({ intervalMs: 50, task: async () => { runs.push(1); }, signal: controller.signal });
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(runs.length).toBeLessThanOrEqual(7);
  });

  it('never overlaps runs when a task is slower than the interval', async () => {
    const controller = new AbortController();
    const state = { active: 0, maxActive: 0 };
    setTimeout(() => controller.abort(), 200);
    await every({
      intervalMs: 10,
      task: async () => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await sleep(30);
        state.active -= 1;
      },
      signal: controller.signal,
    });
    expect(state.maxActive).toBe(1);
  });
});
```

`packages/runner-kit/test/control.test.ts`:

```ts
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { onControl, parseControlLine } from '../src/control';
import { sleep } from '../src/timing';

describe('parseControlLine', () => {
  it('returns the control id', () => {
    expect(parseControlLine('{"control":"burst"}')).toBe('burst');
  });

  it('ignores blank lines, bad JSON and bad ids', () => {
    expect(parseControlLine('')).toBeUndefined();
    expect(parseControlLine('not json')).toBeUndefined();
    expect(parseControlLine('{"control":"Not Kebab"}')).toBeUndefined();
    expect(parseControlLine('{"other":"burst"}')).toBeUndefined();
  });
});

describe('onControl', () => {
  it('calls the handler once per valid control line', async () => {
    const input = new PassThrough();
    const received: string[] = [];
    onControl((id) => { received.push(id); }, input);
    input.write('{"control":"burst"}\n');
    input.write('garbage\n');
    input.write('{"control":"kill-ingester"}\n');
    await sleep(20);
    expect(received).toEqual(['burst', 'kill-ingester']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/runner-kit exec vitest run test/timing.test.ts test/control.test.ts`
Expected: FAIL with `Failed to resolve import "../src/timing"`.

- [ ] **Step 3: Implement**

`packages/runner-kit/src/timing.ts`:

```ts
import type { Clock } from './emitter';

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export const timed = async <T>(
  task: () => Promise<T>,
  clock: Clock = () => performance.now(),
): Promise<{ readonly value: T; readonly ms: number }> => {
  const start = clock();
  const value = await task();
  return { value, ms: clock() - start };
};

export const every = async (options: {
  readonly intervalMs: number;
  readonly task: () => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<void> => {
  while (!options.signal.aborted) {
    const started = performance.now();
    await options.task();
    const remaining = options.intervalMs - (performance.now() - started);
    await sleep(Math.max(remaining, 0), options.signal);
  }
};
```

`packages/runner-kit/src/control.ts`:

```ts
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { SlugSchema } from '@lab/contract';

const ControlLineSchema = z.object({ control: SlugSchema });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const parseControlLine = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  const result = ControlLineSchema.safeParse(parseJson(trimmed));
  return result.success ? result.data.control : undefined;
};

export const onControl = (handler: (id: string) => void, input: NodeJS.ReadableStream = process.stdin): void => {
  createInterface({ input }).on('line', (line) => {
    const id = parseControlLine(line);
    if (id !== undefined) handler(id);
  });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/runner-kit exec vitest run test/timing.test.ts test/control.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/runner-kit
git commit -m "feat(runner-kit): timing loop and stdin controls"
```

### Task 8: TiDB connection helpers

**Files:**
- Create: `packages/runner-kit/src/tidb.ts`, `packages/runner-kit/src/index.ts`, `packages/runner-kit/test/tidb.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/runner-kit/test/tidb.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { quoteIdentifier, tidbConfigFromEnv } from '../src/tidb';

describe('tidbConfigFromEnv', () => {
  it('defaults to a local playground', () => {
    expect(tidbConfigFromEnv({})).toEqual({
      host: '127.0.0.1',
      port: 4000,
      user: 'root',
      password: '',
      database: 'lab',
      enableKeepAlive: true,
      supportBigNumbers: true,
    });
  });

  it('reads host, port, user, password and database', () => {
    const config = tidbConfigFromEnv({
      TIDB_HOST: 'gateway.example.com',
      TIDB_PORT: '4001',
      TIDB_USER: 'demo.root',
      TIDB_PASSWORD: 'secret',
      TIDB_DATABASE: 'shop',
    });
    expect(config).toMatchObject({ host: 'gateway.example.com', port: 4001, user: 'demo.root', password: 'secret', database: 'shop' });
  });

  it('enables verified TLS when TIDB_TLS is true', () => {
    expect(tidbConfigFromEnv({ TIDB_TLS: 'true' }).ssl).toEqual({ minVersion: 'TLSv1.2', rejectUnauthorized: true });
  });

  it('leaves TLS off otherwise', () => {
    expect(tidbConfigFromEnv({ TIDB_TLS: 'false' }).ssl).toBeUndefined();
  });

  it('rejects a port that is not a number', () => {
    expect(() => tidbConfigFromEnv({ TIDB_PORT: 'four' })).toThrow('TIDB_PORT must be a number');
  });
});

describe('quoteIdentifier', () => {
  it('wraps a name in backticks', () => {
    expect(quoteIdentifier('orders')).toBe('`orders`');
  });

  it('doubles embedded backticks', () => {
    expect(quoteIdentifier('a`b')).toBe('`a``b`');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/runner-kit exec vitest run test/tidb.test.ts`
Expected: FAIL with `Failed to resolve import "../src/tidb"`.

- [ ] **Step 3: Implement**

`packages/runner-kit/src/tidb.ts`:

```ts
import type { PoolOptions } from 'mysql2';
import { createPool, type Pool } from 'mysql2/promise';

const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? '4000');
  if (!Number.isInteger(port)) throw new Error('TIDB_PORT must be a number');
  return port;
};

export const tidbConfigFromEnv = (env: NodeJS.ProcessEnv): PoolOptions => {
  const base: PoolOptions = {
    host: env.TIDB_HOST ?? '127.0.0.1',
    port: parsePort(env.TIDB_PORT),
    user: env.TIDB_USER ?? 'root',
    password: env.TIDB_PASSWORD ?? '',
    database: env.TIDB_DATABASE ?? 'lab',
    enableKeepAlive: true,
    supportBigNumbers: true,
  };
  if (env.TIDB_TLS !== 'true') return base;
  return { ...base, ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } };
};

export const createTidbPool = (env: NodeJS.ProcessEnv = process.env): Pool =>
  createPool({ ...tidbConfigFromEnv(env), connectionLimit: Number(env.TIDB_POOL_SIZE ?? '10') });

export const quoteIdentifier = (name: string): string => `\`${name.replaceAll('`', '``')}\``;
```

`packages/runner-kit/src/index.ts`:

```ts
export * from './emitter';
export * from './stats';
export * from './timing';
export * from './control';
export * from './tidb';
```

- [ ] **Step 4: Run all runner-kit tests and typecheck**

Run: `pnpm --filter @lab/runner-kit test && pnpm --filter @lab/runner-kit typecheck`
Expected: PASS, 24 tests; `tsc` exits 0.

- [ ] **Step 5: Live check against a local playground**

Run in a second terminal: `bash infra/tidb/playground.sh` (create the file first with the exact content in "Shared infrastructure", then `chmod +x infra/tidb/playground.sh`).
Expected: after about a minute, `TiDB Playground Cluster is started` with `Connect TiDB: mysql --host 127.0.0.1 --port 4000 -u root`.

Run: `pnpm --filter @lab/runner-kit exec tsx -e "import('./src/index.ts').then(async (kit) => { const pool = kit.createTidbPool({ TIDB_DATABASE: 'test' }); const [rows] = await pool.query('SELECT VERSION() AS v'); console.log(rows); await pool.end(); })"`
Expected: one row like `[ { v: '8.0.11-TiDB-v...' } ]`.

- [ ] **Step 6: Commit**

```bash
git add integrations/packages/runner-kit integrations/infra/tidb/playground.sh
git commit -m "feat(runner-kit): TiDB pool from env and identifier quoting"
```

### Task 9: Python runner kit

**Files:**
- Create: `packages/runner-kit-py/pyproject.toml`, `packages/runner-kit-py/lab_runner/__init__.py`, `packages/runner-kit-py/tests/test_lab_runner.py`

- [ ] **Step 1: Create the package metadata**

`packages/runner-kit-py/pyproject.toml`:

```toml
[project]
name = "lab-runner"
version = "0.0.0"
requires-python = ">=3.11"
dependencies = ["pymysql>=1.1"]

[project.optional-dependencies]
test = ["pytest>=8"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
packages = ["lab_runner"]
```

Run: `cd packages/runner-kit-py && python3 -m venv .venv && .venv/bin/pip install -e '.[test]'`
Expected: `Successfully installed lab-runner-0.0.0 ...`

- [ ] **Step 2: Write the failing tests**

`packages/runner-kit-py/tests/test_lab_runner.py`:

```python
import io
import json
import time

import pytest

from lab_runner import (
    Emitter,
    SampleWindow,
    on_control,
    parse_control_line,
    percentile,
    summarize,
    tidb_config_from_env,
    timed,
)


def clock_from(times):
    values = iter(times)
    last = times[-1]
    return lambda: next(values, last)


def capture():
    lines = []
    return lines, lines.append


def test_emitter_stamps_elapsed_time():
    lines, write = capture()
    emitter = Emitter(clock=clock_from([1000.0, 1250.0]), write=write)
    emitter.metric("ingest-rate", 42)
    assert json.loads(lines[0]) == {"type": "metric", "id": "ingest-rate", "value": 42, "t": 250.0}


def test_emitter_omits_missing_optionals_and_terminates_lines():
    lines, write = capture()
    emitter = Emitter(clock=clock_from([0.0, 1.0]), write=write)
    emitter.node("tidb", "down")
    assert lines[0].endswith("\n")
    assert "note" not in json.loads(lines[0])


def test_percentile_nearest_rank():
    values = list(range(1, 101))
    assert percentile(values, 50) == 50
    assert percentile(values, 99) == 99
    assert percentile([], 99) is None


def test_summarize():
    summary = summarize(list(range(1, 101)))
    assert (summary.count, summary.p50, summary.p95, summary.p99, summary.max) == (100, 50, 95, 99, 100)
    assert summarize([]) is None


def test_sample_window_drains():
    window = SampleWindow()
    window.add(5.0)
    window.add(7.0)
    assert window.drain() == (5.0, 7.0)
    assert window.drain() == ()


def test_timed_returns_value_and_elapsed_ms():
    value, ms = timed(lambda: "done", clock=clock_from([10.0, 35.0]))
    assert (value, ms) == ("done", 25.0)


def test_parse_control_line():
    assert parse_control_line('{"control":"burst"}') == "burst"
    assert parse_control_line("garbage") is None
    assert parse_control_line('{"control":"Not Kebab"}') is None


def test_on_control_reads_lines():
    received = []
    on_control(received.append, io.StringIO('{"control":"burst"}\nbad\n'))
    time.sleep(0.05)
    assert received == ["burst"]


def test_tidb_config_defaults_and_tls():
    assert tidb_config_from_env({}) == {
        "host": "127.0.0.1",
        "port": 4000,
        "user": "root",
        "password": "",
        "database": "lab",
    }
    tls = tidb_config_from_env({"TIDB_TLS": "true"})
    assert tls["ssl_verify_cert"] is True
    assert tls["ssl_verify_identity"] is True
    assert tls["ssl_ca"] == "/etc/ssl/cert.pem"


def test_tidb_config_rejects_bad_port():
    with pytest.raises(ValueError, match="TIDB_PORT must be a number"):
        tidb_config_from_env({"TIDB_PORT": "four"})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/runner-kit-py && .venv/bin/pytest -q`
Expected: FAIL with `ImportError: cannot import name 'Emitter' from 'lab_runner'` (create an empty `lab_runner/__init__.py` first if pip complained the package directory is missing).

- [ ] **Step 4: Implement**

`packages/runner-kit-py/lab_runner/__init__.py`:

```python
from __future__ import annotations

import json
import re
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence, TextIO

import pymysql

Clock = Callable[[], float]
Writer = Callable[[str], None]

_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _monotonic_ms() -> float:
    return time.monotonic() * 1000.0


def _stdout_write(line: str) -> None:
    sys.stdout.write(line)
    sys.stdout.flush()


class Emitter:
    def __init__(self, clock: Optional[Clock] = None, write: Optional[Writer] = None) -> None:
        self._clock = clock or _monotonic_ms
        self._write = write or _stdout_write
        self._start = self._clock()
        self._lock = threading.Lock()

    def elapsed_ms(self) -> float:
        return self._clock() - self._start

    def _emit(self, body: Mapping[str, object]) -> None:
        payload = {key: value for key, value in body.items() if value is not None}
        with self._lock:
            self._write(json.dumps({**payload, "t": self.elapsed_ms()}) + "\n")

    def metric(self, id: str, value: float) -> None:
        self._emit({"type": "metric", "id": id, "value": value})

    def flow(self, edge: str, count: int) -> None:
        self._emit({"type": "flow", "edge": edge, "count": count})

    def node(self, node: str, status: str, note: Optional[str] = None) -> None:
        self._emit({"type": "node", "node": node, "status": status, "note": note})

    def phase(self, phase: str) -> None:
        self._emit({"type": "phase", "phase": phase})

    def check(self, id: str, status: str, observed: Optional[str] = None) -> None:
        self._emit({"type": "check", "id": id, "status": status, "observed": observed})

    def log(self, level: str, msg: str, node: Optional[str] = None) -> None:
        self._emit({"type": "log", "level": level, "msg": msg, "node": node})


@dataclass(frozen=True)
class LatencySummary:
    count: int
    p50: float
    p95: float
    p99: float
    max: float


def _nearest_rank(sorted_values: Sequence[float], p: float) -> float:
    rank = -(-p * len(sorted_values) // 100)
    index = min(max(int(rank) - 1, 0), len(sorted_values) - 1)
    return sorted_values[index]


def percentile(values: Sequence[float], p: float) -> Optional[float]:
    if not values:
        return None
    return _nearest_rank(sorted(values), p)


def summarize(values: Sequence[float]) -> Optional[LatencySummary]:
    if not values:
        return None
    ordered = sorted(values)
    return LatencySummary(
        count=len(ordered),
        p50=_nearest_rank(ordered, 50),
        p95=_nearest_rank(ordered, 95),
        p99=_nearest_rank(ordered, 99),
        max=ordered[-1],
    )


class SampleWindow:
    def __init__(self) -> None:
        self._values: list = []
        self._lock = threading.Lock()

    def add(self, value: float) -> None:
        with self._lock:
            self._values.append(value)

    def drain(self) -> tuple:
        with self._lock:
            drained = tuple(self._values)
            self._values.clear()
            return drained


def timed(task: Callable[[], object], clock: Optional[Clock] = None) -> tuple:
    now = clock or _monotonic_ms
    start = now()
    value = task()
    return value, now() - start


def parse_control_line(line: str) -> Optional[str]:
    text = line.strip()
    if not text:
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    control = payload.get("control") if isinstance(payload, dict) else None
    if isinstance(control, str) and _SLUG.match(control):
        return control
    return None


def on_control(handler: Callable[[str], None], stream: Optional[TextIO] = None) -> threading.Thread:
    source = stream or sys.stdin

    def read() -> None:
        for line in source:
            control = parse_control_line(line)
            if control is not None:
                handler(control)

    thread = threading.Thread(target=read, daemon=True)
    thread.start()
    return thread


def _port(value: Optional[str]) -> int:
    text = value or "4000"
    if not text.isdigit():
        raise ValueError("TIDB_PORT must be a number")
    return int(text)


def tidb_config_from_env(env: Mapping[str, str]) -> dict:
    base = {
        "host": env.get("TIDB_HOST", "127.0.0.1"),
        "port": _port(env.get("TIDB_PORT")),
        "user": env.get("TIDB_USER", "root"),
        "password": env.get("TIDB_PASSWORD", ""),
        "database": env.get("TIDB_DATABASE", "lab"),
    }
    if env.get("TIDB_TLS") != "true":
        return base
    return {
        **base,
        "ssl_verify_cert": True,
        "ssl_verify_identity": True,
        "ssl_ca": env.get("TIDB_CA_PATH", "/etc/ssl/cert.pem"),
    }


def tidb_connect_from_env(env: Optional[Mapping[str, str]] = None) -> pymysql.connections.Connection:
    import os

    return pymysql.connect(**tidb_config_from_env(env if env is not None else os.environ), autocommit=True)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/runner-kit-py && .venv/bin/pytest -q`
Expected: `10 passed`.

- [ ] **Step 6: Commit**

```bash
git add integrations/packages/runner-kit-py
git commit -m "feat(runner-kit-py): Python mirror of the runner kit"
```


### Task 10: Relay package, paths and demo files

**Files:**
- Create: `packages/relay/package.json`, `packages/relay/tsconfig.json`, `packages/relay/src/paths.ts`, `packages/relay/src/demo-files.ts`, `packages/relay/test/demo-files.test.ts`

- [ ] **Step 1: Create the package shell**

`packages/relay/package.json`:

```json
{
  "name": "@lab/relay",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "dotenv": "^17.0.0",
    "mysql2": "^3.14.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`packages/relay/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`
Expected: `+ dotenv` in the output.

- [ ] **Step 2: Write the failing tests**

`packages/relay/test/demo-files.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestInput } from '@lab/contract/testing';
import { listDemoIds, loadDemoEnv, loadFeaturedTrace, loadManifest } from '../src/demo-files';
import { demoDir } from '../src/paths';

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'lab-'));
  const dir = demoDir(root, 'example');
  await mkdir(join(dir, 'traces'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifestInput()));
  await mkdir(join(root, 'demos', 'no-manifest'), { recursive: true });
  return root;
};

describe('demo files', () => {
  it('loads and validates a manifest', async () => {
    const root = await makeRoot();
    expect((await loadManifest(demoDir(root, 'example'))).id).toBe('example');
  });

  it('returns an empty env when .env is missing', async () => {
    const root = await makeRoot();
    expect(await loadDemoEnv(demoDir(root, 'example'))).toEqual({});
  });

  it('parses .env when present', async () => {
    const root = await makeRoot();
    await writeFile(join(demoDir(root, 'example'), '.env'), 'TIDB_HOST=db.local\nLAB_ENV_TIDB=playground\n');
    expect(await loadDemoEnv(demoDir(root, 'example'))).toEqual({ TIDB_HOST: 'db.local', LAB_ENV_TIDB: 'playground' });
  });

  it('returns undefined when there is no featured trace', async () => {
    const root = await makeRoot();
    expect(await loadFeaturedTrace(demoDir(root, 'example'))).toBeUndefined();
  });

  it('lists only demo folders that have a manifest', async () => {
    const root = await makeRoot();
    expect(await listDemoIds(root)).toEqual(['example']);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @lab/relay test`
Expected: FAIL with `Failed to resolve import "../src/demo-files"`.

- [ ] **Step 4: Implement**

`packages/relay/src/paths.ts`:

```ts
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const labRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LAB_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));

export const demoDir = (root: string, id: string): string => join(root, 'demos', id);
```

`packages/relay/src/demo-files.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { DemoManifestSchema, TraceSchema, type DemoManifest, type Trace } from '@lab/contract';

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

export const loadManifest = async (dir: string): Promise<DemoManifest> =>
  DemoManifestSchema.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));

export const loadDemoEnv = async (dir: string): Promise<Readonly<Record<string, string>>> => {
  const text = await readOptional(join(dir, '.env'));
  return text === undefined ? {} : parse(text);
};

export const loadFeaturedTrace = async (dir: string): Promise<Trace | undefined> => {
  const text = await readOptional(join(dir, 'traces', 'featured.json'));
  return text === undefined ? undefined : TraceSchema.parse(JSON.parse(text));
};

export const listDemoIds = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(join(root, 'demos'), { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const withManifest = await Promise.all(
    candidates.map(async (id) => ((await readOptional(join(root, 'demos', id, 'manifest.json'))) === undefined ? undefined : id)),
  );
  return withManifest.filter((id): id is string => id !== undefined).sort();
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lab/relay test`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add integrations/packages/relay integrations/pnpm-lock.yaml
git commit -m "feat(relay): demo file loading"
```

### Task 11: Line conversion and trace building

**Files:**
- Create: `packages/relay/src/lines.ts`, `packages/relay/src/trace-builder.ts`, `packages/relay/test/lines.test.ts`, `packages/relay/test/trace-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/relay/test/lines.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { controlLine, sseMessage, stderrEvent, toLabEvent } from '../src/lines';

describe('toLabEvent', () => {
  it('passes a valid event through unchanged', () => {
    expect(toLabEvent(aManifest(), '{"type":"phase","t":10,"phase":"warmup"}', 99)).toEqual({ type: 'phase', t: 10, phase: 'warmup' });
  });

  it('turns non-JSON into a warning at relay time', () => {
    const event = toLabEvent(aManifest(), 'Listening on 3000', 99);
    expect(event).toMatchObject({ type: 'log', t: 99, level: 'warn' });
    expect(event.type === 'log' ? event.msg : '').toContain('invalid event: not JSON');
  });

  it('turns an unknown metric into a warning', () => {
    const event = toLabEvent(aManifest(), '{"type":"metric","t":1,"id":"ghost","value":1}', 5);
    expect(event.type === 'log' ? event.msg : '').toContain('unknown metric: ghost');
  });

  it('refuses control events coming from a runner', () => {
    const event = toLabEvent(aManifest(), '{"type":"control","t":1,"id":"burst"}', 5);
    expect(event.type === 'log' ? event.msg : '').toContain('runners may not emit control events');
  });
});

describe('framing helpers', () => {
  it('wraps stderr as a warning', () => {
    expect(stderrEvent('boom', 7)).toEqual({ type: 'log', t: 7, level: 'warn', msg: 'boom' });
  });

  it('builds a control line', () => {
    expect(controlLine('burst')).toBe('{"control":"burst"}\n');
  });

  it('frames an SSE message', () => {
    expect(sseMessage({ type: 'phase', t: 0, phase: 'warmup' })).toBe('data: {"type":"phase","t":0,"phase":"warmup"}\n\n');
  });
});
```

`packages/relay/test/trace-builder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TraceSchema } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { buildTrace, traceFileName } from '../src/trace-builder';

const recordedAt = new Date('2026-09-25T15:00:00.000Z');

describe('buildTrace', () => {
  it('sorts events, computes duration and maps LAB_ENV variables', () => {
    const trace = buildTrace({
      manifest: aManifest(),
      events: [
        { type: 'metric', t: 2000, id: 'ingest-rate', value: 5 },
        { type: 'phase', t: 0, phase: 'warmup' },
      ],
      recordedAt,
      env: { LAB_ENV_TIDB: 'tiup playground', LAB_ENV_NOTES: 'laptop', LAB_ENV_COMPONENT_KAFKA: 'apache/kafka 4.1.0', OTHER: 'x' },
    });
    expect(TraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.events.map((event) => event.t)).toEqual([0, 2000]);
    expect(trace.durationMs).toBe(2000);
    expect(trace.environment).toEqual({ tidb: 'tiup playground', components: { kafka: 'apache/kafka 4.1.0' }, notes: 'laptop' });
  });

  it('marks an unspecified environment honestly', () => {
    expect(buildTrace({ manifest: aManifest(), events: [], recordedAt, env: {} }).environment.tidb).toBe('unspecified');
  });
});

describe('traceFileName', () => {
  it('is filesystem safe', () => {
    expect(traceFileName(recordedAt)).toBe('2026-09-25T15-00-00-000Z.json');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/relay exec vitest run test/lines.test.ts test/trace-builder.test.ts`
Expected: FAIL with `Failed to resolve import "../src/lines"`.

- [ ] **Step 3: Implement**

`packages/relay/src/lines.ts`:

```ts
import { eventReferenceErrors, parseEventLine, type DemoEvent, type DemoManifest } from '@lab/contract';

const warning = (t: number, msg: string): DemoEvent => ({ type: 'log', t, level: 'warn', msg });

export const toLabEvent = (manifest: DemoManifest, line: string, t: number): DemoEvent => {
  const parsed = parseEventLine(line);
  if (!parsed.ok) return warning(t, `invalid event: ${parsed.error}`);
  if (parsed.event.type === 'control') return warning(t, 'invalid event: runners may not emit control events');
  const errors = eventReferenceErrors(manifest, parsed.event);
  if (errors.length > 0) return warning(t, `invalid event: ${errors.join('; ')}`);
  return parsed.event;
};

export const stderrEvent = (line: string, t: number): DemoEvent => warning(t, line);

export const controlLine = (id: string): string => `${JSON.stringify({ control: id })}\n`;

export const sseMessage = (event: DemoEvent): string => `data: ${JSON.stringify(event)}\n\n`;
```

`packages/relay/src/trace-builder.ts`:

```ts
import type { DemoEvent, DemoManifest, Trace } from '@lab/contract';

const COMPONENT_PREFIX = 'LAB_ENV_COMPONENT_';

const componentsFromEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[0].startsWith(COMPONENT_PREFIX) && entry[1] !== undefined)
      .map(([key, value]) => [key.slice(COMPONENT_PREFIX.length).toLowerCase(), value]),
  );

export const buildTrace = (options: {
  readonly manifest: DemoManifest;
  readonly events: readonly DemoEvent[];
  readonly recordedAt: Date;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Trace => ({
  schemaVersion: 1,
  manifest: options.manifest,
  recordedAt: options.recordedAt.toISOString(),
  environment: {
    tidb: options.env.LAB_ENV_TIDB ?? 'unspecified',
    components: componentsFromEnv(options.env),
    notes: options.env.LAB_ENV_NOTES ?? '',
  },
  durationMs: options.events.reduce((max, event) => Math.max(max, event.t), 0),
  events: [...options.events].sort((a, b) => a.t - b.t),
});

export const traceFileName = (recordedAt: Date): string => `${recordedAt.toISOString().replace(/[:.]/g, '-')}.json`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/relay exec vitest run test/lines.test.ts test/trace-builder.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/relay
git commit -m "feat(relay): line conversion and trace builder"
```

### Task 12: Event hub and HTTP server

**Files:**
- Create: `packages/relay/src/hub.ts`, `packages/relay/src/server.ts`, `packages/relay/test/server.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/relay/test/server.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { createHub } from '../src/hub';
import { createRelayServer, parseOrigins } from '../src/server';

const startServer = async () => {
  const hub = createHub();
  const sent: string[] = [];
  const server = createRelayServer({
    manifest: aManifest(),
    hub,
    sendControl: (id) => { sent.push(id); },
    allowedOrigins: ['http://localhost:5173'],
    now: () => 123,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { hub, sent, base: `http://127.0.0.1:${port}`, close };
};

const readUntil = async (response: Response, done: (text: string) => boolean): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  const step = async (text: string): Promise<string> => {
    if (done(text)) return text;
    const chunk = await reader.read();
    if (chunk.done) return text;
    return step(text + decoder.decode(chunk.value));
  };
  const text = await step('');
  await reader.cancel();
  return text;
};

describe('relay server', () => {
  it('reports health', async () => {
    const relay = await startServer();
    const body: unknown = await (await fetch(`${relay.base}/health`)).json();
    expect(body).toEqual({ ok: true, demo: 'example' });
    await relay.close();
  });

  it('replays history to a late subscriber, then streams live events', async () => {
    const relay = await startServer();
    relay.hub.publish({ type: 'phase', t: 0, phase: 'warmup' });
    const response = await fetch(`${relay.base}/events`);
    relay.hub.publish({ type: 'metric', t: 1000, id: 'ingest-rate', value: 7 });
    const text = await readUntil(response, (soFar) => (soFar.match(/^data: /gm) ?? []).length >= 2);
    expect(text).toContain('"phase":"warmup"');
    expect(text).toContain('"value":7');
    await relay.close();
  });

  it('forwards a known control to the runner and records it', async () => {
    const relay = await startServer();
    const response = await fetch(`${relay.base}/control/burst`, { method: 'POST' });
    expect(response.status).toBe(202);
    expect(relay.sent).toEqual(['burst']);
    expect(relay.hub.events()).toEqual([{ type: 'control', t: 123, id: 'burst' }]);
    await relay.close();
  });

  it('rejects an unknown control', async () => {
    const relay = await startServer();
    expect((await fetch(`${relay.base}/control/launch`, { method: 'POST' })).status).toBe(404);
    expect(relay.sent).toEqual([]);
    await relay.close();
  });

  it('echoes CORS only for allowed origins', async () => {
    const relay = await startServer();
    const allowed = await fetch(`${relay.base}/health`, { headers: { origin: 'http://localhost:5173' } });
    const denied = await fetch(`${relay.base}/health`, { headers: { origin: 'https://evil.example' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    await relay.close();
  });
});

describe('parseOrigins', () => {
  it('defaults to the Vite dev server and splits a list', () => {
    expect(parseOrigins(undefined)).toEqual(['http://localhost:5173']);
    expect(parseOrigins('https://a.example, https://b.example')).toEqual(['https://a.example', 'https://b.example']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/relay exec vitest run test/server.test.ts`
Expected: FAIL with `Failed to resolve import "../src/hub"`.

- [ ] **Step 3: Implement**

`packages/relay/src/hub.ts`:

```ts
import type { DemoEvent } from '@lab/contract';

export type Hub = {
  readonly publish: (event: DemoEvent) => void;
  readonly events: () => readonly DemoEvent[];
  readonly subscribe: (listener: (event: DemoEvent) => void) => () => void;
};

export const createHub = (): Hub => {
  const history: DemoEvent[] = [];
  const listeners = new Set<(event: DemoEvent) => void>();
  return {
    publish: (event) => {
      history.push(event);
      listeners.forEach((listener) => listener(event));
    },
    events: () => [...history],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
```

`packages/relay/src/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DemoManifest } from '@lab/contract';
import type { Hub } from './hub';
import { sseMessage } from './lines';

export type RelayServerOptions = {
  readonly manifest: DemoManifest;
  readonly hub: Hub;
  readonly sendControl: (id: string) => void;
  readonly allowedOrigins: readonly string[];
  readonly now: () => number;
};

export const parseOrigins = (value: string | undefined): readonly string[] =>
  (value ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const applyCors = (req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): void => {
  const origin = req.headers.origin;
  if (origin === undefined || !allowed.includes(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
};

const streamEvents = (req: IncomingMessage, res: ServerResponse, hub: Hub): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  hub.events().forEach((event) => res.write(sseMessage(event)));
  const unsubscribe = hub.subscribe((event) => res.write(sseMessage(event)));
  req.on('close', unsubscribe);
};

const controlIdFrom = (path: string): string | undefined => /^\/control\/([a-z0-9-]+)$/.exec(path)?.[1];

export const createRelayServer = (options: RelayServerOptions): Server =>
  createServer((req, res) => {
    applyCors(req, res, options.allowedOrigins);
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' });
      res.end();
      return;
    }
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, demo: options.manifest.id });
    if (req.method === 'GET' && path === '/manifest') return sendJson(res, 200, options.manifest);
    if (req.method === 'GET' && path === '/events') return streamEvents(req, res, options.hub);
    const id = req.method === 'POST' ? controlIdFrom(path) : undefined;
    if (id === undefined) return sendJson(res, 404, { error: 'not found' });
    if (!options.manifest.controls.some((control) => control.id === id)) return sendJson(res, 404, { error: `unknown control: ${id}` });
    options.sendControl(id);
    options.hub.publish({ type: 'control', t: options.now(), id });
    return sendJson(res, 202, { ok: true, control: id });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/relay exec vitest run test/server.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/relay
git commit -m "feat(relay): event hub and SSE server"
```

### Task 13: Spawning and recording a runner

**Files:**
- Create: `packages/relay/src/run.ts`, `packages/relay/test/run.test.ts`

- [ ] **Step 1: Write the failing integration test**

`packages/relay/test/run.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TraceSchema } from '@lab/contract';
import { manifestInput } from '@lab/contract/testing';
import { runDemo } from '../src/run';

const ECHO_RUNNER = [
  "import { createInterface } from 'node:readline';",
  "const out = (event, done) => process.stdout.write(JSON.stringify(event) + '\\n', done);",
  "out({ type: 'phase', t: 0, phase: 'warmup' });",
  "createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const { control } = JSON.parse(line);",
  "  out({ type: 'log', t: 1, level: 'info', msg: 'got ' + control }, () => process.exit(0));",
  '});',
].join('\n');

const makeEchoDemo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'lab-run-'));
  const dir = join(root, 'demos', 'example');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'runner.mjs'), ECHO_RUNNER);
  await writeFile(join(dir, '.env'), 'LAB_ENV_TIDB=none (echo test)\n');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifestInput({ runner: { command: [process.execPath, 'runner.mjs'] } })));
  return root;
};

describe('runDemo', () => {
  it('streams runner output, forwards controls and records a valid trace', async () => {
    const root = await makeEchoDemo();
    const handle = await runDemo({ root, id: 'example', record: true, port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await fetch(`${handle.url}/control/burst`, { method: 'POST' })).status).toBe(202);
    const result = await handle.finished;
    expect(result.exitCode).toBe(0);
    const trace = TraceSchema.parse(JSON.parse(await readFile(result.tracePath ?? '', 'utf8')));
    expect(trace.environment.tidb).toBe('none (echo test)');
    expect(trace.events.map((event) => event.type)).toEqual(['phase', 'log', 'control']);
    expect(trace.events.some((event) => event.type === 'log' && event.msg === 'got burst')).toBe(true);
  }, 15000);
});
```

The expected order is `phase` (t 0), `log` (t 1), then `control` (relay time, about 300 ms), because traces are sorted by `t`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lab/relay exec vitest run test/run.test.ts`
Expected: FAIL with `Failed to resolve import "../src/run"`.

- [ ] **Step 3: Implement**

`packages/relay/src/run.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DemoEvent, DemoManifest } from '@lab/contract';
import { loadDemoEnv, loadManifest } from './demo-files';
import { createHub } from './hub';
import { controlLine, stderrEvent, toLabEvent } from './lines';
import { demoDir } from './paths';
import { createRelayServer, parseOrigins } from './server';
import { buildTrace, traceFileName } from './trace-builder';

export type RunResult = { readonly exitCode: number; readonly tracePath: string | undefined };
export type RunHandle = { readonly url: string; readonly finished: Promise<RunResult>; readonly stop: () => void };

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    });
  });

const writeTrace = async (options: {
  readonly dir: string;
  readonly manifest: DemoManifest;
  readonly events: readonly DemoEvent[];
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<string> => {
  const recordedAt = new Date();
  const trace = buildTrace({ manifest: options.manifest, events: options.events, recordedAt, env: options.env });
  const path = join(options.dir, 'traces', traceFileName(recordedAt));
  await mkdir(join(options.dir, 'traces'), { recursive: true });
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`);
  return path;
};

export const runDemo = async (options: {
  readonly root: string;
  readonly id: string;
  readonly record: boolean;
  readonly port: number;
}): Promise<RunHandle> => {
  const dir = demoDir(options.root, options.id);
  const manifest = await loadManifest(dir);
  const env = { ...process.env, ...(await loadDemoEnv(dir)) };
  const started = performance.now();
  const now = (): number => Math.round(performance.now() - started);
  const hub = createHub();
  const [command, ...args] = manifest.runner.command;
  if (command === undefined) throw new Error('runner.command is empty');
  const child = spawn(command, args, { cwd: join(dir, manifest.runner.cwd), env, stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: child.stdout }).on('line', (line) => hub.publish(toLabEvent(manifest, line, now())));
  createInterface({ input: child.stderr }).on('line', (line) => hub.publish(stderrEvent(line, now())));
  const server = createRelayServer({
    manifest,
    hub,
    sendControl: (id) => {
      child.stdin.write(controlLine(id));
    },
    allowedOrigins: parseOrigins(env.LAB_ALLOWED_ORIGINS),
    now,
  });
  const port = await listen(server, options.port);
  const finished = new Promise<RunResult>((resolve, reject) => {
    child.on('close', (code) => {
      const tracePath = options.record ? writeTrace({ dir, manifest, events: hub.events(), env }) : Promise.resolve(undefined);
      tracePath.then((path) => {
        server.closeAllConnections();
        server.close();
        resolve({ exitCode: code ?? 0, tracePath: path });
      }, reject);
    });
  });
  return { url: `http://localhost:${port}`, finished, stop: () => { child.kill('SIGINT'); } };
};
```

`close` (not `exit`) is used so every stdout line is read before the trace is written.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @lab/relay exec vitest run test/run.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/relay
git commit -m "feat(relay): spawn runner, forward controls, record traces"
```

### Task 14: Validation, public-content gate, site collection, database init

**Files:**
- Create: `packages/relay/src/validate.ts`, `packages/relay/src/public-check.ts`, `packages/relay/src/collect-site.ts`, `packages/relay/src/db-init.ts`
- Test: `packages/relay/test/validate.test.ts`, `packages/relay/test/public-check.test.ts`, `packages/relay/test/collect-site.test.ts`, `packages/relay/test/db-init.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/relay/test/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DemoEvent, Trace } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { validateTrace } from '../src/validate';

const traceWith = (events: readonly DemoEvent[], manifest = aManifest()): Trace => ({
  schemaVersion: 1,
  manifest,
  recordedAt: '2026-09-25T15:00:00.000Z',
  environment: { tidb: 'tiup playground', components: {}, notes: '' },
  durationMs: 1000,
  events: [...events],
});

describe('validateTrace', () => {
  it('accepts a clean trace', () => {
    const report = validateTrace(aManifest(), traceWith([{ type: 'phase', t: 0, phase: 'warmup' }]));
    expect(report).toEqual({ errors: [], warnings: [], eventCount: 1 });
  });

  it('reports unknown references, ordering and a missing phase', () => {
    const report = validateTrace(aManifest(), traceWith([
      { type: 'metric', t: 50, id: 'ghost', value: 1 },
      { type: 'flow', t: 10, edge: 'source-to-tidb', count: 1 },
    ]));
    expect(report.errors).toEqual(['event 0: unknown metric: ghost', 'events are not sorted by t', 'trace has no phase events']);
  });

  it('warns when the manifest changed after recording', () => {
    const report = validateTrace(aManifest({ title: 'Renamed' }), traceWith([{ type: 'phase', t: 0, phase: 'warmup' }]));
    expect(report.warnings).toEqual(['manifest changed since this trace was recorded; re-record before publishing']);
  });

  it('rejects a trace recorded for another demo', () => {
    const report = validateTrace(aManifest(), traceWith([{ type: 'phase', t: 0, phase: 'warmup' }], aManifest({ id: 'kafka' })));
    expect(report.errors[0]).toBe('trace belongs to kafka, not example');
  });
});
```

`packages/relay/test/public-check.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isScannable, parseDenylist, scanText } from '../src/public-check';

const internalWiki = ['https://example', 'feishu', 'cn/wiki/abc'].join('.');

describe('parseDenylist', () => {
  it('drops blank lines and comments', () => {
    expect(parseDenylist('# customers\nAcme Rockets\n\n  Globex  \n')).toEqual(['Acme Rockets', 'Globex']);
  });
});

describe('scanText', () => {
  it('flags a denylisted name by entry number, never by name', () => {
    const findings = scanText({ file: 'README.md', text: 'intro\nwe migrated Acme Rockets to TiDB', denylist: ['Acme Rockets'] });
    expect(findings).toEqual([{ file: 'README.md', line: 2, match: 'denylist entry 1' }]);
  });

  it('matches whole words only', () => {
    expect(scanText({ file: 'a.md', text: 'Acme Rocketship', denylist: ['Acme Rockets'] })).toEqual([]);
  });

  it('flags internal URLs', () => {
    expect(scanText({ file: 'a.md', text: `see ${internalWiki}`, denylist: [] })).toHaveLength(1);
  });
});

describe('isScannable', () => {
  it('skips binary assets and lockfiles', () => {
    expect(isScannable('demos/kafka/README.md')).toBe(true);
    expect(isScannable('packages/ui/public/logo.png')).toBe(false);
    expect(isScannable('pnpm-lock.yaml')).toBe(false);
  });
});
```

`packages/relay/test/collect-site.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { buildCatalog } from '../src/collect-site';

const demos = [
  { manifest: aManifest({ id: 'kafka', number: 2, title: 'Kafka' }), hasFeaturedTrace: true },
  { manifest: aManifest({ id: 'example', number: 0, publish: false }), hasFeaturedTrace: true },
  { manifest: aManifest({ id: 'aws-dms', number: 1, title: 'DMS' }), hasFeaturedTrace: false },
];

describe('buildCatalog', () => {
  it('lists published demos in number order', () => {
    expect(buildCatalog(demos, false).map((entry) => [entry.id, entry.hasReplay])).toEqual([
      ['aws-dms', false],
      ['kafka', true],
    ]);
  });

  it('includes unpublished demos only when asked', () => {
    expect(buildCatalog(demos, true).map((entry) => entry.id)).toEqual(['example', 'aws-dms', 'kafka']);
  });
});
```

`packages/relay/test/db-init.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDatabaseSql } from '../src/db-init';

describe('createDatabaseSql', () => {
  it('quotes the database name', () => {
    expect(createDatabaseSql('lab')).toBe('CREATE DATABASE IF NOT EXISTS `lab`');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/relay exec vitest run test/validate.test.ts test/public-check.test.ts test/collect-site.test.ts test/db-init.test.ts`
Expected: FAIL with `Failed to resolve import "../src/validate"`.

- [ ] **Step 3: Implement**

`packages/relay/src/validate.ts`:

```ts
import { eventReferenceErrors, type DemoEvent, type DemoManifest, type Trace } from '@lab/contract';

export type ValidationReport = {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly eventCount: number;
};

const isSortedByTime = (events: readonly DemoEvent[]): boolean =>
  events.every((event, index) => index === 0 || (events[index - 1]?.t ?? 0) <= event.t);

export const validateTrace = (current: DemoManifest, trace: Trace): ValidationReport => ({
  errors: [
    ...(trace.manifest.id === current.id ? [] : [`trace belongs to ${trace.manifest.id}, not ${current.id}`]),
    ...trace.events.flatMap((event, index) =>
      eventReferenceErrors(trace.manifest, event).map((message) => `event ${index}: ${message}`),
    ),
    ...(isSortedByTime(trace.events) ? [] : ['events are not sorted by t']),
    ...(trace.events.some((event) => event.type === 'phase') ? [] : ['trace has no phase events']),
  ],
  warnings:
    JSON.stringify(trace.manifest) === JSON.stringify(current)
      ? []
      : ['manifest changed since this trace was recorded; re-record before publishing'],
  eventCount: trace.events.length,
});
```

`packages/relay/src/public-check.ts`:

```ts
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readOptional } from './demo-files';

export type Finding = { readonly file: string; readonly line: number; readonly match: string };

export const INTERNAL_URL_PATTERNS: readonly RegExp[] = [
  /feishu\.cn/i,
  /larksuite\.com/i,
  /larkoffice\.com/i,
  /docs\.google\.com/i,
  /drive\.google\.com/i,
  /\.slack\.com/i,
  /atlassian\.net/i,
  /pingcap\.net/i,
];

const SKIPPED = /\.(png|jpe?g|gif|webp|ico|pdf|mp4|mov|woff2?)$|(^|\/)pnpm-lock\.yaml$/i;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const parseDenylist = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

export const isScannable = (file: string): boolean => !SKIPPED.test(file);

export const scanText = (options: {
  readonly file: string;
  readonly text: string;
  readonly denylist: readonly string[];
}): readonly Finding[] => {
  const patterns = [
    ...options.denylist.map((term, index) => ({ label: `denylist entry ${index + 1}`, pattern: new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i') })),
    ...INTERNAL_URL_PATTERNS.map((pattern) => ({ label: `internal URL ${pattern.source}`, pattern })),
  ];
  return options.text.split('\n').flatMap((content, index) =>
    patterns.filter(({ pattern }) => pattern.test(content)).map(({ label }) => ({ file: options.file, line: index + 1, match: label })),
  );
};

export const resolveDenylist = async (env: NodeJS.ProcessEnv): Promise<readonly string[] | undefined> => {
  if (env.LAB_DENYLIST !== undefined && env.LAB_DENYLIST.trim() !== '') return parseDenylist(env.LAB_DENYLIST);
  const text = await readOptional(env.LAB_DENYLIST_FILE ?? join(homedir(), '.config', 'tidb-lab', 'denylist.txt'));
  return text === undefined ? undefined : parseDenylist(text);
};

export const listPublishableFiles = async (root: string): Promise<readonly string[]> => {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\0').filter((file) => file !== '' && isScannable(file));
};
```

`packages/relay/src/collect-site.ts`:

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogEntry, DemoManifest } from '@lab/contract';
import { listDemoIds, loadFeaturedTrace, loadManifest } from './demo-files';
import { demoDir } from './paths';

export type DemoSummary = { readonly manifest: DemoManifest; readonly hasFeaturedTrace: boolean };

export const buildCatalog = (demos: readonly DemoSummary[], includeUnpublished: boolean): readonly CatalogEntry[] =>
  demos
    .filter((demo) => includeUnpublished || demo.manifest.publish)
    .map(({ manifest, hasFeaturedTrace }) => ({
      id: manifest.id,
      number: manifest.number,
      title: manifest.title,
      tagline: manifest.tagline,
      integrations: manifest.integrations,
      hasReplay: hasFeaturedTrace,
    }))
    .sort((a, b) => a.number - b.number);

const writeJson = (path: string, value: unknown): Promise<void> => writeFile(path, `${JSON.stringify(value)}\n`);

export const collectSite = async (options: { readonly root: string; readonly includeUnpublished: boolean }): Promise<readonly CatalogEntry[]> => {
  const ids = await listDemoIds(options.root);
  const demos = await Promise.all(
    ids.map(async (id) => ({ manifest: await loadManifest(demoDir(options.root, id)), trace: await loadFeaturedTrace(demoDir(options.root, id)) })),
  );
  const catalog = buildCatalog(demos.map(({ manifest, trace }) => ({ manifest, hasFeaturedTrace: trace !== undefined })), options.includeUnpublished);
  const out = join(options.root, 'packages', 'ui', 'public', 'data');
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'manifests'), { recursive: true });
  await mkdir(join(out, 'traces'), { recursive: true });
  const included = demos.filter(({ manifest }) => catalog.some((entry) => entry.id === manifest.id));
  await Promise.all(
    included.flatMap(({ manifest, trace }) => [
      writeJson(join(out, 'manifests', `${manifest.id}.json`), manifest),
      ...(trace === undefined ? [] : [writeJson(join(out, 'traces', `${manifest.id}.json`), trace)]),
    ]),
  );
  await writeJson(join(out, 'catalog.json'), catalog);
  return catalog;
};
```

`packages/relay/src/db-init.ts`:

```ts
import { createConnection } from 'mysql2/promise';
import { z } from 'zod';
import { quoteIdentifier, tidbConfigFromEnv } from '@lab/runner-kit';

const VersionRowsSchema = z.array(z.object({ version: z.string() }));

export const createDatabaseSql = (name: string): string => `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(name)}`;

export const runDbInit = async (env: NodeJS.ProcessEnv): Promise<{ readonly database: string; readonly version: string }> => {
  const database = env.TIDB_DATABASE ?? 'lab';
  const connection = await createConnection({ ...tidbConfigFromEnv(env), database: undefined });
  try {
    await connection.query(createDatabaseSql(database));
    const [rows] = await connection.query('SELECT VERSION() AS version');
    return { database, version: VersionRowsSchema.parse(rows)[0]?.version ?? 'unknown' };
  } finally {
    await connection.end();
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/relay test`
Expected: PASS, all relay test files (34 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/relay
git commit -m "feat(relay): validation, public-content gate, site collection, db init"
```

### Task 15: The `lab` CLI

**Files:**
- Create: `packages/relay/src/cli.ts`

- [ ] **Step 1: Implement the dispatcher (thin I/O shell; all logic is already tested)**

`packages/relay/src/cli.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { collectSite } from './collect-site';
import { runDbInit } from './db-init';
import { loadDemoEnv, loadFeaturedTrace, loadManifest } from './demo-files';
import { demoDir, labRoot } from './paths';
import { listPublishableFiles, resolveDenylist, scanText } from './public-check';
import { runDemo } from './run';
import { validateTrace } from './validate';

const USAGE = 'usage: lab run|validate|db-init <demo-id> [--record] [--port 7070]  |  lab check-public  |  lab collect-site';

const runCommand = async (root: string, id: string, record: boolean, port: number): Promise<number> => {
  const handle = await runDemo({ root, id, record, port });
  console.log(`lab relay for ${id} on ${handle.url}`);
  console.log(`open http://localhost:5173/#/demo/${id}?relay=${handle.url}`);
  process.on('SIGINT', () => handle.stop());
  const result = await handle.finished;
  if (result.tracePath !== undefined) console.log(`recorded trace: ${result.tracePath}`);
  return result.exitCode;
};

const validateCommand = async (root: string, id: string): Promise<number> => {
  const manifest = await loadManifest(demoDir(root, id));
  const trace = await loadFeaturedTrace(demoDir(root, id));
  if (trace === undefined) {
    console.log(`${id}: manifest ok, no featured trace yet`);
    return 0;
  }
  const report = validateTrace(manifest, trace);
  report.warnings.forEach((warning) => console.warn(`warning: ${warning}`));
  report.errors.forEach((error) => console.error(`error: ${error}`));
  console.log(`${id}: manifest ok, featured trace ${report.errors.length === 0 ? 'ok' : 'INVALID'} (${report.eventCount} events)`);
  return report.errors.length === 0 ? 0 : 1;
};

const dbInitCommand = async (root: string, id: string): Promise<number> => {
  const env = { ...process.env, ...(await loadDemoEnv(demoDir(root, id))) };
  const result = await runDbInit(env);
  console.log(`database ${result.database} ready (TiDB ${result.version})`);
  return 0;
};

const checkPublicCommand = async (root: string): Promise<number> => {
  const denylist = await resolveDenylist(process.env);
  if (denylist === undefined) {
    console.error('No denylist. Create ~/.config/tidb-lab/denylist.txt (one customer or prospect name per line) or set LAB_DENYLIST.');
    return 1;
  }
  const files = await listPublishableFiles(root);
  const findings = (await Promise.all(
    files.map(async (file) => scanText({ file, text: await readFile(join(root, file), 'utf8'), denylist })),
  )).flat();
  findings.forEach((finding) => console.error(`${finding.file}:${finding.line}  ${finding.match}`));
  console.log(`check-public: ${files.length} files scanned, ${findings.length} findings`);
  return findings.length === 0 ? 0 : 1;
};

const collectSiteCommand = async (root: string): Promise<number> => {
  const catalog = await collectSite({ root, includeUnpublished: process.env.LAB_INCLUDE_UNPUBLISHED === 'true' });
  console.log(`collect-site: ${catalog.length} demos, ${catalog.filter((entry) => entry.hasReplay).length} with replays`);
  return 0;
};

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const root = labRoot();
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: { record: { type: 'boolean' }, port: { type: 'string' } },
  });
  if (command === 'check-public') return checkPublicCommand(root);
  if (command === 'collect-site') return collectSiteCommand(root);
  const id = positionals[0];
  if (id === undefined) {
    console.error(USAGE);
    return 1;
  }
  if (command === 'run') return runCommand(root, id, values.record === true, Number(values.port ?? '7070'));
  if (command === 'validate') return validateCommand(root, id);
  if (command === 'db-init') return dbInitCommand(root, id);
  console.error(USAGE);
  return 1;
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
```

- [ ] **Step 2: Typecheck and smoke-test the CLI**

Run: `pnpm --filter @lab/relay typecheck`
Expected: exits 0.

Run: `pnpm lab`
Expected: prints the usage line and exits 1.

Run: `pnpm lab check-public` (without a denylist)
Expected: `No denylist. Create ~/.config/tidb-lab/denylist.txt ...` and exit 1.

Create the denylist (outside the repo): `mkdir -p ~/.config/tidb-lab && printf '# one name per line\n' > ~/.config/tidb-lab/denylist.txt`, then add every customer and prospect name you might ever mention.

Run: `pnpm lab check-public`
Expected: `check-public: N files scanned, 0 findings`.

- [ ] **Step 3: Commit**

```bash
git add integrations/packages/relay/src/cli.ts
git commit -m "feat(relay): lab CLI"
```

### Task 16: Synthetic example demo (platform self-test)

**Files:**
- Create: `demos/example/package.json`, `demos/example/tsconfig.json`, `demos/example/manifest.json`, `demos/example/.env.example`, `demos/example/runner/src/model.ts`, `demos/example/runner/main.ts`, `demos/example/runner/test/model.test.ts`, `demos/example/test/manifest.test.ts`

- [ ] **Step 1: Create the demo package and manifest**

`demos/example/package.json`:

```json
{
  "name": "@lab/demo-example",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc -p tsconfig.json" },
  "dependencies": { "@lab/contract": "workspace:*", "@lab/runner-kit": "workspace:*" },
  "devDependencies": { "@types/node": "^22.10.0", "tsx": "^4.20.0", "typescript": "^5.9.0", "vitest": "^3.2.0" }
}
```

`demos/example/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["runner", "test"] }
```

`demos/example/.env.example`:

```
LAB_ENV_TIDB=none (synthetic self-test)
LAB_ENV_NOTES=Every number in this demo is simulated.
```

`demos/example/manifest.json`:

```json
{
  "id": "example",
  "number": 0,
  "title": "Lab self-test",
  "tagline": "Synthetic events that exercise every part of the lab UI",
  "integrations": ["Synthetic"],
  "pattern": "Platform self-test; no real systems are involved and every number is simulated",
  "publish": false,
  "runner": { "command": ["node", "--import", "tsx", "runner/main.ts"] },
  "nodes": [
    { "id": "generator", "label": "Load generator", "kind": "client", "x": 10, "y": 50 },
    { "id": "queue", "label": "Queue (simulated)", "kind": "queue", "x": 35, "y": 30 },
    { "id": "tidb", "label": "TiDB (simulated)", "kind": "tidb", "x": 60, "y": 50 },
    { "id": "consumer", "label": "Consumer", "kind": "sink", "x": 88, "y": 50 }
  ],
  "edges": [
    { "id": "generator-to-queue", "from": "generator", "to": "queue", "label": "events", "unit": "events" },
    { "id": "queue-to-tidb", "from": "queue", "to": "tidb", "label": "rows", "unit": "rows" },
    { "id": "tidb-to-consumer", "from": "tidb", "to": "consumer", "label": "changes", "unit": "rows" }
  ],
  "metrics": [
    { "id": "write-rate", "label": "Write rate (simulated)", "unit": "rows/s", "display": "both", "better": "higher", "group": "Throughput", "howMeasured": "Simulated: base rate ramped over 10 s, times 10 during a burst" },
    { "id": "write-p99", "label": "Write p99 (simulated)", "unit": "ms", "display": "both", "better": "lower", "target": 20, "group": "Latency", "howMeasured": "Simulated: nearest-rank p99 over one tick of generated latency samples" },
    { "id": "rows-stored", "label": "Rows stored (simulated)", "unit": "rows", "display": "tile", "better": "neutral", "howMeasured": "Simulated: cumulative sum of write-rate ticks" }
  ],
  "phases": [
    { "id": "warmup", "label": "Warm up", "narration": "The generator ramps up while every component reports healthy." },
    { "id": "steady", "label": "Steady state", "narration": "Rows flow end to end at a steady rate with flat latency." },
    { "id": "burst", "label": "Burst", "narration": "A burst multiplies the write rate by ten; watch latency stay under target." },
    { "id": "verify", "label": "Verify", "narration": "The run stops and the counts check proves nothing was lost." }
  ],
  "checks": [{ "id": "counts-match", "label": "Counts match", "description": "Rows generated equal rows stored (simulated)" }],
  "controls": [{ "id": "burst", "label": "Burst x10", "description": "Multiply the simulated write rate by ten for ten seconds" }]
}
```

Run: `pnpm install && cp demos/example/.env.example demos/example/.env`
Expected: `@lab/demo-example` linked.

- [ ] **Step 2: Write the failing tests**

`demos/example/test/manifest.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

const raw: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

describe('example manifest', () => {
  it('satisfies the contract', () => {
    expect(DemoManifestSchema.safeParse(raw).success).toBe(true);
  });

  it('is never published', () => {
    expect(DemoManifestSchema.parse(raw).publish).toBe(false);
  });
});
```

`demos/example/runner/test/model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { summarize } from '@lab/runner-kit';
import { BASE_RATE, initialModel, latencySamples, phaseFor, rateFor, startBurst, step } from '../src/model';

describe('synthetic model', () => {
  it('ramps up over the first ten ticks', () => {
    expect(rateFor(initialModel)).toBe(BASE_RATE / 10);
    expect(rateFor({ ...initialModel, tick: 9 })).toBe(BASE_RATE);
  });

  it('multiplies the rate by ten during a burst', () => {
    expect(rateFor(startBurst({ ...initialModel, tick: 20 }))).toBe(BASE_RATE * 10);
  });

  it('accumulates stored rows and counts the burst down', () => {
    const next = step(startBurst({ ...initialModel, tick: 20 }));
    expect(next).toEqual({ tick: 21, burstTicksLeft: 9, stored: BASE_RATE * 10 });
  });

  it('maps ticks to phases', () => {
    expect([0, 9, 10, 29, 30, 44, 45].map(phaseFor)).toEqual(['warmup', 'warmup', 'steady', 'steady', 'burst', 'burst', 'verify']);
  });

  it('keeps simulated p99 under the 20 ms target even during a burst', () => {
    expect(summarize(latencySamples(BASE_RATE * 10, 31))?.p99).toBeLessThan(20);
  });

  it('is deterministic', () => {
    expect(latencySamples(200, 5)).toEqual(latencySamples(200, 5));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @lab/demo-example test`
Expected: manifest tests PASS, model tests FAIL with `Failed to resolve import "../src/model"`.

- [ ] **Step 4: Implement the model and the runner**

`demos/example/runner/src/model.ts`:

```ts
export type ModelState = { readonly tick: number; readonly burstTicksLeft: number; readonly stored: number };

export const BASE_RATE = 200;
export const TOTAL_TICKS = 60;
export const initialModel: ModelState = { tick: 0, burstTicksLeft: 0, stored: 0 };

const PHASES: readonly { readonly until: number; readonly id: string }[] = [
  { until: 10, id: 'warmup' },
  { until: 30, id: 'steady' },
  { until: 45, id: 'burst' },
  { until: Number.POSITIVE_INFINITY, id: 'verify' },
];

export const phaseFor = (tick: number): string => PHASES.find((phase) => tick < phase.until)?.id ?? 'verify';

export const rateFor = (state: ModelState): number => {
  const ramp = Math.min(1, (state.tick + 1) / 10);
  return Math.round(BASE_RATE * ramp * (state.burstTicksLeft > 0 ? 10 : 1));
};

export const startBurst = (state: ModelState): ModelState => ({ ...state, burstTicksLeft: 10 });

export const step = (state: ModelState): ModelState => ({
  tick: state.tick + 1,
  burstTicksLeft: Math.max(0, state.burstTicksLeft - 1),
  stored: state.stored + rateFor(state),
});

const pseudoRandom = (n: number): number => {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
};

export const latencySamples = (rate: number, seed: number, count = 50): readonly number[] =>
  Array.from({ length: count }, (_, index) => 4 + (rate / 1000) * 6 + pseudoRandom(seed * 100 + index) * 3);
```

`demos/example/runner/main.ts`:

```ts
import { createEmitter, every, onControl, summarize } from '@lab/runner-kit';
import { initialModel, latencySamples, phaseFor, rateFor, startBurst, step, TOTAL_TICKS } from './src/model';

const emitter = createEmitter();
const controller = new AbortController();
const shell = { model: initialModel, phase: '', tidbStatus: 'healthy' };

onControl((id) => {
  if (id !== 'burst') return;
  shell.model = startBurst(shell.model);
  emitter.log('info', 'Burst requested from the UI', 'generator');
});

['generator', 'queue', 'tidb', 'consumer'].forEach((node) => emitter.node(node, 'healthy'));
emitter.check('counts-match', 'pending');

await every({
  intervalMs: 1000,
  signal: controller.signal,
  task: async () => {
    const phase = phaseFor(shell.model.tick);
    if (phase !== shell.phase) {
      emitter.phase(phase);
      shell.phase = phase;
    }
    if (shell.model.tick === 30) shell.model = startBurst(shell.model);
    const rate = rateFor(shell.model);
    const latency = summarize(latencySamples(rate, shell.model.tick));
    emitter.flow('generator-to-queue', rate);
    emitter.flow('queue-to-tidb', rate);
    emitter.flow('tidb-to-consumer', rate);
    emitter.metric('write-rate', rate);
    if (latency !== undefined) emitter.metric('write-p99', latency.p99);
    shell.model = step(shell.model);
    emitter.metric('rows-stored', shell.model.stored);
    const tidbStatus = shell.model.burstTicksLeft > 0 ? 'busy' : 'healthy';
    if (tidbStatus !== shell.tidbStatus) {
      emitter.node('tidb', tidbStatus);
      shell.tidbStatus = tidbStatus;
    }
    if (shell.model.tick >= TOTAL_TICKS) controller.abort();
  },
});

emitter.check('counts-match', 'pass', `${shell.model.stored} generated = ${shell.model.stored} stored (simulated)`);
['generator', 'queue', 'tidb', 'consumer'].forEach((node) => emitter.node(node, 'done'));
process.exit(0);
```

`shell` is the imperative shell around the pure model; it is the only mutable state in the runner.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lab/demo-example test && pnpm --filter @lab/demo-example typecheck`
Expected: PASS, 8 tests; `tsc` exits 0.

- [ ] **Step 6: Live run through the relay**

Run: `pnpm lab run example --record`
Expected, first lines:

```
lab relay for example on http://localhost:7070
open http://localhost:5173/#/demo/example?relay=http://localhost:7070
```

In a second terminal: `curl -sN http://localhost:7070/events | head -5`
Expected: five `data: {...}` lines starting with `"type":"node"` events.

Run: `curl -s -X POST http://localhost:7070/control/burst`
Expected: `{"ok":true,"control":"burst"}`.

After about 60 seconds the first terminal prints `recorded trace: .../demos/example/traces/<timestamp>.json`.

Run: `cp demos/example/traces/2026-*.json demos/example/traces/featured.json && pnpm lab validate example`
Expected: `example: manifest ok, featured trace ok (N events)` with N around 500.

- [ ] **Step 7: Commit (the example trace is committed because it is the UI's test fixture; it is never published)**

```bash
git add integrations/demos/example integrations/pnpm-lock.yaml
git commit -m "feat(lab): synthetic example demo and featured trace"
```

### Task 17: UI package and the pure demo-state reducer

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vite.config.ts`, `packages/ui/index.html`, `packages/ui/test/setup.ts`, `packages/ui/src/state/demo-state.ts`, `packages/ui/src/state/selectors.ts`, `packages/ui/src/state/replay-fold.ts`
- Test: `packages/ui/test/state.test.ts`

- [ ] **Step 1: Create the package shell**

`packages/ui/package.json`:

```json
{
  "name": "@lab/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@testing-library/dom": "^10.4.0",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^26.1.0",
    "typescript": "^5.9.0",
    "vite": "^7.1.0",
    "vitest": "^3.2.0"
  }
}
```

`packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "types": ["vite/client", "node"] },
  "include": ["src", "test", "vite.config.ts"]
}
```

`packages/ui/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  plugins: [react()],
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] },
});
```

`packages/ui/test/setup.ts`:

```ts
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
```

`packages/ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TiDB Integration Lab</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run: `pnpm install`
Expected: `+ react`, `+ vite` in the output.

- [ ] **Step 2: Write the failing tests**

`packages/ui/test/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DemoEvent } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { foldEvents, initialState, reduceEvent } from '../src/state/demo-state';
import { firstIndexAfter, foldTo } from '../src/state/replay-fold';
import { edgeRate, latestValue } from '../src/state/selectors';

const events: readonly DemoEvent[] = [
  { type: 'phase', t: 0, phase: 'warmup' },
  { type: 'node', t: 0, node: 'tidb', status: 'healthy', note: 'ready' },
  { type: 'flow', t: 1000, edge: 'source-to-tidb', count: 10 },
  { type: 'metric', t: 1000, id: 'ingest-rate', value: 10 },
  { type: 'flow', t: 2000, edge: 'source-to-tidb', count: 30 },
  { type: 'metric', t: 2000, id: 'ingest-rate', value: 30 },
  { type: 'check', t: 3000, id: 'counts-match', status: 'pass', observed: '40 = 40' },
  { type: 'log', t: 3000, level: 'info', msg: 'done' },
];

describe('initialState', () => {
  it('starts every node idle and every check pending', () => {
    const state = initialState(aManifest());
    expect(state.nodes).toEqual({ source: 'idle', tidb: 'idle' });
    expect(state.checks).toEqual({ 'counts-match': { status: 'pending', observed: undefined } });
  });
});

describe('reduceEvent', () => {
  it('folds a whole run', () => {
    const state = foldEvents(aManifest(), events);
    expect(state.phase).toBe('warmup');
    expect(state.nodes.tidb).toBe('healthy');
    expect(state.nodeNotes.tidb).toBe('ready');
    expect(state.metrics['ingest-rate']).toEqual([{ t: 1000, value: 10 }, { t: 2000, value: 30 }]);
    expect(state.checks['counts-match']).toEqual({ status: 'pass', observed: '40 = 40' });
    expect(state.logs).toHaveLength(1);
    expect(state.t).toBe(3000);
  });

  it('does not mutate the previous state', () => {
    const before = initialState(aManifest());
    reduceEvent(before, { type: 'metric', t: 5, id: 'ingest-rate', value: 1 });
    expect(before.metrics).toEqual({});
  });

  it('stops at untilT', () => {
    expect(foldEvents(aManifest(), events, 1500).metrics['ingest-rate']).toEqual([{ t: 1000, value: 10 }]);
  });
});

describe('selectors', () => {
  it('reads the latest metric value', () => {
    expect(latestValue(foldEvents(aManifest(), events), 'ingest-rate')).toBe(30);
    expect(latestValue(initialState(aManifest()), 'ingest-rate')).toBeUndefined();
  });

  it('computes an edge rate from the latest sample and the time since the previous one', () => {
    const state = foldEvents(aManifest(), events, 2000);
    expect(edgeRate(state, 'source-to-tidb')).toBe(30);
    expect(edgeRate({ ...state, t: 10000 }, 'source-to-tidb')).toBe(0);
  });

  it('is not inflated when tick jitter puts three samples inside two seconds', () => {
    const jittered = foldEvents(aManifest(), [
      { type: 'flow', t: 9002, edge: 'source-to-tidb', count: 200 },
      { type: 'flow', t: 10001, edge: 'source-to-tidb', count: 200 },
      { type: 'flow', t: 11001, edge: 'source-to-tidb', count: 200 },
    ]);
    expect(edgeRate(jittered, 'source-to-tidb')).toBe(200);
  });

  it('treats a single sample as one second of flow', () => {
    const single = foldEvents(aManifest(), [{ type: 'flow', t: 1000, edge: 'source-to-tidb', count: 10 }]);
    expect(edgeRate(single, 'source-to-tidb')).toBe(10);
  });
});

describe('replay folding', () => {
  it('finds the first event after a time', () => {
    expect(firstIndexAfter(events, 1000, 0)).toBe(4);
    expect(firstIndexAfter(events, 99999, 0)).toBe(events.length);
  });

  it('folds forward incrementally and refolds on seek backwards', () => {
    const manifest = aManifest();
    const early = foldTo(manifest, events, undefined, 1000);
    const late = foldTo(manifest, events, early, 3000);
    const back = foldTo(manifest, events, late, 1000);
    expect(late.state.metrics['ingest-rate']).toHaveLength(2);
    expect(back.state.metrics['ingest-rate']).toHaveLength(1);
    expect(late.state.t).toBe(3000);
  });

  it('advances state time to the playhead even between events', () => {
    expect(foldTo(aManifest(), events, undefined, 2500).state.t).toBe(2500);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @lab/ui test`
Expected: FAIL with `Failed to resolve import "../src/state/demo-state"`.

- [ ] **Step 4: Implement**

`packages/ui/src/state/demo-state.ts`:

```ts
import type { CheckStatus, DemoEvent, DemoManifest, NodeStatus } from '@lab/contract';

export type SeriesPoint = { readonly t: number; readonly value: number };
export type FlowSample = { readonly t: number; readonly count: number };
export type LogEntry = Extract<DemoEvent, { type: 'log' }>;
export type ControlEntry = Extract<DemoEvent, { type: 'control' }>;
export type CheckState = { readonly status: CheckStatus; readonly observed: string | undefined };

export type DemoState = {
  readonly t: number;
  readonly phase: string | undefined;
  readonly nodes: Readonly<Record<string, NodeStatus>>;
  readonly nodeNotes: Readonly<Record<string, string>>;
  readonly metrics: Readonly<Record<string, readonly SeriesPoint[]>>;
  readonly flows: Readonly<Record<string, readonly FlowSample[]>>;
  readonly checks: Readonly<Record<string, CheckState>>;
  readonly logs: readonly LogEntry[];
  readonly controls: readonly ControlEntry[];
};

const LOG_LIMIT = 200;
const FLOW_LIMIT = 30;

const append = <T>(items: readonly T[] | undefined, item: T, limit = Number.POSITIVE_INFINITY): readonly T[] =>
  [...(items ?? []), item].slice(-limit);

export const initialState = (manifest: DemoManifest): DemoState => ({
  t: 0,
  phase: undefined,
  nodes: Object.fromEntries(manifest.nodes.map((node) => [node.id, 'idle'])),
  nodeNotes: {},
  metrics: {},
  flows: {},
  checks: Object.fromEntries(manifest.checks.map((check) => [check.id, { status: 'pending', observed: undefined }])),
  logs: [],
  controls: [],
});

export const reduceEvent = (state: DemoState, event: DemoEvent): DemoState => {
  const next = { ...state, t: Math.max(state.t, event.t) };
  switch (event.type) {
    case 'metric':
      return { ...next, metrics: { ...state.metrics, [event.id]: append(state.metrics[event.id], { t: event.t, value: event.value }) } };
    case 'flow':
      return { ...next, flows: { ...state.flows, [event.edge]: append(state.flows[event.edge], { t: event.t, count: event.count }, FLOW_LIMIT) } };
    case 'node':
      return {
        ...next,
        nodes: { ...state.nodes, [event.node]: event.status },
        nodeNotes: event.note === undefined ? state.nodeNotes : { ...state.nodeNotes, [event.node]: event.note },
      };
    case 'phase':
      return { ...next, phase: event.phase };
    case 'check':
      return { ...next, checks: { ...state.checks, [event.id]: { status: event.status, observed: event.observed } } };
    case 'log':
      return { ...next, logs: append(state.logs, event, LOG_LIMIT) };
    case 'control':
      return { ...next, controls: append(state.controls, event) };
  }
};

export const foldEvents = (
  manifest: DemoManifest,
  events: readonly DemoEvent[],
  untilT = Number.POSITIVE_INFINITY,
): DemoState => events.filter((event) => event.t <= untilT).reduce(reduceEvent, initialState(manifest));
```

`packages/ui/src/state/selectors.ts`:

```ts
import type { DemoState } from './demo-state';

export const latestValue = (state: DemoState, metricId: string): number | undefined =>
  state.metrics[metricId]?.at(-1)?.value;

export const edgeRate = (state: DemoState, edgeId: string, staleMs = 2500): number => {
  const samples = state.flows[edgeId] ?? [];
  const last = samples.at(-1);
  if (last === undefined || state.t - last.t > staleMs) return 0;
  const previous = samples.at(-2);
  const intervalMs = previous === undefined ? 1000 : Math.max(last.t - previous.t, 1);
  return last.count / (intervalMs / 1000);
};
```

`packages/ui/src/state/replay-fold.ts`:

```ts
import type { DemoEvent, DemoManifest } from '@lab/contract';
import { initialState, reduceEvent, type DemoState } from './demo-state';

export type Folded = { readonly state: DemoState; readonly cursor: number; readonly positionMs: number };

export const firstIndexAfter = (events: readonly DemoEvent[], t: number, from: number): number => {
  const index = events.findIndex((event, i) => i >= from && event.t > t);
  return index === -1 ? events.length : index;
};

export const foldTo = (
  manifest: DemoManifest,
  events: readonly DemoEvent[],
  previous: Folded | undefined,
  positionMs: number,
): Folded => {
  const base = previous !== undefined && positionMs >= previous.positionMs
    ? previous
    : { state: initialState(manifest), cursor: 0, positionMs: 0 };
  const end = firstIndexAfter(events, positionMs, base.cursor);
  const folded = events.slice(base.cursor, end).reduce(reduceEvent, base.state);
  return { state: { ...folded, t: Math.max(folded.t, positionMs) }, cursor: end, positionMs };
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @lab/ui test`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add integrations/packages/ui integrations/pnpm-lock.yaml
git commit -m "feat(ui): pure demo-state reducer, selectors, replay folding"
```

### Task 18: Player clock, routing, formatting

**Files:**
- Create: `packages/ui/src/sources/player.ts`, `packages/ui/src/route.ts`, `packages/ui/src/format.ts`
- Test: `packages/ui/test/player.test.ts`, `packages/ui/test/route.test.ts`, `packages/ui/test/format.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/ui/test/player.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { advance, createPlayer, seek, togglePlay } from '../src/sources/player';

describe('player', () => {
  it('starts paused at zero', () => {
    expect(createPlayer(60000)).toEqual({ playing: false, speed: 1, positionMs: 0, durationMs: 60000 });
  });

  it('advances by wall time times speed and stops at the end', () => {
    const playing = { ...togglePlay(createPlayer(1000)), speed: 4 };
    expect(advance(playing, 100).positionMs).toBe(400);
    expect(advance(playing, 1000)).toMatchObject({ positionMs: 1000, playing: false });
  });

  it('does not move while paused', () => {
    expect(advance(createPlayer(1000), 500).positionMs).toBe(0);
  });

  it('clamps seeks', () => {
    expect(seek(createPlayer(1000), 5000).positionMs).toBe(1000);
    expect(seek(createPlayer(1000), -5).positionMs).toBe(0);
  });

  it('restarts from zero when play is pressed at the end', () => {
    expect(togglePlay({ playing: false, speed: 1, positionMs: 1000, durationMs: 1000 })).toMatchObject({ playing: true, positionMs: 0 });
  });
});
```

`packages/ui/test/route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { demoHref, isLocalRelay, parseRoute } from '../src/route';

describe('parseRoute', () => {
  it('defaults to the catalog', () => {
    expect(parseRoute('')).toEqual({ page: 'catalog' });
    expect(parseRoute('#/demo/Bad_Id')).toEqual({ page: 'catalog' });
  });

  it('parses a demo route with and without a relay', () => {
    expect(parseRoute('#/demo/kafka')).toEqual({ page: 'demo', id: 'kafka', relay: undefined });
    expect(parseRoute('#/demo/kafka?relay=http://localhost:7070')).toEqual({ page: 'demo', id: 'kafka', relay: 'http://localhost:7070' });
  });

  it('builds demo links', () => {
    expect(demoHref('kafka')).toBe('#/demo/kafka');
  });
});

describe('isLocalRelay', () => {
  it('only trusts loopback relays', () => {
    expect(isLocalRelay('http://localhost:7070')).toBe(true);
    expect(isLocalRelay('http://127.0.0.1:7070')).toBe(true);
    expect(isLocalRelay('https://relay.example.com')).toBe(false);
    expect(isLocalRelay('not a url')).toBe(false);
  });
});
```

`packages/ui/test/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { formatClock, formatRate, formatValue, isOnTarget } from '../src/format';

describe('formatValue', () => {
  it('formats each unit', () => {
    expect(formatValue(3.14159, 'ms')).toBe('3.14 ms');
    expect(formatValue(1234.4, 'ms')).toBe('1,234 ms');
    expect(formatValue(99.44, '%')).toBe('99.4%');
    expect(formatValue(12.5, 'USD')).toBe('$12.50');
    expect(formatValue(4.25, 's')).toBe('4.3 s');
    expect(formatValue(25000, 'rows/s')).toBe('25.0k rows/s');
    expect(formatValue(3200000, 'rows')).toBe('3.20M rows');
  });
});

describe('formatRate and formatClock', () => {
  it('compacts rates and prints mm:ss', () => {
    expect(formatRate(12.4)).toBe('12');
    expect(formatRate(15300)).toBe('15.3k');
    expect(formatClock(83000)).toBe('01:23');
  });
});

describe('isOnTarget', () => {
  it('compares against the target in the better direction', () => {
    const [metric] = aManifest({ metrics: [{ id: 'p99', label: 'p99', unit: 'ms', display: 'tile', better: 'lower', target: 20, howMeasured: 'timer' }] }).metrics;
    if (metric === undefined) throw new Error('fixture');
    expect(isOnTarget(metric, 12)).toBe(true);
    expect(isOnTarget(metric, 25)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/ui exec vitest run test/player.test.ts test/route.test.ts test/format.test.ts`
Expected: FAIL with `Failed to resolve import "../src/sources/player"`.

- [ ] **Step 3: Implement**

`packages/ui/src/sources/player.ts`:

```ts
export type PlayerState = {
  readonly playing: boolean;
  readonly speed: number;
  readonly positionMs: number;
  readonly durationMs: number;
};

export const SPEEDS: readonly number[] = [1, 2, 4, 8];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const createPlayer = (durationMs: number): PlayerState => ({ playing: false, speed: 1, positionMs: 0, durationMs });

export const advance = (player: PlayerState, wallDeltaMs: number): PlayerState => {
  if (!player.playing) return player;
  const positionMs = Math.min(player.durationMs, player.positionMs + wallDeltaMs * player.speed);
  return { ...player, positionMs, playing: positionMs < player.durationMs };
};

export const seek = (player: PlayerState, positionMs: number): PlayerState => ({
  ...player,
  positionMs: clamp(positionMs, 0, player.durationMs),
});

export const togglePlay = (player: PlayerState): PlayerState =>
  player.positionMs >= player.durationMs ? { ...player, positionMs: 0, playing: true } : { ...player, playing: !player.playing };
```

`packages/ui/src/route.ts`:

```ts
export type Route =
  | { readonly page: 'catalog' }
  | { readonly page: 'demo'; readonly id: string; readonly relay: string | undefined };

export const parseRoute = (hash: string): Route => {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const id = /^\/demo\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path)?.[1];
  if (id === undefined) return { page: 'catalog' };
  return { page: 'demo', id, relay: new URLSearchParams(query).get('relay') ?? undefined };
};

export const demoHref = (id: string): string => `#/demo/${id}`;

export const isLocalRelay = (url: string): boolean => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
```

`packages/ui/src/format.ts`:

```ts
import type { ManifestMetric, MetricUnit } from '@lab/contract';

export const formatRate = (value: number): string => {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toLocaleString('en-US');
};

export const formatValue = (value: number, unit: MetricUnit): string => {
  if (unit === '%') return `${value.toFixed(1)}%`;
  if (unit === 'USD') return `$${value.toFixed(2)}`;
  if (unit === 's') return `${value.toFixed(1)} s`;
  if (unit === 'ms') return value < 10 ? `${value.toFixed(2)} ms` : `${Math.round(value).toLocaleString('en-US')} ms`;
  return `${formatRate(value)} ${unit}`;
};

export const formatClock = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

export const isOnTarget = (metric: ManifestMetric, value: number): boolean | undefined => {
  if (metric.target === undefined || metric.better === 'neutral') return undefined;
  return metric.better === 'higher' ? value >= metric.target : value <= metric.target;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/ui exec vitest run test/player.test.ts test/route.test.ts test/format.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/ui
git commit -m "feat(ui): replay clock, hash routing, value formatting"
```

### Task 19: Flow diagram and sparkline

**Files:**
- Create: `packages/ui/src/diagram/geometry.ts`, `packages/ui/src/diagram/FlowDiagram.tsx`, `packages/ui/src/charts/path.ts`, `packages/ui/src/charts/Sparkline.tsx`
- Test: `packages/ui/test/geometry.test.ts`, `packages/ui/test/flow-diagram.test.tsx`

- [ ] **Step 1: Write the failing tests**

`packages/ui/test/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { downsample, seriesPath } from '../src/charts/path';
import { CANVAS, edgePath, midpoint, particleSpec, toCanvas } from '../src/diagram/geometry';

describe('diagram geometry', () => {
  it('maps percentage coordinates onto the canvas', () => {
    expect(toCanvas({ id: 'a', label: 'A', kind: 'tidb', x: 50, y: 50 })).toEqual({ x: CANVAS.width / 2, y: CANVAS.height / 2 });
  });

  it('draws a horizontal-tangent cubic between two points', () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 100, y: 50 })).toBe('M 0 0 C 50 0, 50 50, 100 50');
    expect(midpoint({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 25 });
  });

  it('shows no particles when idle and more, faster particles as rate grows, capped at 12', () => {
    expect(particleSpec(0)).toEqual({ count: 0, durationS: 0 });
    const slow = particleSpec(10);
    const fast = particleSpec(10000);
    expect(fast.count).toBeGreaterThan(slow.count);
    expect(fast.durationS).toBeLessThan(slow.durationS);
    expect(particleSpec(1e12).count).toBe(12);
  });
});

describe('chart paths', () => {
  it('returns an empty path for fewer than two points', () => {
    expect(seriesPath([{ t: 0, value: 1 }], { width: 100, height: 20 })).toBe('');
  });

  it('scales points into the box with higher values drawn higher', () => {
    expect(seriesPath([{ t: 0, value: 0 }, { t: 10, value: 10 }], { width: 100, height: 20 })).toBe('M 0.0 20.0 L 100.0 0.0');
  });

  it('downsamples by keeping the max of each bucket', () => {
    const points = [1, 9, 2, 3, 8, 4].map((value, t) => ({ t, value }));
    expect(downsample(points, 3).map((point) => point.value)).toEqual([9, 3, 8]);
    expect(downsample(points, 10)).toBe(points);
  });
});
```

`packages/ui/test/flow-diagram.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { FlowDiagram } from '../src/diagram/FlowDiagram';
import { foldEvents } from '../src/state/demo-state';

describe('FlowDiagram', () => {
  it('renders every node with its live status and the edge rate', () => {
    const manifest = aManifest();
    const state = foldEvents(manifest, [
      { type: 'node', t: 0, node: 'tidb', status: 'degraded', note: 'one store down' },
      { type: 'flow', t: 1000, edge: 'source-to-tidb', count: 10 },
    ]);
    const { container } = render(<FlowDiagram manifest={manifest} state={state} />);
    expect(screen.getByText('Source')).toBeTruthy();
    expect(screen.getByText('one store down')).toBeTruthy();
    expect(container.querySelector('[data-node="tidb"]')?.getAttribute('data-status')).toBe('degraded');
    expect(screen.getByText('rows: 10/s')).toBeTruthy();
    expect(container.querySelectorAll('circle.particle').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/ui exec vitest run test/geometry.test.ts test/flow-diagram.test.tsx`
Expected: FAIL with `Failed to resolve import "../src/charts/path"`.

- [ ] **Step 3: Implement**

`packages/ui/src/diagram/geometry.ts`:

```ts
import type { ManifestNode } from '@lab/contract';

export type Point = { readonly x: number; readonly y: number };

export const CANVAS = { width: 1000, height: 560 } as const;

export const toCanvas = (node: ManifestNode): Point => ({
  x: (node.x / 100) * CANVAS.width,
  y: (node.y / 100) * CANVAS.height,
});

export const edgePath = (from: Point, to: Point): string => {
  const dx = (to.x - from.x) / 2;
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
};

export const midpoint = (from: Point, to: Point): Point => ({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });

export const particleSpec = (ratePerSecond: number): { readonly count: number; readonly durationS: number } => {
  if (ratePerSecond <= 0) return { count: 0, durationS: 0 };
  const magnitude = Math.log10(ratePerSecond + 1);
  return {
    count: Math.min(12, Math.max(1, Math.ceil(magnitude * 3))),
    durationS: Math.max(0.6, 3 - magnitude * 0.6),
  };
};
```

`packages/ui/src/charts/path.ts`:

```ts
import type { SeriesPoint } from '../state/demo-state';

export const seriesPath = (points: readonly SeriesPoint[], size: { readonly width: number; readonly height: number }): string => {
  if (points.length < 2) return '';
  const times = points.map((point) => point.t);
  const values = points.map((point) => point.value);
  const [tMin, tMax, vMin, vMax] = [Math.min(...times), Math.max(...times), Math.min(...values), Math.max(...values)];
  const x = (t: number): number => (tMax === tMin ? 0 : ((t - tMin) / (tMax - tMin)) * size.width);
  const y = (v: number): number => (vMax === vMin ? size.height / 2 : size.height - ((v - vMin) / (vMax - vMin)) * size.height);
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.t).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
};

export const downsample = (points: readonly SeriesPoint[], maxPoints: number): readonly SeriesPoint[] => {
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / maxPoints);
  return Array.from({ length: Math.ceil(points.length / bucketSize) }, (_, bucket) =>
    points.slice(bucket * bucketSize, (bucket + 1) * bucketSize),
  ).flatMap((bucket) => {
    const peak = bucket.reduce<SeriesPoint | undefined>((best, point) => (best === undefined || point.value > best.value ? point : best), undefined);
    return peak === undefined ? [] : [peak];
  });
};
```

`packages/ui/src/charts/Sparkline.tsx`:

```tsx
import type { SeriesPoint } from '../state/demo-state';
import { downsample, seriesPath } from './path';

const SIZE = { width: 160, height: 40 } as const;

export const Sparkline = ({ points }: { readonly points: readonly SeriesPoint[] }) => (
  <svg className="spark" viewBox={`0 0 ${SIZE.width} ${SIZE.height}`} preserveAspectRatio="none" aria-hidden="true">
    <path d={seriesPath(downsample(points, 120), SIZE)} />
  </svg>
);
```

`packages/ui/src/diagram/FlowDiagram.tsx`:

```tsx
import type { DemoManifest, ManifestEdge, ManifestNode, NodeStatus } from '@lab/contract';
import { formatRate } from '../format';
import type { DemoState } from '../state/demo-state';
import { edgeRate } from '../state/selectors';
import { CANVAS, edgePath, midpoint, particleSpec, toCanvas, type Point } from './geometry';

const NODE = { width: 170, height: 64 } as const;

const FlowEdge = ({ edge, from, to, rate }: { readonly edge: ManifestEdge; readonly from: Point; readonly to: Point; readonly rate: number }) => {
  const d = edgePath(from, to);
  const mid = midpoint(from, to);
  const spec = particleSpec(rate);
  return (
    <g className="edge" data-edge={edge.id}>
      <path d={d} className="edge-line" />
      {Array.from({ length: spec.count }, (_, index) => (
        <circle key={index} r={4} className="particle">
          <animateMotion dur={`${spec.durationS}s`} begin={`${(index * spec.durationS) / spec.count}s`} repeatCount="indefinite" path={d} />
        </circle>
      ))}
      <text x={mid.x} y={mid.y - 12} className="edge-label" textAnchor="middle">{`${edge.label}: ${formatRate(rate)}/s`}</text>
    </g>
  );
};

const FlowNode = ({ node, at, status, note }: { readonly node: ManifestNode; readonly at: Point; readonly status: NodeStatus; readonly note: string | undefined }) => (
  <g className="node" data-node={node.id} data-status={status} data-kind={node.kind} transform={`translate(${at.x - NODE.width / 2} ${at.y - NODE.height / 2})`}>
    <rect width={NODE.width} height={NODE.height} rx={12} />
    <circle className="status-dot" cx={16} cy={18} r={6} />
    <text x={30} y={23} className="node-kind">{node.kind}</text>
    <text x={16} y={46} className="node-label">{node.label}</text>
    {note === undefined ? null : <text x={NODE.width / 2} y={NODE.height + 18} className="node-note" textAnchor="middle">{note}</text>}
  </g>
);

export const FlowDiagram = ({ manifest, state }: { readonly manifest: DemoManifest; readonly state: DemoState }) => {
  const positions = new Map(manifest.nodes.map((node) => [node.id, toCanvas(node)]));
  return (
    <svg className="flow" viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`} role="img" aria-label={`${manifest.title} data flow`}>
      {manifest.edges.map((edge) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (from === undefined || to === undefined) return null;
        return <FlowEdge key={edge.id} edge={edge} from={from} to={to} rate={edgeRate(state, edge.id)} />;
      })}
      {manifest.nodes.map((node) => (
        <FlowNode key={node.id} node={node} at={positions.get(node.id) ?? toCanvas(node)} status={state.nodes[node.id] ?? 'idle'} note={state.nodeNotes[node.id]} />
      ))}
    </svg>
  );
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/ui exec vitest run test/geometry.test.ts test/flow-diagram.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/ui
git commit -m "feat(ui): animated flow diagram and sparkline"
```

### Task 20: Panels: metric tiles, phases, checks, logs, player bar, controls, environment

**Files:**
- Create: `packages/ui/src/components/MetricTile.tsx`, `PhaseTimeline.tsx`, `ChecksPanel.tsx`, `LogConsole.tsx`, `PlayerBar.tsx`, `ControlBar.tsx`, `EnvironmentBadge.tsx`, `DemoView.tsx` (all under `packages/ui/src/components/`)
- Test: `packages/ui/test/panels.test.tsx`

- [ ] **Step 1: Write the failing tests**

`packages/ui/test/panels.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { ChecksPanel } from '../src/components/ChecksPanel';
import { DemoView } from '../src/components/DemoView';
import { MetricTile } from '../src/components/MetricTile';
import { PhaseTimeline } from '../src/components/PhaseTimeline';
import { PlayerBar } from '../src/components/PlayerBar';
import { foldEvents } from '../src/state/demo-state';

const manifest = aManifest({
  phases: [
    { id: 'warmup', label: 'Warm up', narration: 'We start the pipeline.' },
    { id: 'burst', label: 'Burst', narration: 'Ten times the load.' },
  ],
});

describe('MetricTile', () => {
  it('shows the latest value, a dash when empty, and how it was measured', () => {
    const [metric] = manifest.metrics;
    if (metric === undefined) throw new Error('fixture');
    const { rerender } = render(<MetricTile metric={metric} points={[]} />);
    expect(screen.getByText('-')).toBeTruthy();
    rerender(<MetricTile metric={metric} points={[{ t: 0, value: 25000 }]} />);
    expect(screen.getByText('25.0k rows/s')).toBeTruthy();
    expect(screen.getByText('Rows inserted per second over the last tick')).toBeTruthy();
  });
});

describe('PhaseTimeline', () => {
  it('marks the current phase and shows its narration', () => {
    render(<PhaseTimeline phases={manifest.phases} current="burst" />);
    expect(screen.getByText('Ten times the load.')).toBeTruthy();
    expect(screen.getByText('2. Burst').getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('1. Warm up').getAttribute('data-done')).toBe('true');
  });
});

describe('ChecksPanel', () => {
  it('shows status and observed value', () => {
    const state = foldEvents(manifest, [{ type: 'check', t: 0, id: 'counts-match', status: 'fail', observed: '99 != 100' }]);
    render(<ChecksPanel manifest={manifest} state={state} />);
    expect(screen.getByText('FAIL')).toBeTruthy();
    expect(screen.getByText('99 != 100')).toBeTruthy();
  });
});

describe('PlayerBar', () => {
  it('reports seeks and speed changes', () => {
    const seeks: number[] = [];
    const speeds: number[] = [];
    render(
      <PlayerBar
        player={{ playing: false, speed: 1, positionMs: 0, durationMs: 60000 }}
        markers={[]}
        onToggle={() => undefined}
        onSeek={(ms) => { seeks.push(ms); }}
        onSpeed={(speed) => { speeds.push(speed); }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '30000' } });
    fireEvent.click(screen.getByText('4x'));
    expect(seeks).toEqual([30000]);
    expect(speeds).toEqual([4]);
    expect(screen.getByText('00:00 / 01:00')).toBeTruthy();
  });
});

describe('DemoView', () => {
  it('puts title, diagram, metrics, narration and checks on one screen', () => {
    const state = foldEvents(manifest, [{ type: 'phase', t: 0, phase: 'warmup' }]);
    render(<DemoView manifest={manifest} state={state} footer={null} badge={null} />);
    expect(screen.getByRole('heading', { name: /Example/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Example data flow' })).toBeTruthy();
    expect(screen.getByText('We start the pipeline.')).toBeTruthy();
    expect(screen.getByText('Counts match')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/ui exec vitest run test/panels.test.tsx`
Expected: FAIL with `Failed to resolve import "../src/components/ChecksPanel"`.

- [ ] **Step 3: Implement the components**

`packages/ui/src/components/MetricTile.tsx`:

```tsx
import type { ManifestMetric } from '@lab/contract';
import { Sparkline } from '../charts/Sparkline';
import { formatValue, isOnTarget } from '../format';
import type { SeriesPoint } from '../state/demo-state';

export const MetricTile = ({ metric, points }: { readonly metric: ManifestMetric; readonly points: readonly SeriesPoint[] }) => {
  const latest = points.at(-1)?.value;
  const onTarget = latest === undefined ? undefined : isOnTarget(metric, latest);
  return (
    <figure className="tile" data-on-target={onTarget === undefined ? 'n/a' : String(onTarget)}>
      <figcaption>{metric.label}</figcaption>
      <div className="tile-value">{latest === undefined ? '-' : formatValue(latest, metric.unit)}</div>
      {metric.target === undefined ? null : (
        <div className="tile-target">target {metric.better === 'lower' ? '≤' : '≥'} {formatValue(metric.target, metric.unit)}</div>
      )}
      {metric.display === 'tile' ? null : <Sparkline points={points} />}
      <details className="tile-how">
        <summary>How measured</summary>
        <p>{metric.howMeasured}</p>
      </details>
    </figure>
  );
};
```

`packages/ui/src/components/PhaseTimeline.tsx`:

```tsx
import type { ManifestPhase } from '@lab/contract';

export const PhaseTimeline = ({ phases, current }: { readonly phases: readonly ManifestPhase[]; readonly current: string | undefined }) => {
  const currentIndex = phases.findIndex((phase) => phase.id === current);
  const active = phases[currentIndex];
  return (
    <section className="phases" aria-label="Demo phases">
      <ol>
        {phases.map((phase, index) => (
          <li key={phase.id} aria-current={index === currentIndex ? 'step' : undefined} data-done={String(currentIndex > index)}>
            {`${index + 1}. ${phase.label}`}
          </li>
        ))}
      </ol>
      <p className="narration">{active?.narration ?? 'Waiting for the demo to start.'}</p>
    </section>
  );
};
```

`packages/ui/src/components/ChecksPanel.tsx`:

```tsx
import type { DemoManifest } from '@lab/contract';
import type { DemoState } from '../state/demo-state';

export const ChecksPanel = ({ manifest, state }: { readonly manifest: DemoManifest; readonly state: DemoState }) => (
  <section className="checks" aria-label="Correctness checks">
    <h2>Checks</h2>
    <ul>
      {manifest.checks.map((check) => {
        const current = state.checks[check.id];
        const status = current?.status ?? 'pending';
        return (
          <li key={check.id} data-status={status} title={check.description}>
            <span className="check-status">{status.toUpperCase()}</span>
            <span className="check-label">{check.label}</span>
            {current?.observed === undefined ? null : <span className="check-observed">{current.observed}</span>}
          </li>
        );
      })}
    </ul>
  </section>
);
```

`packages/ui/src/components/LogConsole.tsx`:

```tsx
import { formatClock } from '../format';
import type { LogEntry } from '../state/demo-state';

export const LogConsole = ({ logs }: { readonly logs: readonly LogEntry[] }) => (
  <details className="logs">
    <summary>{`Log (${logs.length})`}</summary>
    <ol>
      {logs.slice(-50).map((entry, index) => (
        <li key={`${entry.t}-${index}`} data-level={entry.level}>
          <time>{formatClock(entry.t)}</time> {entry.msg}
        </li>
      ))}
    </ol>
  </details>
);
```

`packages/ui/src/components/PlayerBar.tsx`:

```tsx
import { formatClock } from '../format';
import { SPEEDS, type PlayerState } from '../sources/player';

export type Marker = { readonly t: number; readonly label: string };

export const PlayerBar = (props: {
  readonly player: PlayerState;
  readonly markers: readonly Marker[];
  readonly onToggle: () => void;
  readonly onSeek: (ms: number) => void;
  readonly onSpeed: (speed: number) => void;
}) => (
  <div className="player" role="group" aria-label="Replay controls">
    <button type="button" onClick={props.onToggle}>{props.player.playing ? 'Pause' : 'Play'}</button>
    <div className="scrub">
      <input
        type="range"
        aria-label="Position"
        min={0}
        max={props.player.durationMs}
        step={100}
        value={props.player.positionMs}
        onChange={(event) => props.onSeek(Number(event.currentTarget.value))}
      />
      <div className="markers" aria-hidden="true">
        {props.markers.map((marker) => (
          <span key={`${marker.t}-${marker.label}`} title={marker.label} style={{ left: `${(marker.t / Math.max(props.player.durationMs, 1)) * 100}%` }} />
        ))}
      </div>
    </div>
    <span className="clock">{`${formatClock(props.player.positionMs)} / ${formatClock(props.player.durationMs)}`}</span>
    {SPEEDS.map((speed) => (
      <button key={speed} type="button" aria-pressed={props.player.speed === speed} onClick={() => props.onSpeed(speed)}>{`${speed}x`}</button>
    ))}
  </div>
);
```

`packages/ui/src/components/ControlBar.tsx`:

```tsx
import type { ManifestControl } from '@lab/contract';

export const ControlBar = (props: {
  readonly controls: readonly ManifestControl[];
  readonly enabled: boolean;
  readonly onControl: (id: string) => void;
}) => (
  <div className="controls" role="group" aria-label="Live controls">
    {props.controls.map((control) => (
      <button key={control.id} type="button" disabled={!props.enabled} title={control.description} onClick={() => props.onControl(control.id)}>
        {control.label}
      </button>
    ))}
  </div>
);
```

`packages/ui/src/components/EnvironmentBadge.tsx`:

```tsx
import type { Trace } from '@lab/contract';

export const EnvironmentBadge = ({ trace }: { readonly trace: Trace }) => {
  const components = Object.entries(trace.environment.components).map(([name, version]) => `${name} ${version}`);
  return (
    <p className="environment">
      {`Recorded ${trace.recordedAt.slice(0, 10)} on ${trace.environment.tidb}`}
      {components.length === 0 ? '' : ` with ${components.join(', ')}`}
      {trace.environment.notes === '' ? '' : `. ${trace.environment.notes}`}
    </p>
  );
};
```

`packages/ui/src/components/DemoView.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { DemoManifest } from '@lab/contract';
import { FlowDiagram } from '../diagram/FlowDiagram';
import type { DemoState } from '../state/demo-state';
import { ChecksPanel } from './ChecksPanel';
import { LogConsole } from './LogConsole';
import { MetricTile } from './MetricTile';
import { PhaseTimeline } from './PhaseTimeline';

export const DemoView = (props: {
  readonly manifest: DemoManifest;
  readonly state: DemoState;
  readonly badge: ReactNode;
  readonly footer: ReactNode;
}) => (
  <div className="demo">
    <header className="demo-header">
      <a href="#/" className="back">All demos</a>
      <h1>{`${String(props.manifest.number).padStart(2, '0')} ${props.manifest.title}`}</h1>
      <p className="tagline">{props.manifest.tagline}</p>
      <ul className="chips">{props.manifest.integrations.map((name) => <li key={name}>{name}</li>)}</ul>
      {props.badge}
    </header>
    <main className="demo-grid">
      <FlowDiagram manifest={props.manifest} state={props.state} />
      <section className="metrics" aria-label="Metrics">
        {props.manifest.metrics.map((metric) => (
          <MetricTile key={metric.id} metric={metric} points={props.state.metrics[metric.id] ?? []} />
        ))}
      </section>
    </main>
    <PhaseTimeline phases={props.manifest.phases} current={props.state.phase} />
    <div className="demo-bottom">
      <ChecksPanel manifest={props.manifest} state={props.state} />
      <LogConsole logs={props.state.logs} />
    </div>
    <footer className="demo-footer">{props.footer}</footer>
  </div>
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lab/ui exec vitest run test/panels.test.tsx && pnpm --filter @lab/contract test`
Expected: PASS, 5 panel tests.

- [ ] **Step 5: Commit**

```bash
git add integrations/packages/ui
git commit -m "feat(ui): metric tiles, phases, checks, logs, player and control bars"
```

### Task 21: Data loading, replay and live hooks, pages, app shell, styles

**Files:**
- Create: `packages/ui/src/data.ts`, `packages/ui/src/sources/use-replay.ts`, `packages/ui/src/sources/use-live.ts`, `packages/ui/src/pages/CatalogPage.tsx`, `packages/ui/src/pages/ReplayPage.tsx`, `packages/ui/src/pages/LivePage.tsx`, `packages/ui/src/App.tsx`, `packages/ui/src/main.tsx`, `packages/ui/src/styles.css`
- Test: `packages/ui/test/pages.test.tsx`

- [ ] **Step 1: Write the failing tests**

`packages/ui/test/pages.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry, Trace } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { CatalogPage } from '../src/pages/CatalogPage';
import { ReplayView } from '../src/pages/ReplayPage';

const entries: readonly CatalogEntry[] = [
  { id: 'kafka', number: 2, title: 'Kafka in and out', tagline: 'Streams both ways', integrations: ['Kafka'], hasReplay: true },
  { id: 'okta', number: 5, title: 'Okta lifecycle', tagline: 'Revoke in seconds', integrations: ['Okta'], hasReplay: false },
];

const trace: Trace = {
  schemaVersion: 1,
  manifest: aManifest(),
  recordedAt: '2026-09-25T15:00:00.000Z',
  environment: { tidb: 'tiup playground', components: {}, notes: '' },
  durationMs: 10000,
  events: [
    { type: 'phase', t: 0, phase: 'warmup' },
    { type: 'metric', t: 1000, id: 'ingest-rate', value: 111 },
    { type: 'metric', t: 8000, id: 'ingest-rate', value: 999 },
  ],
};

describe('CatalogPage', () => {
  it('lists demos and says which have replays', async () => {
    render(<CatalogPage load={async () => entries} />);
    expect(await screen.findByText('Kafka in and out')).toBeTruthy();
    expect(screen.getByText('Replay ready')).toBeTruthy();
    expect(screen.getByText('Recording coming soon')).toBeTruthy();
    expect(screen.getByText('Kafka in and out').closest('a')?.getAttribute('href')).toBe('#/demo/kafka');
  });

  it('shows an error when the catalog cannot load', async () => {
    render(<CatalogPage load={async () => { throw new Error('offline'); }} />);
    expect(await screen.findByText('Could not load demos: offline')).toBeTruthy();
  });
});

describe('ReplayView', () => {
  it('renders the state at the scrubbed position', () => {
    render(<ReplayView trace={trace} />);
    expect(screen.getByText('Recorded 2026-09-25 on tiup playground')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '2000' } });
    expect(screen.getByText('111 rows/s')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '9000' } });
    expect(screen.getByText('999 rows/s')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lab/ui exec vitest run test/pages.test.tsx`
Expected: FAIL with `Failed to resolve import "../src/pages/CatalogPage"`.

- [ ] **Step 3: Implement data loading and hooks**

`packages/ui/src/data.ts`:

```ts
import { CatalogSchema, DemoManifestSchema, TraceSchema, type CatalogEntry, type DemoManifest, type Trace } from '@lab/contract';

const fetchJson = async (url: string, signal?: AbortSignal): Promise<unknown> => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

export const fetchCatalog = async (): Promise<readonly CatalogEntry[]> => CatalogSchema.parse(await fetchJson('data/catalog.json'));

export const fetchTrace = async (id: string): Promise<Trace> => TraceSchema.parse(await fetchJson(`data/traces/${id}.json`));

export const fetchRelayManifest = async (relayUrl: string, signal: AbortSignal): Promise<DemoManifest> =>
  DemoManifestSchema.parse(await fetchJson(`${relayUrl}/manifest`, signal));
```

`packages/ui/src/sources/use-replay.ts`:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Trace } from '@lab/contract';
import type { DemoState } from '../state/demo-state';
import { foldTo, type Folded } from '../state/replay-fold';
import { advance, createPlayer, seek, togglePlay, type PlayerState } from './player';

export type Replay = {
  readonly player: PlayerState;
  readonly state: DemoState;
  readonly toggle: () => void;
  readonly seekTo: (ms: number) => void;
  readonly setSpeed: (speed: number) => void;
};

export const useReplay = (trace: Trace): Replay => {
  const [player, setPlayer] = useState<PlayerState>(() => createPlayer(trace.durationMs));
  const folded = useRef<Folded | undefined>(undefined);

  useEffect(() => {
    if (!player.playing) return undefined;
    const frame = { id: 0, last: performance.now() };
    const loop = (now: number): void => {
      const elapsedMs = Math.max(0, now - frame.last);
      frame.last = now;
      setPlayer((current) => advance(current, elapsedMs));
      frame.id = requestAnimationFrame(loop);
    };
    frame.id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame.id);
  }, [player.playing]);

  const state = useMemo(() => {
    folded.current = foldTo(trace.manifest, trace.events, folded.current, player.positionMs);
    return folded.current.state;
  }, [trace, player.positionMs]);

  return {
    player,
    state,
    toggle: () => setPlayer(togglePlay),
    seekTo: (ms) => setPlayer((current) => seek(current, ms)),
    setSpeed: (speed) => setPlayer((current) => ({ ...current, speed })),
  };
};
```

`packages/ui/src/sources/use-live.ts`:

```ts
import { useEffect, useState } from 'react';
import { parseEventLine, type DemoManifest } from '@lab/contract';
import { fetchRelayManifest } from '../data';
import { initialState, reduceEvent, type DemoState } from '../state/demo-state';

export type LiveStatus = 'connecting' | 'open' | 'error';

export type Live = {
  readonly manifest: DemoManifest | undefined;
  readonly state: DemoState | undefined;
  readonly status: LiveStatus;
  readonly sendControl: (id: string) => void;
};

export const useLive = (relayUrl: string): Live => {
  const [manifest, setManifest] = useState<DemoManifest | undefined>(undefined);
  const [state, setState] = useState<DemoState | undefined>(undefined);
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    const controller = new AbortController();
    const holder: { source?: EventSource } = {};
    fetchRelayManifest(relayUrl, controller.signal).then(
      (loaded) => {
        setManifest(loaded);
        setState(initialState(loaded));
        const source = new EventSource(`${relayUrl}/events`);
        holder.source = source;
        source.onopen = () => setStatus('open');
        source.onerror = () => setStatus('error');
        source.onmessage = (message: MessageEvent<string>) => {
          const parsed = parseEventLine(message.data);
          if (parsed.ok) setState((previous) => (previous === undefined ? previous : reduceEvent(previous, parsed.event)));
        };
      },
      () => setStatus('error'),
    );
    return () => {
      controller.abort();
      holder.source?.close();
    };
  }, [relayUrl]);

  const sendControl = (id: string): void => {
    void fetch(`${relayUrl}/control/${id}`, { method: 'POST' });
  };

  return { manifest, state, status, sendControl };
};
```

- [ ] **Step 4: Implement pages, app shell and entry point**

`packages/ui/src/pages/CatalogPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { CatalogEntry } from '@lab/contract';
import { demoHref } from '../route';

type Loaded = { readonly entries: readonly CatalogEntry[] } | { readonly error: string } | undefined;

export const CatalogPage = ({ load }: { readonly load: () => Promise<readonly CatalogEntry[]> }) => {
  const [loaded, setLoaded] = useState<Loaded>(undefined);
  useEffect(() => {
    load().then(
      (entries) => setLoaded({ entries }),
      (error: unknown) => setLoaded({ error: error instanceof Error ? error.message : String(error) }),
    );
  }, [load]);
  if (loaded === undefined) return <p className="status">Loading demos...</p>;
  if ('error' in loaded) return <p className="status error">{`Could not load demos: ${loaded.error}`}</p>;
  return (
    <div className="catalog">
      <header>
        <h1>TiDB Integration Lab</h1>
        <p>TiDB working with the tools you already run. Every number is measured on a real run and labeled with where it was recorded.</p>
      </header>
      <ul className="cards">
        {loaded.entries.map((entry) => (
          <li key={entry.id}>
            <a href={demoHref(entry.id)} className="card">
              <span className="card-number">{String(entry.number).padStart(2, '0')}</span>
              <h2>{entry.title}</h2>
              <p>{entry.tagline}</p>
              <ul className="chips">{entry.integrations.map((name) => <li key={name}>{name}</li>)}</ul>
              <span className="card-status">{entry.hasReplay ? 'Replay ready' : 'Recording coming soon'}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
};
```

`packages/ui/src/pages/ReplayPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Trace } from '@lab/contract';
import { DemoView } from '../components/DemoView';
import { EnvironmentBadge } from '../components/EnvironmentBadge';
import { PlayerBar } from '../components/PlayerBar';
import { useReplay } from '../sources/use-replay';

export const ReplayView = ({ trace }: { readonly trace: Trace }) => {
  const replay = useReplay(trace);
  const labels = new Map(trace.manifest.controls.map((control) => [control.id, control.label]));
  const markers = trace.events.flatMap((event) => (event.type === 'control' ? [{ t: event.t, label: labels.get(event.id) ?? event.id }] : []));
  return (
    <DemoView
      manifest={trace.manifest}
      state={replay.state}
      badge={<EnvironmentBadge trace={trace} />}
      footer={<PlayerBar player={replay.player} markers={markers} onToggle={replay.toggle} onSeek={replay.seekTo} onSpeed={replay.setSpeed} />}
    />
  );
};

type Loaded = { readonly trace: Trace } | { readonly error: string } | undefined;

export const ReplayPage = ({ id, load }: { readonly id: string; readonly load: (id: string) => Promise<Trace> }) => {
  const [loaded, setLoaded] = useState<Loaded>(undefined);
  useEffect(() => {
    load(id).then(
      (trace) => setLoaded({ trace }),
      () => setLoaded({ error: `No recording for ${id} yet. Run it live with: pnpm lab run ${id}` }),
    );
  }, [id, load]);
  if (loaded === undefined) return <p className="status">Loading recording...</p>;
  if ('error' in loaded) return <p className="status error">{loaded.error}</p>;
  return <ReplayView trace={loaded.trace} />;
};
```

`packages/ui/src/pages/LivePage.tsx`:

```tsx
import { ControlBar } from '../components/ControlBar';
import { DemoView } from '../components/DemoView';
import { useLive } from '../sources/use-live';

export const LivePage = ({ relayUrl }: { readonly relayUrl: string }) => {
  const live = useLive(relayUrl);
  if (live.manifest === undefined || live.state === undefined) {
    return <p className="status">{live.status === 'error' ? `Cannot reach relay at ${relayUrl}. Is pnpm lab run active?` : 'Connecting to relay...'}</p>;
  }
  return (
    <DemoView
      manifest={live.manifest}
      state={live.state}
      badge={<p className="environment live">{`LIVE from ${relayUrl} (${live.status})`}</p>}
      footer={<ControlBar controls={live.manifest.controls} enabled={live.status === 'open'} onControl={live.sendControl} />}
    />
  );
};
```

`packages/ui/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { fetchCatalog, fetchTrace } from './data';
import { CatalogPage } from './pages/CatalogPage';
import { LivePage } from './pages/LivePage';
import { ReplayPage } from './pages/ReplayPage';
import { isLocalRelay, parseRoute } from './route';

const useHash = (): string => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
};

export const App = () => {
  const route = parseRoute(useHash());
  if (route.page === 'catalog') return <CatalogPage load={fetchCatalog} />;
  if (route.relay !== undefined && isLocalRelay(route.relay)) return <LivePage key={route.relay} relayUrl={route.relay} />;
  return <ReplayPage key={route.id} id={route.id} load={fetchTrace} />;
};
```

`packages/ui/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 5: Add the stylesheet**

`packages/ui/src/styles.css`:

```css
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --ink: #111827;
  --muted: #5b6475;
  --line: #d9dde5;
  --accent: #d6283a;
  --flow: #2563eb;
  --ok: #15803d;
  --warn: #b45309;
  --bad: #b91c1c;
  --idle: #9ca3af;
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0f17;
    --panel: #121826;
    --ink: #e8ecf3;
    --muted: #97a1b3;
    --line: #253047;
    --flow: #60a5fa;
    --ok: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
    --idle: #6b7280;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); }
a { color: inherit; }
.status { padding: 48px 16px; text-align: center; color: var(--muted); }
.status.error { color: var(--bad); }
.catalog, .demo { max-width: 1280px; margin: 0 auto; padding: 24px 16px 48px; }
.catalog h1, .demo h1 { margin: 0 0 4px; font-size: 1.6rem; letter-spacing: -0.01em; }
.cards { list-style: none; padding: 0; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.card { display: block; height: 100%; padding: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; text-decoration: none; }
.card:hover { border-color: var(--accent); }
.card-number { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 700; }
.card h2 { margin: 6px 0; font-size: 1.1rem; }
.card p { margin: 0 0 10px; color: var(--muted); }
.card-status { font-size: 0.8rem; color: var(--muted); }
.chips { list-style: none; padding: 0; margin: 6px 0; display: flex; flex-wrap: wrap; gap: 6px; }
.chips li { font-size: 0.75rem; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; }
.back { font-size: 0.85rem; color: var(--muted); }
.tagline, .environment { margin: 0; color: var(--muted); }
.environment.live { color: var(--accent); font-weight: 600; }
.demo-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); margin-top: 16px; }
@media (max-width: 900px) { .demo-grid { grid-template-columns: 1fr; } }
.flow { width: 100%; height: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
.edge-line { fill: none; stroke: var(--line); stroke-width: 3; }
.particle { fill: var(--flow); }
.edge-label { font-size: 13px; fill: var(--muted); }
.node rect { fill: var(--panel); stroke: var(--line); stroke-width: 2; }
.node[data-kind="tidb"] rect { stroke: var(--accent); }
.node-kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; fill: var(--muted); }
.node-label { font-size: 15px; font-weight: 600; fill: var(--ink); }
.node-note { font-size: 12px; fill: var(--muted); }
.status-dot { fill: var(--idle); }
.node[data-status="healthy"] .status-dot, .node[data-status="done"] .status-dot { fill: var(--ok); }
.node[data-status="busy"] .status-dot, .node[data-status="starting"] .status-dot { fill: var(--flow); }
.node[data-status="degraded"] .status-dot { fill: var(--warn); }
.node[data-status="down"] .status-dot { fill: var(--bad); }
.node[data-status="down"] rect { stroke: var(--bad); stroke-dasharray: 6 4; }
.metrics { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); align-content: start; }
.tile { margin: 0; padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.tile figcaption { font-size: 0.8rem; color: var(--muted); }
.tile-value { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.tile[data-on-target="true"] .tile-value { color: var(--ok); }
.tile[data-on-target="false"] .tile-value { color: var(--bad); }
.tile-target { font-size: 0.75rem; color: var(--muted); }
.tile-how summary { font-size: 0.72rem; color: var(--muted); cursor: pointer; }
.tile-how p { font-size: 0.75rem; margin: 4px 0 0; }
.spark { width: 100%; height: 40px; }
.spark path { fill: none; stroke: var(--flow); stroke-width: 2; vector-effect: non-scaling-stroke; }
.phases { margin-top: 16px; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
.phases ol { list-style: none; padding: 0; margin: 0 0 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.phases li { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); font-size: 0.85rem; }
.phases li[data-done="true"] { color: var(--ink); }
.phases li[aria-current="step"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.narration { margin: 0; font-size: 1.15rem; line-height: 1.5; }
.demo-bottom { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; margin-top: 16px; }
@media (max-width: 900px) { .demo-bottom { grid-template-columns: 1fr; } }
.checks, .logs { padding: 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
.checks h2 { margin: 0 0 8px; font-size: 1rem; }
.checks ul, .logs ol { list-style: none; padding: 0; margin: 0; }
.checks li { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; }
.check-status { font-size: 0.72rem; font-weight: 700; min-width: 64px; color: var(--muted); }
.checks li[data-status="pass"] .check-status { color: var(--ok); }
.checks li[data-status="fail"] .check-status { color: var(--bad); }
.check-observed { color: var(--muted); font-variant-numeric: tabular-nums; }
.logs li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; padding: 2px 0; }
.logs li[data-level="warn"] { color: var(--warn); }
.logs li[data-level="error"] { color: var(--bad); }
.demo-footer { position: sticky; bottom: 0; margin-top: 16px; padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
.player, .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.scrub { position: relative; flex: 1 1 240px; }
.scrub input { width: 100%; accent-color: var(--accent); }
.markers span { position: absolute; top: -6px; width: 2px; height: 8px; background: var(--accent); }
.clock { font-variant-numeric: tabular-nums; color: var(--muted); }
button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); cursor: pointer; }
button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
```

- [ ] **Step 5b: Guard the replay clock against deferred React updates**

React may run a state updater after the next animation frame has already moved `frame.last`, which would make every elapsed time zero and freeze playback. This test fails if `use-replay.ts` computes the elapsed time inside the updater.

`packages/ui/test/use-replay.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Trace } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { useReplay } from '../src/sources/use-replay';

const trace: Trace = {
  schemaVersion: 1,
  manifest: aManifest(),
  recordedAt: '2026-09-25T15:00:00.000Z',
  environment: { tidb: 'tiup playground', components: {}, notes: '' },
  durationMs: 60000,
  events: [{ type: 'phase', t: 0, phase: 'warmup' }],
};

const stubFrames = (): { readonly fire: (now: number) => void } => {
  const pending: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pending.push(callback);
    return pending.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.spyOn(performance, 'now').mockReturnValue(0);
  return {
    fire: (now) => {
      const callbacks = pending.splice(0, pending.length);
      callbacks.forEach((callback) => callback(now));
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useReplay', () => {
  it('advances by the wall time between frames even when React defers the updates', () => {
    const frames = stubFrames();
    const { result } = renderHook(() => useReplay(trace));
    act(() => result.current.toggle());
    act(() => {
      frames.fire(1000);
      frames.fire(2000);
      frames.fire(3000);
    });
    expect(result.current.player.positionMs).toBe(3000);
  });
});
```

- [ ] **Step 6: Run all UI tests and the typecheck**

Run: `pnpm --filter @lab/ui test && pnpm --filter @lab/ui typecheck`
Expected: PASS, 39 tests across 9 files; `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add integrations/packages/ui
git commit -m "feat(ui): catalog, replay and live pages with styles"
```

### Task 22: End-to-end verification in a browser

**Files:** none created; this proves Tasks 1-21 work together.

- [ ] **Step 1: Whole-workspace gates**

Run: `pnpm typecheck && pnpm test`
Expected: every package exits 0 (contract 20, runner-kit 24, relay 34, example 8, ui 39 tests; Python kit 10).

- [ ] **Step 2: Replay mode**

Run: `pnpm dev`
Expected: `collect-site: 1 demos, 1 with replays` then Vite prints `Local: http://localhost:5173/`.

Open `http://localhost:5173/`. Expected: one card, `00 Lab self-test`, `Replay ready`. Click it, press Play, choose `8x`. Expected: particles move along three edges, the `Write rate (simulated)` tile climbs to about 200 then about 2,000 during Burst, the phase pill moves Warm up, Steady state, Burst, Verify, the narration caption changes with it, a marker sits on the scrub bar where Burst was pressed, and `Counts match` ends `PASS`. Drag the scrub bar backwards: the view rewinds without errors in the console.

- [ ] **Step 3: Live mode**

Run in a second terminal: `pnpm lab run example`
Open `http://localhost:5173/#/demo/example?relay=http://localhost:7070`.
Expected: header shows `LIVE from http://localhost:7070 (open)`; tiles update every second; pressing `Burst x10` makes the rate jump within one second and a `Burst requested from the UI` line appears in the Log panel.

- [ ] **Step 4: Screenshot proof**

Take one screenshot of replay mode mid-burst and one of live mode, and save them as `integrations/docs/screenshots/replay.png` and `integrations/docs/screenshots/live.png`.

- [ ] **Step 5: Commit**

```bash
git add integrations/docs/screenshots
git commit -m "docs(lab): end-to-end screenshots"
```

### Task 23: Static site build, hosting, and CI

**Files:**
- Create: `.github/workflows/integrations-ci.yml`, `integrations/README.md`
- Modify: `README.md` (repo root: add an "Integration Lab" section)

- [ ] **Step 1: Production build**

Run: `pnpm build:site`
Expected: `check-public: N files scanned, 0 findings`, `collect-site: 0 demos, 0 with replays` (the example is unpublished, so the site is empty until Plan 01 lands), then `vite build` writes `packages/ui/dist/`.

Run: `LAB_INCLUDE_UNPUBLISHED=true pnpm lab collect-site && pnpm --filter @lab/ui build && pnpm --filter @lab/ui preview`
Expected: `http://localhost:4173/` serves the catalog with the example card, proving relative asset paths work from a static host. Re-run `pnpm lab collect-site` afterwards so the unpublished demo is not left in `public/data`.

- [ ] **Step 2: Hosting (do this only when the first real demo has a featured trace)**

The output is a static folder, so any static host works. Either:

```bash
npx wrangler pages deploy packages/ui/dist --project-name tidb-integration-lab
```

or:

```bash
npx vercel deploy packages/ui/dist --prod
```

Expected: a URL that loads the catalog. Always deploy from `pnpm build:site` output, never from a dev build, so the public-content gate has run.

- [ ] **Step 3: CI workflow**

`.github/workflows/integrations-ci.yml`:

```yaml
name: integrations-ci
on:
  push:
    paths: ['integrations/**', '.github/workflows/integrations-ci.yml']
  pull_request:
    paths: ['integrations/**']
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: integrations
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: integrations/pnpm-lock.yaml
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: python -m pip install -e 'packages/runner-kit-py[test]' && python -m pytest -q packages/runner-kit-py
      - run: pnpm lab check-public
        env:
          LAB_DENYLIST: ${{ secrets.LAB_DENYLIST }}
```

Add the repository secret `LAB_DENYLIST` (newline-separated names) in GitHub settings. Without it, the last step fails closed, which is the intended behavior.

- [ ] **Step 4: READMEs**

`integrations/README.md`:

````markdown
# TiDB Integration Lab

Demos of TiDB working with the tools customers already run. Each demo shows the data flow as an animated diagram with live metrics, runs live against real systems, and records a replay that the static site plays back.

## Quick start

```bash
pnpm install
pnpm test
bash infra/tidb/playground.sh      # separate terminal
pnpm lab run example               # separate terminal
pnpm dev                           # open the printed URL
```

## Demos

See `docs/plans/README.md` for the full roadmap and one plan per demo.

## Rules

- No customer names or internal links anywhere (`pnpm lab check-public` enforces it).
- Every metric says how it was measured; every replay says where it was recorded.
````

Root `README.md`: add under a new `## Integration Lab` heading one line linking `integrations/` with the sentence "Animated, measured demos of TiDB with Kafka, AWS DMS, Debezium, Redis, Okta, Databricks, Chalk, Prometheus/Grafana, Datadog, Terraform/EKS, Power BI, and a live call copilot."

- [ ] **Step 5: Commit and push**

```bash
git add .github/workflows/integrations-ci.yml integrations/README.md README.md
git commit -m "ci(lab): tests, typecheck and public-content gate"
git push
```

Expected: the `integrations-ci` workflow runs green on GitHub.

## Self-review checklist (run before starting Plan 01)

- Every exported name in "Interfaces" exists in code with the same spelling: `createEmitter`, `summarize`, `createSampleWindow`, `every`, `sleep`, `timed`, `onControl`, `parseControlLine`, `tidbConfigFromEnv`, `createTidbPool`, `quoteIdentifier`, `DemoManifestSchema`, `DemoEventSchema`, `parseEventLine`, `eventReferenceErrors`, `TraceSchema`, `CatalogSchema`.
- `pnpm lab run|validate|db-init|check-public|collect-site` all behave as the relay table says.
- The example demo is `publish: false` and never appears in a `pnpm build:site` catalog.

## Subagent work packets

Format and rules: see `EXECUTION.md`. Run these strictly in order; every later plan depends on them.

### Packet 00-P1: Workspace and contract
- Tasks: 1, 2, 3, 4
- Depends on: none   Shared runtime: none
- Files owned: `integrations/package.json`, `integrations/pnpm-workspace.yaml`, `integrations/tsconfig.base.json`, `integrations/.gitignore`, `integrations/pnpm-lock.yaml`, `integrations/packages/contract/**`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/contract test` -> `20 passed`
  - `pnpm --filter @lab/contract typecheck` -> exit 0, no output
- Done when: the contract matches the Interfaces section character for character.

### Packet 00-P2: TypeScript runner kit
- Tasks: 5, 6, 7, 8 (steps 1-4 and 6; step 5 is the live check in 00-P2L)
- Depends on: 00-P1   Shared runtime: none
- Files owned: `integrations/packages/runner-kit/**`, `integrations/infra/tidb/playground.sh`, `integrations/infra/kafka/docker-compose.yml`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/runner-kit test` -> `24 passed`
  - `pnpm --filter @lab/runner-kit typecheck` -> exit 0

### Packet 00-P2L: Live TiDB check (coordinator)
- Tasks: 8 step 5
- Depends on: 00-P2   Shared runtime: tidb-playground
- Files owned: none
- Model: coordinator   Effort: S
- Gate:
  - the `SELECT VERSION()` one-liner in Task 8 step 5 -> one row containing `TiDB`
  - `docker compose -f infra/kafka/docker-compose.yml up -d && docker compose -f infra/kafka/docker-compose.yml ps` -> `lab-kafka` `healthy`; then `docker compose -f infra/kafka/docker-compose.yml down`

### Packet 00-P3: Python runner kit
- Tasks: 9
- Depends on: 00-P1   Shared runtime: none (can run in parallel with 00-P2)
- Files owned: `integrations/packages/runner-kit-py/**`
- Model: sonnet   Effort: S
- Gate:
  - `cd packages/runner-kit-py && .venv/bin/pytest -q` -> `10 passed`

### Packet 00-P4: Relay core
- Tasks: 10, 11, 12, 13
- Depends on: 00-P2   Shared runtime: none
- Files owned: `integrations/packages/relay/**` except `src/validate.ts`, `src/public-check.ts`, `src/collect-site.ts`, `src/db-init.ts`, `src/cli.ts` and their tests
- Model: sonnet   Effort: L
- Gate:
  - `pnpm --filter @lab/relay test` -> 22 passed (demo-files 5, lines 7, trace-builder 3, server 6, run 1)

### Packet 00-P5: Relay commands and CLI
- Tasks: 14, 15
- Depends on: 00-P4   Shared runtime: none
- Files owned: `integrations/packages/relay/src/{validate,public-check,collect-site,db-init,cli}.ts`, matching tests
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/relay test` -> `34 passed`
  - `pnpm --filter @lab/relay typecheck` -> exit 0
  - `pnpm lab` -> usage line, exit 1

### Packet 00-P6: Example demo
- Tasks: 16 steps 1-5
- Depends on: 00-P5   Shared runtime: none
- Files owned: `integrations/demos/example/**`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-example test` -> `8 passed`

### Packet 00-P6L: Record the example trace (coordinator)
- Tasks: 16 steps 6-7
- Depends on: 00-P6   Shared runtime: none (synthetic)
- Gate:
  - `pnpm lab validate example` -> `example: manifest ok, featured trace ok (N events)`

### Packet 00-P7: UI state and formatting
- Tasks: 17, 18
- Depends on: 00-P1   Shared runtime: none (can run in parallel with 00-P4)
- Files owned: `integrations/packages/ui/{package.json,tsconfig.json,vite.config.ts,index.html}`, `integrations/packages/ui/test/setup.ts`, `integrations/packages/ui/src/{state,sources/player.ts,route.ts,format.ts}`, matching tests
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/ui test` -> `23 passed` (11 state + 12 player/route/format)

### Packet 00-P8: UI components
- Tasks: 19, 20
- Depends on: 00-P7   Shared runtime: none
- Files owned: `integrations/packages/ui/src/{diagram,charts,components}/**`, matching tests
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/ui test` -> `35 passed`

### Packet 00-P9: UI pages and styles
- Tasks: 21
- Depends on: 00-P8   Shared runtime: none
- Files owned: `integrations/packages/ui/src/{data.ts,sources/use-replay.ts,sources/use-live.ts,pages/**,App.tsx,main.tsx,styles.css}`, `test/pages.test.tsx`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/ui test && pnpm --filter @lab/ui typecheck` -> `39 passed`, exit 0

### Packet 00-P10: End-to-end, site, CI (coordinator)
- Tasks: 22, 23
- Depends on: 00-P6L, 00-P9   Shared runtime: browser, GitHub
- Gate:
  - `pnpm typecheck && pnpm test` -> all green
  - replay and live checks in Task 22 observed in the browser, screenshots saved
  - `pnpm build:site` -> `0 findings`, `dist/` written
  - `integrations-ci` workflow green on GitHub


## Build notes (2026-09-27): fixes found while building this plan

The code in `integrations/` is authoritative where it differs from the task code above. These were found by running the lab end to end in a browser, and each has a regression test:

| Area | Bug | Fix | Test |
|---|---|---|---|
| `ui/src/sources/use-replay.ts` | The elapsed time was computed inside the `setPlayer` updater; React can run that updater after `frame.last` has moved, so playback froze or ran backwards | Compute `elapsedMs = Math.max(0, now - frame.last)` before calling `setPlayer` (already reflected in Task 21) | `ui/test/use-replay.test.tsx` |
| `ui/src/state/selectors.ts` | `edgeRate` summed a 2 s window, so normal tick jitter put three 1 s samples in the window and showed 1.5x the real rate | Rate = latest sample count over the time since the previous sample; zero when the latest sample is older than 2.5 s (already reflected in Task 17) | `ui/test/state.test.ts` |
| relay `/events` + `ui/src/sources/use-live.ts` | An `EventSource` reconnect (hidden tab, relay restart) replayed the whole run on top of existing state, so flows looked stale and charts mixed runs | SSE ids `<runId>.<index>` from `@lab/contract` (`formatSseId`, `parseSseId`); relay resumes after `Last-Event-ID` for the same run (`resumeIndex` in `relay/src/lines.ts`, listener index in `hub.ts`); the page resets its state when the run id changes (`ui/src/sources/live-state.ts`) | `contract/test/sse.test.ts`, `relay/test/lines.test.ts`, `relay/test/server.test.ts`, `ui/test/live-state.test.ts` |
| `ui/src/sources/use-live.ts` | Under React StrictMode the first mount could open an event stream after it had been cleaned up | Return early when the fetch resolves after `controller.signal.aborted` | `ui/test/use-live.test.tsx` |
| Python kit | The default `python3` on the build machine was 3.10 | Create the venv with Python 3.11+ (for example `/opt/homebrew/bin/python3.12 -m venv .venv`) | n/a |
| Workspace | pnpm 10 blocks esbuild's postinstall until approved | `pnpm approve-builds --all` once; `pnpm-workspace.yaml` records `allowBuilds.esbuild: true` | n/a |

Final counts after these fixes: contract 22, runner-kit 24, relay 37, example 8, ui 43, Python kit 10.
