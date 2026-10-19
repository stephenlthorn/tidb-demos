# Plan 12: TiDB Cloud agent stack: coding-agent platform (Filesystem + TiDB X + Lake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a coding-agent platform audience that one ticket can fan out into three attempts, each with its own copy-on-write workspace (a TiDB Cloud Filesystem layer) and its own database branch (TiDB Cloud Starter, built on the TiDB X architecture), that a failed attempt can be replayed from a step checkpoint with the database branched at that step's timestamp so the same tests fail again, and that run events and a step ledger reach TiDB Cloud Lake for eval, closing the loop with a lesson written back to Starter memory.

**Architecture:** A single TypeScript runner is a deterministic scripted harness, not an LLM. It mounts Filesystem layers through the `ti` CLI, creates and waits for Starter branches through `ticloud`, writes memory and a step ledger into a Starter instance with `createTidbPool`, sends run events to S3 as NDJSON, exports the ledger to S3 as Parquet, and drives TiDB Cloud Lake through its Node driver. Every number is measured with `timed()` or the runner's clock and emitted as `metric`, `flow`, `node`, `phase`, `check` and `log` events per the Plan 00 contract. This plan also creates the shared workspace package `@lab/agent-stack-kit` (thin, tested wrappers around the three CLIs, the Lake client and S3) that Plan 13 imports.

**Tech Stack:** Node 22 + TypeScript (strict) runner using `@lab/runner-kit`, `@lab/contract` and the new `@lab/agent-stack-kit`; `mysql2` (through `createTidbPool`) for Starter; the `ti` CLI (Filesystem, Starter, journals); the `ticloud` CLI (branches with point-in-time parents, Starter export); `tidbcloudlake-driver` (Lake); `@aws-sdk/client-s3` (events); `node:test` inside a tiny fixture repo; `git` for a local bare remote; Vitest.

**Depends on:** Plan 00 (platform). Plan 13 depends on this plan's `packages/agent-stack-kit`.

---

## 1. Why this demo

- **The question customers ask:** "We are building a coding agent. Every attempt needs its own workspace and its own copy of the database, we need to replay a failed step exactly, and we want to learn from every run. Do we have to stitch a file store, a database branching tool and a warehouse together ourselves?" (asked by platform teams that run many agent attempts per task)
- **Pattern:** Teams building a coding-agent platform that need an isolated workspace and database per attempt, replayable failures, durable org memory and an analytical store for eval.
- **What TiDB proves here:**
  - A Filesystem layer forks from a named checkpoint and gives each attempt an isolated, diffable workspace. The demo measures fork latency, and drain plus checkpoint latency, and checks that an edit one attempt made is absent from the other attempts' layer diffs.
  - A Starter branch gives each attempt its own copy-on-write database, and a branch of a branch at a point in time lets a failed step be replayed against the database as it was. The demo checks that all attempt branches start identical (same row count and checksum) and that the replayed step reproduces the same failing tests, file tree and row checksum. Branch creation is measured in seconds because it takes minutes.
  - Agent memory is one table: auto-embedding, a full-text index and a vector index, queried by a single hybrid statement at intake, with the lesson written back and recalled at the end.
  - Run events and the ledger land in Lake through S3. The demo measures freshness lag and load rate, checks that Lake's count equals the emitted count, and runs full-text, aggregate and cosine-distance eval queries.
- **What this demo does not claim:**
  - It does not claim any model quality. The agent is a deterministic script: candidate patches, the step order and the one planned failure come from seeded fixture files. An LLM-driven mode (`LAB_AGENT=llm`) is backlog and is not built.
  - It does not claim branch creation is fast. The vendor documents creation as taking a few minutes, and the runner hides it by creating branches early, not by making them quick.
  - It does not claim replay of a real model's nondeterministic failure. It proves the mechanism: the file state and the database state at a step can be reconstructed and the step rerun.
  - It does not claim streaming latency from Lake. Freshness is bounded below by the Lake task schedule (one minute here), and the metric says so.
  - The merged-per-dollar eval runs over synthetic history with fixture model labels. It is modeled, not measured, and every place it appears says so.
  - It does not claim production readiness or scale. TiDB Cloud Filesystem, Starter branching and TiDB Cloud Lake are public preview; their commands and outputs can change. It reports no throughput at scale.
  - It does not use the Essential changefeed sink to Lake by default. That path is an optional verify packet (12-V6).

## 2. What the audience sees

### Flow diagram

```
[fixture-repo] --seed-repo--> [filesystem] <--layer-io-- [harness]
 (source)                      base, task layer,          (client)
                               attempt layers                |
                                                             +--branch-reads--> [fixture-db]  Starter fixture instance + attempt branches
                                                             +--recall--------> [org-memory] <--lesson-write-- [eval]
                                                             +--step-ledger---> [ledger] --ledger-export--> [s3-events] --lake-load--> [lake] --eval-queries--> [eval]
                                                             +--events-out-----------------------------------^
```

Node positions (`x`, `y` percent of canvas): `fixture-repo` (6, 14) and `harness` (6, 55) on the left; `filesystem` (38, 12), `fixture-db` (40, 38), `org-memory` (40, 62) and `ledger` (40, 86) in the middle column; `s3-events` (68, 78); `lake` (86, 52) and `eval` (88, 18) on the right. Edge ids are exactly the ones in `manifest.json`: `seed-repo`, `layer-io`, `branch-reads`, `recall`, `step-ledger`, `events-out`, `ledger-export`, `lake-load`, `eval-queries`, `lesson-write`.

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | `setup` | Setup | The runner checks branch headroom, asks for the three attempt branches without waiting, creates the Starter tables and seeds org memory, creates the Lake objects and loads synthetic history, creates the task layer and the run journal. | "Three branches of a read-only fixture database start copying now. Branches take minutes, so we ask for them first and overlap everything else." |
| 2 | `intake-memory-recall` | Intake memory recall | One hybrid statement (vector list plus full-text list, fused with reciprocal rank fusion) returns the top three memories for the ticket. | "Ticket KIT-8812 arrives: fix the double charge on retried payments. Before touching code the agent asks org memory one question that mixes meaning and exact words." |
| 3 | `seed-checkpoint` | Seed checkpoint | The task layer is mounted, the fixture repo is copied in, and the harness drains and checkpoints it as `seed`. | "The fixture repo lands in a task layer and we checkpoint it as seed. Every attempt starts from exactly this state." |
| 4 | `fan-out` | Fan out 3 attempts | Three layers fork from `seed` and mount; the runner waits for the three branches and compares their row count and checksum. | "Three attempts fan out. Each gets a copy-on-write layer forked from seed and its own database branch. Nothing is copied by hand and all three databases start identical." |
| 5 | `work-loop` | Work loop | Each attempt runs its scripted steps. After each step: drain, checkpoint `step-NN`, read the branch clock and checksum, write a ledger row, append to the journal, send an event to S3, wait one second. | "Every step is drained, checkpointed, stamped with the branch's own clock and written to the ledger, one second apart so each step lands on a distinct second." |
| 6 | `winner-pr` | Winner PR | The highest-scoring attempt whose tests pass pushes a git branch to a local bare repository. No layer is committed. The journal is verified. | "The attempt whose tests pass with the smallest change wins and pushes a git branch. Its layer is never committed to the base." |
| 7 | `replay-failed-step` | Replay the failed step | A layer forks from the failed attempt's `step-07` checkpoint, the replay branch (created at the failure's database timestamp) is opened, and the step is rerun. | "Attempt 2 failed at step 7. We fork a layer from its step-07 checkpoint, branch its database at that step's timestamp and rerun the step. Same failing tests." |
| 8 | `lake-eval` | Lake eval | The ledger is exported to S3 and loaded into Lake, a marker event measures freshness, the count check waits for equality, and three eval queries run. | "Run events and the ledger land in Lake through S3. Now we can search failures, price merged work per model and find failures like this one." |
| 9 | `write-lesson` | Write the lesson | A lesson row is inserted into org memory and a hybrid search for a new retry-loop task must return it in the top three. | "The lesson goes back into org memory. The next ticket that mentions a retry loop recalls it in the first three results." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `fan-out` | Fan out | Runs the fan-out, the work loop and the winner PR in one go. Refused if the fan-out already ran (restart the runner for a new run). |
| `inject-flaky-dependency` | Inject flaky dependency | Before the fan-out only: arms a gateway connection reset at attempt 1's first verification, so attempt 1 fails and a different attempt wins. Refused after the fan-out. |
| `replay-failed-step` | Replay failed step | Forks a layer from the failed attempt's checkpoint, opens the replay branch and reruns the step. Needs the fan-out first. |
| `run-eval` | Run eval | Exports the ledger, waits for events to appear in Lake and runs the three eval queries. Needs the fan-out first. |
| `write-lesson` | Write lesson | Writes the lesson and checks hybrid recall. Needs the replay and the eval first. |

Controls are serialized: a second press waits for the first stage to finish. The gate logic is the pure `gateControl` function (Task 20), and a refused press becomes a `log` event at level `warn` that says why.

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `layer-isolation` | Layer isolation | Every file that only one attempt wrote appears in that attempt's layer diff and in no other attempt's layer diff. |
| `fork-branches-identical` | Fork branches identical | The three attempt branches return the same row count and the same row checksum before any step runs. |
| `replay-reproduces` | Replay reproduces the failure | The replayed step fails the same tests with the same signature, and the replay layer tree and replay branch checksum equal the ledger record of that step. |
| `journal-verified` | Journal verifies | ti fs-journal verify-journal reports the run journal's hash chain intact. |
| `lake-count-matches` | Lake count matches emitted events | After the load lag, the count of this run's live events in Lake equals the number of event lines the runner wrote to S3. |
| `lesson-recalled` | Lesson recalled | A hybrid search for a new retry-loop task returns the freshly written lesson in its top three results. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `fork-layer-ms` | Layer Fork Latency | ms | both | lower | Wall-clock milliseconds from timed() around one `ti fs fork-layer` CLI call (process start to exit, so it includes the CLI's network round trip). One sample per fork: three attempt forks from the seed checkpoint and one replay fork from a step checkpoint. |
| `checkpoint-ms` | Drain plus Checkpoint Latency | ms | both | lower | Milliseconds for `ti fs drain-file-system` plus `ti fs create-layer-checkpoint`, each timed with performance.now() inside tiFs.checkpoint and summed. One sample per checkpoint: the seed checkpoint and one per attempt step. |
| `branch-create-s` | Branch Create to ACTIVE | s | tile | lower | Seconds from the runner calling `ticloud serverless branch create` to the first `ticloud serverless branch list -o json` poll that reports that branch ACTIVE. Resolution is the poll interval BRANCH_POLL_MS. One sample per branch: three attempt branches and one replay branch. The vendor documents completion in a few minutes, so expect minutes, not milliseconds. |
| `hybrid-search-ms` | Hybrid Recall Latency | ms | both | lower | timed() around the single reciprocal-rank-fusion query (VEC_EMBED_COSINE_DISTANCE vector list plus fts_match_word list, constant 60, top 3) on the org Starter instance. Sampled once at intake and on every poll of the lesson recall. |
| `lake-freshness-s` | Lake Freshness Lag | s | both | lower | Seconds from the runner writing a marker NDJSON object to S3 until a poll (every 3 s) of SELECT COUNT(*) for that marker id in Lake first returns 1. It includes the Lake task schedule (one minute by default), so it is bounded below by the schedule rather than by S3 or the network. |
| `lake-rows-per-min` | Lake Rows Loaded per Minute | count | both | higher | Live run events visible in Lake (SELECT COUNT(*) FROM run_events WHERE run_id = this run AND source = 'live') divided by the minutes elapsed since the first event object of the run was written to S3. Synthetic history rows are excluded. |
| `events-emitted` | Run Events Emitted | count | tile | neutral | Cumulative count of NDJSON event lines the runner wrote to S3 for this run: one per attempt step, one per attempt finish and one freshness marker. |
| `lake-events-visible` | Run Events Visible in Lake | count | both | higher | Result of SELECT COUNT(*) FROM run_events WHERE run_id = this run AND source = 'live' in Lake, polled every 3 s until it equals events-emitted or LAKE_FRESHNESS_TIMEOUT_MS passes. |
| `eval-query-ms` | Lake Eval Query Latency | ms | tile | lower | timed() around each of the three eval queries (MATCH on ECONNRESET, merged attempts per dollar by model, COSINE_DISTANCE failure similarity) through the Node driver. Each query opens a new connection, so connection setup is included. Merged per dollar uses synthetic history and fixture model labels, so that result is modeled, not measured. |

No metric carries a `target`: none of these numbers has a vendor SLA, and the products are in preview.

## 4. Verified facts and sources

**Environment note on verification method:** every page below was fetched on 2026-10-19 as raw markdown (`curl -sL <page-url>.md`; the docs sites publish the markdown source next to each page). "Verified" means the statement is in that public page's text. It does not mean the command was run against a live account: nothing in this plan has been run against a live account yet. The pure code, the harness (which really runs the fixture's tests and git) and the whole-run test against in-memory stand-ins in Tasks 2 to 29 were executed locally while this plan was written (72 kit tests and 160 demo tests passing); in that local run the Lake driver and the S3 SDK were replaced by local type stubs written from their documented API, so Tasks 8 and 9 still need a real install. Anything whose real output, field names or behaviour could not be confirmed from page text is marked **UNVERIFIED** and has an item number (U1 to U10) that a verify packet in section 10 resolves before any packet whose code depends on it. TiDB X is the architecture behind TiDB Cloud Starter, Essential and Premium; this demo reaches it through TiDB Cloud Starter.

| Fact | Source | Status |
|---|---|---|
| TiDB Cloud Filesystem is in public preview and its features and interfaces can change without notice. The CLI (`ti`) is also public preview. | [Filesystem intro](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-intro/), [CLI reference](https://docs.pingcap.com/ai/ti-cli-reference/) | Verified |
| Filesystem regions include `aws-us-east-1`; supported file system regions are built into each `ti` release. | [Regions and limitations](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-regions-and-limitations/), [CLI regions](https://docs.pingcap.com/ai/ti-regions-security-and-limitations/) | Verified |
| `ti` accepts long options only. Structured commands print JSON by default (`--output json`), `--output text` is available, `--query` applies a JMESPath expression, errors go to stderr with the `ti [ERROR]:` prefix and exit nonzero. | [CLI reference](https://docs.pingcap.com/ai/ti-cli-reference/) | Verified |
| The field names inside each `ti` command's JSON (layer id, checkpoint id, diff entries, journal verification result) are not documented on the command pages. The parsers in Task 5 accept the likely keys and are tested against documented-shape samples only. | Command pages: [create-layer](https://docs.pingcap.com/ai/ti-fs-create-layer/), [create-layer-checkpoint](https://docs.pingcap.com/ai/ti-fs-create-layer-checkpoint/), [diff-layer](https://docs.pingcap.com/ai/ti-fs-diff-layer/), [verify-journal](https://docs.pingcap.com/ai/ti-fs-journal-verify-journal/) | **UNVERIFIED (U1)** |
| `ti fs create-file-system [--display-name] [--label] [--wait]` returns the id and an owner token and stores the token in the profile. `--file-system-id` or `TI_FS_FILE_SYSTEM_ID` selects the file system on every other command; `--fs-token` or `TI_FS_TOKEN` supplies the token. | [create-file-system](https://docs.pingcap.com/ai/ti-fs-create-file-system/) | Verified |
| Layer commands and flags: `create-layer --base-root-path --layer-name --durability-mode restore-safe --tag k=v`, `fork-layer --parent-layer-ref --layer-name --checkpoint-id`, `create-layer-checkpoint --layer-id --checkpoint-id --label`, `diff-layer --layer-id`, `commit-layer`, `rollback-layer`, `delete-layer --layer-ref [--cascade]`, `list-layers`. | [create-layer](https://docs.pingcap.com/ai/ti-fs-create-layer/), [fork-layer](https://docs.pingcap.com/ai/ti-fs-fork-layer/), [delete-layer](https://docs.pingcap.com/ai/ti-fs-delete-layer/), [manage layers](https://docs.pingcap.com/ai/manage-filesystem-layers/) | Verified |
| Layers and checkpoints require a FUSE mount (`--driver fuse`). macOS needs macFUSE; Linux uses FUSE only; Windows has no mounts. On Ubuntu 26.04 use a mount path under `$HOME` or `/mnt`. | [Mount](https://docs.pingcap.com/ai/ti-fs-mount-file-system/), [Regions and limitations](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-regions-and-limitations/) | Verified |
| A checkpoint includes only changes that have reached the service, so run `drain-file-system` first. Do not mount the same writable layer at two paths at once. A checkpoint mount is read-only; to continue from a checkpoint, fork a layer from it. | [Manage layers and checkpoints](https://docs.pingcap.com/ai/manage-filesystem-layers/), [mount](https://docs.pingcap.com/ai/ti-fs-mount-file-system/) | Verified |
| Killing a mount abruptly can lose uncommitted write-back state; `unmount-file-system` flushes first and `--ignore-absent` makes it safe to repeat. | [Unmount](https://docs.pingcap.com/ai/ti-fs-unmount-file-system/), [Regions and limitations](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-regions-and-limitations/) | Verified |
| Layer names stay visible after logical deletion and can become ambiguous, so automation must use returned layer ids. | [fork-layer](https://docs.pingcap.com/ai/ti-fs-fork-layer/) | Verified |
| `delete-layer` abandons a layer without erasing its history and fails when live descendants exist unless `--cascade` is given. `delete-file-system` needs TiDB Cloud API credentials, takes `--file-system-id` only and deletes asynchronously. | [delete-layer](https://docs.pingcap.com/ai/ti-fs-delete-layer/), [delete-file-system](https://docs.pingcap.com/ai/ti-fs-delete-file-system/) | Verified |
| Journals are append-only and hash-chained: `ti fs-journal create-journal`, `append-journal-entries --entry-json ... --idempotency-key`, `verify-journal`. The public command surface has no journal delete command. | [create-journal](https://docs.pingcap.com/ai/ti-fs-journal-create-journal/), [append](https://docs.pingcap.com/ai/ti-fs-journal-append-journal-entries/), [verify](https://docs.pingcap.com/ai/ti-fs-journal-verify-journal/), [limitations](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-regions-and-limitations/) | Verified |
| `ti fs search-file-content` (alias `grep`) takes `--pattern --path --layer-id --limit`. `ti fs-vault create-grant` takes `--agent-id --scope --permission read --ttl [--token-only]` and needs an existing secret. The kit wraps both for Plan 13; this demo does not call them. | [search-file-content](https://docs.pingcap.com/ai/ti-fs-search-file-content/), [create-grant](https://docs.pingcap.com/ai/ti-fs-vault-create-grant/) | Verified |
| Limits on layers and checkpoints, whether a checkpoint id such as `step-01` may repeat across layers, whether four concurrent FUSE mounts work on one machine, whether deleted layers stop accruing storage, and the real fork and checkpoint timings. | Not documented on the pages above | **UNVERIFIED (U2)** |
| Starter branching is public preview and not available on Dedicated. Branches are copy-on-write, can come from the instance or from another branch, and can be created at a point in time. Creation usually completes within a few minutes. The default per-organization branch quota, the source-size and throttling limits, per-branch storage limits and how far back a point in time may reach are on the overview page and are not repeated here. | [Branch overview](https://docs.pingcap.com/tidbcloud/branch-overview/), [Manage branches](https://docs.pingcap.com/tidbcloud/branch-manage/) | Verified |
| `ticloud serverless branch create --cluster-id --display-name [--parent-id] [--parent-timestamp <RFC3339>]`, `branch list <cluster-id> -o json`, `branch delete --cluster-id --branch-id --force`. `ti db create-db-cluster-branch` has `--wait` but no parent-timestamp option, so it cannot make the replay branch. | [branch create](https://docs.pingcap.com/tidbcloud/ticloud-branch-create/), [list](https://docs.pingcap.com/tidbcloud/ticloud-branch-list/), [delete](https://docs.pingcap.com/tidbcloud/ticloud-branch-delete/), [ti db create-db-cluster-branch](https://docs.pingcap.com/ai/ti-db-create-db-cluster-branch/) | Verified |
| What `branch create` prints, the JSON field names and state names in `branch list -o json` (branch id, state, endpoint host and port, user-name prefix), and how long a branch stays in a non-ACTIVE state. | Not documented | **UNVERIFIED (U3)** |
| Connecting to a branch: the console documents generating or resetting a root password per branch. Whether the parent instance's SQL users authenticate against a branch endpoint (with the branch's user-name prefix) so the runner can connect non-interactively is not documented. | [Manage branches](https://docs.pingcap.com/tidbcloud/branch-manage/) | **UNVERIFIED (U4)** |
| A branch of a branch accepts `--parent-timestamp`. Whether the timestamp must be after the parent branch was created, how a whole-second RFC3339 timestamp maps to the `UTC_TIMESTAMP(3)` read at a step, and what error appears for a timestamp outside the reach. | [branch create](https://docs.pingcap.com/tidbcloud/ticloud-branch-create/) | **UNVERIFIED (U5)** |
| Starter SQL: `EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", content)` generated column, `FULLTEXT INDEX ... WITH PARSER STANDARD`, `VECTOR INDEX ((VEC_COSINE_DISTANCE(col)))`, `VEC_EMBED_COSINE_DISTANCE(col, 'text')`, `fts_match_word('terms', col)`, and a hybrid statement that fuses a vector list and a full-text list with reciprocal rank fusion (constant 60) and a TiFlash read hint on the vector side. | [Hybrid search with SQL](https://docs.pingcap.com/ai/vector-search-hybrid-search-sql/) | Verified (page text) |
| Full-text search on Starter is available in N. Virginia (`us-east-1`), among other AWS regions; Auto Embedding is AWS only. Whether this account's instance has both enabled, and how soon after an insert a new row shows up in both indexes. | [Hybrid search with SQL](https://docs.pingcap.com/ai/vector-search-hybrid-search-sql/) | Verified for the region. **UNVERIFIED (U10)** for the account and the index delay |
| `ticloud serverless export create -c --target-type S3 --s3.uri --s3.access-key-id --s3.secret-access-key --file-type PARQUET --filter db.table --force`. | [export create](https://docs.pingcap.com/tidbcloud/ticloud-serverless-export-create/), [Export overview](https://docs.pingcap.com/tidbcloud/serverless-export/) | Verified |
| What `export create` prints (the export id), what `export describe` prints, the state names, where under the URI the Parquet objects land, and how TiDB column types map into Lake columns. | Not documented | **UNVERIFIED (U6)** |
| Starter has no changefeed. Essential has a changefeed that sinks to Lake: preview, AWS only, created through the TiDB Cloud API only, bucket, instance and warehouse in the same region, primary-key tables only for incremental replication, CANAL_JSON files plus a snapshot, with a configurable poll interval on the Lake side. | [Sink to TiDB Cloud Lake](https://docs.pingcap.com/tidbcloud/data-pipeline-essential-sink-to-lake/) | Verified (optional path, 12-V6) |
| `ti db create-db-cluster --db-cluster-type starter --db-cluster-name <s> [--wait]`, `ti db create-db-sql-users`, `ti db format-db-connection-string`, `ti db execute-sql-statement`, `ti db delete-db-cluster [--wait]`. | [create-db-cluster](https://docs.pingcap.com/ai/ti-db-create-db-cluster/), [create-db-sql-users](https://docs.pingcap.com/ai/ti-db-create-db-sql-users/), [execute-sql-statement](https://docs.pingcap.com/ai/ti-db-execute-sql-statement/), [delete-db-cluster](https://docs.pingcap.com/ai/ti-db-delete-db-cluster/) | Verified |
| TiDB Cloud Lake is public preview, separates compute (warehouses) from storage, and bills a warehouse per second while it is running; an idle warehouse suspends automatically after a default idle time. Cost components are warehouses, storage, cloud service (per API request) and service hosting for Data Integration. | [Lake overview](https://docs.pingcap.com/tidbcloudlake/lake-overview/), [Pricing and billing](https://docs.pingcap.com/tidbcloudlake/pricing-billing/) | Verified |
| Lake DSN is `lake://user:pwd@host:443/database?warehouse=wh`. The Node package is `tidbcloudlake-driver`; the documented usage is `new Client(dsn)`, `getConn()`, `conn.exec` (sql and params), `conn.queryIter` (sql and params) with `for await (const row of rows)` and `row.values()`, and `conn.close()`. | [Driver overview](https://docs.pingcap.com/tidbcloudlake/driver-overview/), [Node.js](https://docs.pingcap.com/tidbcloudlake/connect-using-node-js/) | Verified (page text) |
| The driver's exact exports and import form under ESM, whether the iterator exposes `schema().fields()` with `name`, and whether DDL through `conn.exec` returns cleanly. | Not documented | **UNVERIFIED (U7)** |
| Lake SQL used here: `CREATE WAREHOUSE IF NOT EXISTS 'name' WITH warehouse_size = XSmall auto_suspend = <seconds>`, `ALTER WAREHOUSE 'name' SUSPEND`, `DROP WAREHOUSE IF EXISTS 'name'`, `CREATE CONNECTION ... STORAGE_TYPE = 's3'`, `CREATE STAGE ... URL = ... CONNECTION = (CONNECTION_NAME = ...)`, `COPY INTO t FROM @stage PATTERN = ... FILE_FORMAT = (TYPE = NDJSON | PARQUET)` (maps keys and columns by name; skips files it already loaded unless `FORCE = true`), `CREATE TASK ... WAREHOUSE = ... SCHEDULE = 1 MINUTE AS ...` (starts suspended, needs `ALTER TASK ... RESUME`), `EXECUTE TASK`, `CREATE INVERTED INDEX ... ON t(col)` with `MATCH(col, 'terms')`, `VECTOR(n)` columns with `VECTOR INDEX name(col) distance = 'cosine'` and `COSINE_DISTANCE(col, [..])`. | [CREATE WAREHOUSE](https://docs.pingcap.com/tidbcloudlake/create-warehouse/), [ALTER WAREHOUSE](https://docs.pingcap.com/tidbcloudlake/alter-warehouse/), [DROP WAREHOUSE](https://docs.pingcap.com/tidbcloudlake/drop-warehouse/), [CREATE CONNECTION](https://docs.pingcap.com/tidbcloudlake/create-connection/), [CREATE STAGE](https://docs.pingcap.com/tidbcloudlake/create-stage/), [COPY INTO table](https://docs.pingcap.com/tidbcloudlake/copy-into-table/), [Tasks](https://docs.pingcap.com/tidbcloudlake/automate-data-loading-with-tasks/), [Full-text index](https://docs.pingcap.com/tidbcloudlake/full-text-index/), [Vector](https://docs.pingcap.com/tidbcloudlake/vector/) | Verified (page text) |
| Whether an `INSERT` with an array literal fills a `VECTOR(64)` column, whether NDJSON string values such as `2026-10-17 10:00:00.250` parse into `TIMESTAMP`, whether `CREATE INVERTED INDEX` right after `CREATE TABLE` behaves as documented for rows loaded later, how quickly `EXECUTE TASK` loads, and whether a warehouse can be dropped from a session that is bound to it. | Not documented end to end | **UNVERIFIED (U8)** |
| Which Lake regions match `aws-us-east-1` (the bucket, Starter instances and Lake warehouse should share a region), and whether an IAM user's access keys can back a Lake connection for this bucket. | [Lake overview](https://docs.pingcap.com/tidbcloudlake/lake-overview/) | **UNVERIFIED (U9)** |
| Pricing pages: Filesystem, Starter, Lake and S3. Do not copy numbers from them into this repo. | [Filesystem pricing](https://www.pingcap.com/tidb-cloud-filesystem-pricing-details/), [Starter](https://www.pingcap.com/tidb-cloud-starter/), [Lake pricing](https://docs.pingcap.com/tidbcloudlake/pricing-billing/), [S3 pricing](https://aws.amazon.com/s3/pricing/) | Verified (pages exist) |

### UNVERIFIED items and the packet that resolves each

| Item | Why it matters | Resolved by |
|---|---|---|
| U1 `ti` JSON field names | `parseLayerId`, `parseCheckpoint`, `parseLayerDiff`, `parseJournalVerify` read them | 12-V1 |
| U2 Filesystem limits, checkpoint-id scope, concurrent mounts, timings | the fan-out mounts four layers at once and reuses `step-NN` ids in every attempt | 12-V1 |
| U3 `ticloud` branch output and `list -o json` fields | `parseBranch`, `parseBranchList`, `waitActive` and the host, port and prefix used to connect | 12-V2 |
| U4 Branch authentication | the runner must open a SQL connection to every branch without a human | 12-V2 |
| U5 Branch-of-branch at a point in time | the replay branch is created with `--parent-id` and `--parent-timestamp` | 12-V2 |
| U6 Starter export output, states and Parquet mapping | the ledger reaches Lake by export, not by changefeed | 12-V4 |
| U7 Lake Node driver API | `createLakeClient` is written against the documented shape | 12-V3 |
| U8 Lake SQL behaviours | vector inserts, NDJSON timestamps, `EXECUTE TASK`, dropping the bound warehouse | 12-V3 |
| U9 Lake region and S3 access | all three products plus S3 must sit in one region | 12-V3 |
| U10 Starter hybrid search on this account | intake recall and lesson recall depend on both indexes | 12-V5 |

Each verify packet pastes the real output under this table, sets the status to VERIFIED or records the workaround, and changes docs only. If a captured sample does not parse, the packet that owns that parser gets a follow-up fix before it runs.

## 5. Prerequisites, cost, and teardown

- **Accounts and access:**
  - A TiDB Cloud organization where TiDB Cloud Filesystem, TiDB Cloud Starter and TiDB Cloud Lake (all preview) are available in `aws-us-east-1`, with a TiDB Cloud API key (public and private key) for `ti configure` and `ticloud config create`. The organization needs room for two Starter instances and four branches under its branch quota (the quota is on the [branch overview page](https://docs.pingcap.com/tidbcloud/branch-overview/)).
  - A TiDB Cloud Lake organization with a warehouse in a region that matches (U9) and a SQL user that can create databases, tables, connections, stages and tasks.
  - An AWS account with one S3 bucket in `us-east-1` and one IAM user whose access key is limited to that bucket. The key is used by the runner's S3 sink, by the Lake connection and by the Starter export, so it must be an IAM user key (no session token).
- **Local tools:** macOS with macFUSE, or Linux with `fuse3` (layers and checkpoints need FUSE). Node 22, pnpm, a `git` recent enough for `git init --initial-branch`, the `ti` CLI, the `ticloud` CLI, the `aws` CLI. The `lakesql` CLI is optional and only useful for manual Lake queries. No Docker, no `tiup`: nothing in this plan runs locally except the runner.
- **Cost model:** nothing is hardcoded here; use the pricing pages in section 4. All four bill by use.
  - Filesystem = (stored GB-months x the tier's storage rate) + (read requests x read rate) + (write requests x write rate) + (egress GB x egress rate), from [Filesystem pricing](https://www.pingcap.com/tidb-cloud-filesystem-pricing-details/). This demo stores a few kilobytes per layer plus journals, so storage is negligible. Requests are about two per step per attempt (drain, checkpoint) plus mounts, forks and journal appends.
  - Starter = (request units consumed beyond the free quota x the RU rate) + (storage GB x the storage rate), from [Starter pricing](https://www.pingcap.com/tidb-cloud-starter/). Two instances and four copy-on-write branches; the fixture has 2,000 small rows. Exports are billed as that page states.
  - Lake = (warehouse rate for the size and edition x seconds running / 3600) + (storage GB x the storage rate) + (API requests / 10,000 x the cloud-service rate), from [Lake pricing](https://docs.pingcap.com/tidbcloudlake/pricing-billing/). The dominant term is the warehouse: a task that runs every minute keeps the warehouse running, so warehouse seconds are roughly the wall-clock time between `ALTER TASK ingest_run_events RESUME` (Task 26, in setup) and `ALTER TASK ingest_run_events SUSPEND` (teardown), plus the idle tail before auto-suspend. API requests are the number of SQL statements the runner and the task issue; the runner opens one connection per statement, and polls every 3 seconds during the freshness wait.
  - S3 = (stored GB-months x the storage rate) + (PUT requests / 1,000 x the PUT rate) + (GET and LIST requests the Lake load makes), from [S3 pricing](https://aws.amazon.com/s3/pricing/). Same-region transfer to Lake and to Starter export is not egress. One run writes tens of small objects plus the synthetic history.
  - Record the actual run duration and the number of CLI calls in `LAB_ENV_NOTES` at capture time so the bill can be checked against these formulas.
- **Teardown (exact commands):** run the script, then the manual steps it cannot do, then confirm.
  1. Everything the demo created except the S3 bucket and the IAM user:
     ```bash
     cd demos/agent-coding
     node --import tsx runner/teardown.ts --destroy-instances
     ```
     Expected: one line per step starting `ok` (unmounts, one `delete branch` line per branch, `delete layer ... and every layer forked from it`, `empty s3://...`, `delete file system ...`, two `delete Starter instance ...` lines, then the Lake statements `ALTER TASK ingest_run_events SUSPEND` through `DROP WAREHOUSE IF EXISTS 'agent-coding-wh'`) and a last line `teardown finished with 0 failed steps`. Leave out `--destroy-instances` to keep the file system and instances for another run; everything else still happens.
  2. The manual equivalents, in case the script cannot run (replace the ids with the ones in `~/lab-agent-coding-work/state.json` and `.env`):
     ```bash
     ti fs unmount-file-system --mount-path ~/lab-agent-coding-work/attempt-1 --ignore-absent
     ticloud serverless branch list "$AGENT_FIXTURE_CLUSTER_ID" -o json --no-color
     ticloud serverless branch delete --cluster-id "$AGENT_FIXTURE_CLUSTER_ID" --branch-id <branch-id> --force --no-color
     ti fs delete-layer --layer-ref <task-layer-id> --cascade
     aws s3 rm "s3://$S3_BUCKET/$S3_PREFIX" --recursive
     ti fs delete-file-system --file-system-id "$TI_FS_FILE_SYSTEM_ID"
     ti db delete-db-cluster --db-cluster-id "$AGENT_ORG_CLUSTER_ID" --wait
     ti db delete-db-cluster --db-cluster-id "$AGENT_FIXTURE_CLUSTER_ID" --wait
     ```
     In a Lake SQL worksheet or with `lakesql`, run: `ALTER TASK ingest_run_events SUSPEND;`, `DROP TASK IF EXISTS ingest_run_events;`, `DROP DATABASE IF EXISTS agent_coding;`, `DROP CONNECTION IF EXISTS agent_s3;`, `ALTER WAREHOUSE 'agent-coding-wh' SUSPEND;`, `DROP WAREHOUSE IF EXISTS 'agent-coding-wh';`. The script runs the same statements, but dropping the warehouse from a session bound to it may be refused (U8); if so, run those last two from the console.
  3. The bucket and the IAM user (the script does not touch them):
     ```bash
     aws s3 rm "s3://$S3_BUCKET" --recursive
     aws s3api delete-bucket --bucket "$S3_BUCKET" --region us-east-1
     aws iam list-access-keys --user-name agent-coding-lab
     aws iam delete-access-key --user-name agent-coding-lab --access-key-id <access-key-id>
     aws iam delete-user-policy --user-name agent-coding-lab --policy-name agent-coding-lab-bucket
     aws iam delete-user --user-name agent-coding-lab
     ```
  4. Confirm nothing is left billing:
     ```bash
     ti fs list-file-systems --region aws-us-east-1 --output text
     ti db list-db-clusters --db-cluster-type starter --region aws-us-east-1 --output text
     aws s3 ls
     ```
     Expected: no `agent-coding-lab` file system, no `agent-coding-org` or `agent-coding-fixture` instance, no lab bucket. In the Lake console, `SHOW WAREHOUSES` lists no `agent-coding-wh` and `SHOW TASKS` lists no `ingest_run_events`. Check the Lake and TiDB Cloud billing pages the next day for any usage that kept accruing.

## 6. File structure

```
packages/agent-stack-kit/                    @lab/agent-stack-kit, shared with Plan 13
  package.json                               exports ./src/index.ts, depends on the S3 SDK and the Lake driver
  tsconfig.json                              extends ../../tsconfig.base.json
  src/
    index.ts                                 the public surface, exactly the documented names
    cli.ts                                   runCli (I/O) and stdoutOrThrow
    parse.ts                                 pure parsers: layer id, checkpoint, layer diff, journal verify, branch, branch list
    tifs.ts                                  ti fs and fs-journal and fs-vault argument builders and the tiFs adapter
    branches.ts                              ticloud branch argument builders, wait decision and the branches adapter
    lake-config.ts                           lakeConfigFromEnv and the pure helpers the Lake client uses
    lake-client.ts                           createLakeClient (I/O)
    s3-events.ts                             toNdjson and the pure object key builder
    s3-sink.ts                               createS3EventSink (I/O)
    time.ts                                  rfc3339Second
  test/                                      one test file per source file, plus index.test.ts for the public surface
demos/agent-coding/
  manifest.json                              nodes, edges, metrics, phases, checks, controls
  package.json                               "@lab/demo-agent-coding", workspace dependencies, teardown and seed-fixture scripts
  tsconfig.json                              extends ../../tsconfig.base.json
  vitest.config.ts                           keeps Vitest away from the fixture repo's own tests
  README.md                                  what it proves, setup, run, record, cost, teardown
  TALK-TRACK.md                              presenter script, discovery questions, objections
  .env.example                               the standard block plus the demo variables
  fixtures/
    payments-api/                            the tiny repo the agent works on (a failing node:test)
      package.json, README.md
      src/gateway.js, src/ledger.js, src/charge.js
      test/charge.test.js
    attempts/
      attempt-1.json, attempt-2.json, attempt-3.json    the scripted steps per attempt
      attempt-1/, attempt-2/, attempt-3/                the candidate patch files the steps copy in
  runner/
    main.ts                                  entry: wires the kit, the pools and the runner
    seed-fixture.ts                          seeds the fixture instance with deterministic rows
    teardown.ts                              runs the teardown plan and the Lake statements
    src/
      scripts.ts, fixtureStore.ts            attempt script schema and loader, path owners
      tap.ts, score.ts, tree.ts              TAP parsing, scoring and winner choice, tree hash
      harness.ts                             applies a step, runs the fixture tests, plays an attempt, reads a tree
      random.ts, fixtureData.ts, snapshot.ts, embedding.ts    seeded rows, branch snapshot SQL, hashed embedding
      starterSql.ts                          memories and ledger DDL, seed memories, the hybrid search builder
      lakeSql.ts                             Lake setup, load, count, eval and teardown SQL
      history.ts, events.ts                  synthetic history and run event builders
      checks.ts, gates.ts, lesson.ts         check verdicts, control gating, lesson text
      config.ts, branchEnv.ts, ticloudExport.ts    environment, branch connection env, export helpers
      state.ts, stateStore.ts, teardownPlan.ts    run state file and the teardown plan
      git.ts                                 pushes the winner to a local bare repository
      sql.ts, context.ts                     the Sql wrapper and the run context
      stages/setup.ts, intake.ts, seed.ts, fanout.ts, workloop.ts, winner.ts, replay.ts, eval.ts, lesson.ts
      runner.ts                              control queue, auto play, shutdown
    test/                                    one test file per source file, plus fakes.ts and runner.test.ts
  test/manifest.test.ts                      parses manifest.json with DemoManifestSchema
  traces/featured.json                       the recording the website plays (committed after section 8)
```

The kit keeps pure logic and I/O in separate files on purpose: `lake-config.ts` and `s3-events.ts` import nothing external, so their tests run without the Lake driver or the S3 SDK. The kit's barrel exports exactly these runtime names, which Plan 13 may rely on: `runCli`, `parseLayerId`, `parseCheckpoint`, `parseLayerDiff`, `parseJournalVerify`, `parseBranch`, `tiFs`, `branches`, `lakeConfigFromEnv`, `createLakeClient`, `createS3EventSink`, `toNdjson`, `rfc3339Second`. It also exports the types `CliOptions`, `CliResult`, `RunCli`, `BranchInfo`, `ParsedBranch`, `TiFs`, `Branches`, `LakeClient`, `LakeConfig` and `S3EventSink`.

### Kit API reference (for Plan 13)

| Name | Signature |
|---|---|
| `runCli` | `(opts: { bin: string; args: readonly string[]; env?: Readonly<Record<string, string>> }) => Promise<{ code: number; stdout: string; stderr: string }>`; never rejects on a nonzero exit; a missing binary returns code 127 |
| `parseLayerId` | `(stdout: string) => string` |
| `parseCheckpoint` | `(stdout: string) => { checkpointId: string }` |
| `parseLayerDiff` | `(stdout: string) => readonly string[]` (changed paths, sorted, unique) |
| `parseJournalVerify` | `(stdout: string) => { ok: boolean }` |
| `parseBranch` | `(stdout: string) => { branchId: string; state: string }` |
| `tiFs.createLayer` | `({ baseRootPath, layerName, actorId?, tags? }) => Promise<{ layerId }>` (always `--durability-mode restore-safe`) |
| `tiFs.checkpoint` | `({ layerId, mountPath, checkpointId, label?, drainTimeout? }) => Promise<{ checkpointId, drainMs, checkpointMs }>`; drains the mount, then creates the checkpoint |
| `tiFs.forkLayer` | `({ parentLayerRef, layerName, checkpointId?, actorId? }) => Promise<{ layerId }>` |
| `tiFs.mountLayer` | `({ mountPath, layerRef, remotePath, checkpointId?, readOnly? }) => Promise<void>` (FUSE) |
| `tiFs.unmount` | `({ mountPath }) => Promise<void>` |
| `tiFs.diffLayer` | `({ layerId }) => Promise<readonly string[]>` |
| `tiFs.commitLayer`, `tiFs.rollbackLayer` | `({ layerId }) => Promise<void>` |
| `tiFs.deleteLayer` | `({ layerRef, cascade? }) => Promise<void>` |
| `tiFs.grep` | `({ pattern, path?, layerId?, limit? }) => Promise<string>` (raw stdout) |
| `tiFs.createJournal` | `({ journalId, journalKind?, title? }) => Promise<void>` |
| `tiFs.appendJournal` | `({ journalId, entry, idempotencyKey }) => Promise<void>` |
| `tiFs.verifyJournal` | `({ journalId }) => Promise<{ ok }>` |
| `tiFs.createGrant` | `({ agentId, scope, permission, ttl }) => Promise<string>` (the token) |
| `branches.create` | `({ clusterId, name, parentId?, parentTimestamp? }) => Promise<{ branchId, state }>` using `ticloud serverless branch create`; `parentTimestamp` must be RFC3339 (use `rfc3339Second`) |
| `branches.waitActive` | `({ clusterId, branchId, timeoutMs?, pollMs? }) => Promise<BranchInfo>` |
| `branches.remove` | `({ clusterId, branchId }) => Promise<void>` |
| `branches.list` | `({ clusterId }) => Promise<readonly BranchInfo[]>`; `BranchInfo` is `{ branchId, state, host?, port?, userPrefix? }` |
| `lakeConfigFromEnv` | `(env) => { dsn, warehouse, database }`; reads `LAKE_HOST`, `LAKE_USER`, `LAKE_PASSWORD`, `LAKE_WAREHOUSE`, optional `LAKE_DATABASE`, `LAKE_PORT` |
| `createLakeClient` | `(config) => { query(sql): Promise<readonly Record<string, unknown>[]> }`; one connection per statement; non-read statements go through `exec` and return `[]` |
| `createS3EventSink` | `({ bucket, prefix, region }) => { write(lines: readonly string[]): Promise<{ key }> }`; one NDJSON object per call, credentials from the default AWS chain |
| `toNdjson` | `(events: readonly object[]) => string` |
| `rfc3339Second` | `(isoOrDate: string \| Date) => string`; rounds up to the next whole second |

Every method that shells out is built from a pure argument builder that has a test; `createTiFs(run, clock?)` and `createBranches(run, { clock?, sleep? })` accept a fake runner so Plan 13 can test against them the same way.

## 7. Tasks

Commands run from the `integrations/` workspace root unless a step says otherwise. "Expected FAIL" is the RED step: the test imports a module that does not exist yet. Tasks 2 to 23 are test-first, one RED and one GREEN each. Tasks 24 to 29 are one cycle: the whole-run test is written first (Task 24), the stage code in Tasks 25 to 28 is typechecked as it is written, and the test goes green in Task 29. Thin I/O adapters (`runCli`, `createLakeClient`, `createS3EventSink`, the stage files) are covered by that stand-in run and by the live steps. Tasks 1, 30, 31 and 34 are manual or entry-point steps.

### Task 1: Live resources (manual, cloud accounts)

- [ ] Not started

Create everything the demo runs against, once. Keep a scratch note of every id and secret; Task 31 copies them into `.env`. Do not commit any of them. Every step is a human step on a trusted machine: installing macFUSE needs a system extension approval, and creating cloud resources bills your account.

**Step 1: tools.**

```bash
curl -fsSL https://github.com/tidbcloud/ti-cli/releases/latest/download/install.sh | sh -s -- --yes
ti configure
ti --version
curl https://raw.githubusercontent.com/tidbcloud/tidbcloud-cli/main/install.sh | sh
ticloud config create --profile-name agent-coding --public-key <public-key> --private-key <private-key>
ticloud --version
aws --version
```

Expected: each `--version` prints a version string (record them for `LAB_ENV_COMPONENT_TI_CLI` and `LAB_ENV_COMPONENT_TICLOUD_CLI`). `ti configure` is interactive: pick API-key authentication and `aws-us-east-1` as the default region.

On macOS install macFUSE and approve its system extension in System Settings (a human step; restart if asked):

```bash
brew install --cask macfuse
```

On Linux:

```bash
sudo apt-get install -y fuse3
ls -l /dev/fuse
```

Expected: `/dev/fuse` exists and your user may open it (add yourself to the `fuse` group if not). Record the macFUSE or fuse3 version for `LAB_ENV_COMPONENT_FUSE`.

**Step 2: bucket and IAM user.** Write `policy.json` outside the repo (replace `<bucket>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": "arn:aws:s3:::<bucket>" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::<bucket>/*" }
  ]
}
```

```bash
export S3_BUCKET=agent-coding-lab-<unique-suffix>
aws s3api create-bucket --bucket "$S3_BUCKET" --region us-east-1
aws s3api put-public-access-block --bucket "$S3_BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws iam create-user --user-name agent-coding-lab
aws iam put-user-policy --user-name agent-coding-lab --policy-name agent-coding-lab-bucket --policy-document file://policy.json
aws iam create-access-key --user-name agent-coding-lab
```

Expected: `create-bucket` prints a `Location`; `create-access-key` prints an `AccessKeyId` and a `SecretAccessKey` once. Save both in the scratch note.

**Step 3: file system.**

```bash
ti fs create-file-system --display-name agent-coding-lab --label project=agent-coding-lab --wait --region aws-us-east-1
ti fs list-file-systems --region aws-us-east-1 --output text
```

Expected: the first command exits 0 and prints the new file system's id (and stores the owner token in your profile; if it warns that it could not store the token, copy the token before closing the terminal). The second lists `agent-coding-lab`. Save the id as `TI_FS_FILE_SYSTEM_ID`.

**Step 4: two Starter instances.**

```bash
ti db create-db-cluster --db-cluster-type starter --db-cluster-name agent-coding-org --wait --region aws-us-east-1
ti db create-db-cluster --db-cluster-type starter --db-cluster-name agent-coding-fixture --wait --region aws-us-east-1
ti db create-db-sql-users --db-cluster-id <org-cluster-id>
ti db create-db-sql-users --db-cluster-id <fixture-cluster-id>
ti db format-db-connection-string --db-cluster-id <org-cluster-id> --read-write
ti db format-db-connection-string --db-cluster-id <fixture-cluster-id> --admin
ti db format-db-connection-string --db-cluster-id <fixture-cluster-id> --read-only
```

Expected: each create exits 0 once the instance is ACTIVE and prints its id; `create-db-sql-users` creates the read-only, read-write and admin users and stores their credentials under `~/.ti/db_users/<cluster-id>/`; each `format-db-connection-string` prints the host, user and password for that role (use `--format` as the command page describes if you want environment-variable lines). Map them like this: the org instance's read-write user becomes `TIDB_HOST`, `TIDB_USER`, `TIDB_PASSWORD` in `.env` (and `TIDB_PORT`, with `TIDB_TLS=true`); the fixture instance's admin user becomes `FIXTURE_HOST`, `FIXTURE_ADMIN_USER`, `FIXTURE_ADMIN_PASSWORD`; the fixture instance's read-only user becomes `FIXTURE_SQL_USER` and `FIXTURE_SQL_PASSWORD`. The cluster ids become `AGENT_ORG_CLUSTER_ID` and `AGENT_FIXTURE_CLUSTER_ID`. The fixture database stays empty here; Task 31 seeds it.

**Step 5: Lake.** In the TiDB Cloud Lake console, in the region that matches `aws-us-east-1` (U9), create a warehouse named `agent-coding-wh` with size XSmall. Then open Overview, Connect, select the warehouse, and copy the host, the SQL user and the password the dialog shows (the password is shown once; Reset generates a new one). They become `LAKE_HOST`, `LAKE_USER`, `LAKE_PASSWORD`, `LAKE_WAREHOUSE=agent-coding-wh`.

Expected: the console lists the warehouse as Running or Suspended, and the connect dialog shows a `lake://` connection string for it.

Done when: the scratch note holds the file system id, both cluster ids, the org and fixture credentials, the Lake host, user and password, the bucket and the IAM access key. No commit (nothing in the repo changes).

### Task 2: Scaffold `@lab/agent-stack-kit`

- [ ] Not started

Create the package skeleton (no tests yet). The two external dependencies are added with `pnpm add` so the lockfile records real versions.

`packages/agent-stack-kit/package.json`:

```json
{
  "name": "@lab/agent-stack-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`packages/agent-stack-kit/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run:

```bash
mkdir -p packages/agent-stack-kit/src packages/agent-stack-kit/test
pnpm install
pnpm --filter @lab/agent-stack-kit add @aws-sdk/client-s3 tidbcloudlake-driver
```

Expected: `pnpm install` links the new workspace package; `pnpm --filter @lab/agent-stack-kit add ...` exits 0 and adds `@aws-sdk/client-s3` and `tidbcloudlake-driver` to a new `dependencies` block in the package's `package.json` (the skeleton above has none yet; keep the ranges pnpm writes). If `tidbcloudlake-driver` fails to install on your platform, stop and record that in section 4 under U7 before continuing.

Commit:

```bash
git add packages/agent-stack-kit/package.json packages/agent-stack-kit/tsconfig.json pnpm-lock.yaml
git commit -m "agent-stack-kit: scaffold package"
```

### Task 3: `rfc3339Second`

- [ ] Not started

The branch API takes an RFC3339 timestamp with second granularity, and the ledger holds millisecond clocks, so the replay branch is created at the next whole second at or after the failing step's clock. Write the failing test first.

`packages/agent-stack-kit/test/time.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rfc3339Second } from '../src/time';

describe('rfc3339Second', () => {
  it('rounds a fractional second up to the next whole second', () => {
    expect(rfc3339Second('2026-10-17T10:00:00.250Z')).toBe('2026-10-17T10:00:01Z');
  });

  it('keeps a timestamp that is already on a whole second', () => {
    expect(rfc3339Second('2026-10-17T10:00:00.000Z')).toBe('2026-10-17T10:00:00Z');
  });

  it('rounds microsecond precision up as well', () => {
    expect(rfc3339Second('2026-10-17T10:00:00.000001Z')).toBe('2026-10-17T10:00:01Z');
  });

  it('carries across a minute boundary', () => {
    expect(rfc3339Second('2026-10-17T10:00:59.900Z')).toBe('2026-10-17T10:01:00Z');
  });

  it('accepts a Date', () => {
    expect(rfc3339Second(new Date('2026-10-17T10:00:00.001Z'))).toBe('2026-10-17T10:00:01Z');
  });

  it('rejects text that is not a timestamp', () => {
    expect(() => rfc3339Second('yesterday')).toThrow(RangeError);
  });
});
```

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/time.test.ts
```

Expected FAIL: `Cannot find module '../src/time'`.

`packages/agent-stack-kit/src/time.ts`:

```ts
const hasSubMillisecondFraction = (value: string): boolean => {
  const extra = /\.\d{3}(\d+)/.exec(value)?.[1];
  return extra !== undefined && /[1-9]/.test(extra);
};

export const rfc3339Second = (value: string | Date): string => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`not a timestamp: ${String(value)}`);
  const exactMs = typeof value === 'string' && hasSubMillisecondFraction(value) ? ms + 0.5 : ms;
  const ceiled = Math.ceil(exactMs / 1000) * 1000;
  return new Date(ceiled).toISOString().replace('.000Z', 'Z');
};
```

JavaScript's `Date.parse` silently drops digits beyond milliseconds, so the helper looks at the extra digits itself; the microsecond test fails without that.

Run the same command. Expected PASS: `Tests  6 passed (6)`.

Commit:

```bash
git add packages/agent-stack-kit/src/time.ts packages/agent-stack-kit/test/time.test.ts
git commit -m "agent-stack-kit: add rfc3339Second"
```

### Task 4: `runCli`

- [ ] Not started

One function shells out for every CLI the kit wraps. It never rejects on a nonzero exit (callers decide), reports a missing binary as exit code 127, and merges extra environment variables over the process environment.

`packages/agent-stack-kit/test/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCli, stdoutOrThrow } from '../src/cli';

describe('runCli', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await runCli({ bin: process.execPath, args: ['-e', 'process.stdout.write("hello")'] });
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: '' });
  });

  it('returns a nonzero exit code and stderr instead of throwing', async () => {
    const result = await runCli({
      bin: process.execPath,
      args: ['-e', 'process.stderr.write("bad"); process.exit(3)'],
    });
    expect(result).toEqual({ code: 3, stdout: '', stderr: 'bad' });
  });

  it('passes extra environment variables to the child', async () => {
    const result = await runCli({
      bin: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.KIT_PROBE ?? "")'],
      env: { KIT_PROBE: 'on' },
    });
    expect(result.stdout).toBe('on');
  });

  it('reports a missing binary as exit code 127', async () => {
    const result = await runCli({ bin: 'definitely-not-a-real-binary', args: [] });
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('ENOENT');
  });
});

describe('stdoutOrThrow', () => {
  it('returns stdout on success', () => {
    expect(stdoutOrThrow({ code: 0, stdout: 'x', stderr: '' }, 'ti fs')).toBe('x');
  });

  it('names the command and stderr on failure', () => {
    expect(() => stdoutOrThrow({ code: 2, stdout: '', stderr: ' boom ' }, 'ti fs')).toThrow(
      'ti fs failed with exit code 2: boom',
    );
  });
});
```

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/cli.test.ts
```

Expected FAIL: `Cannot find module '../src/cli'`.

`packages/agent-stack-kit/src/cli.ts`:

```ts
import { spawn } from 'node:child_process';

export type CliOptions = {
  readonly bin: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type CliResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunCli = (options: CliOptions) => Promise<CliResult>;

export const runCli: RunCli = (options) =>
  new Promise((resolve) => {
    const child = spawn(options.bin, [...options.args], {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => resolve({ code: 127, stdout: '', stderr: error.message }));
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });

export const stdoutOrThrow = (result: CliResult, label: string): string => {
  if (result.code === 0) return result.stdout;
  const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
  throw new Error(`${label} failed with exit code ${result.code}: ${detail}`);
};
```

Run the same command. Expected PASS: `Tests  6 passed (6)`.

Commit:

```bash
git add packages/agent-stack-kit/src/cli.ts packages/agent-stack-kit/test/cli.test.ts
git commit -m "agent-stack-kit: add runCli"
```

### Task 5: Pure parsers for `ti` and `ticloud` output

- [ ] Not started

**Inputs are UNVERIFIED (U1, U3).** The page text of the CLIs does not document each command's JSON field names. The parsers read JSON first (the `ti` default) and fall back to labelled text, accept the likely key spellings, and throw a message that quotes the start of the output when nothing matches. The sample inputs in this test are documented-shape samples written for this plan, not captured output. Before you run this task, take every real sample pasted into section 4 by 12-V1 and 12-V2 and add it as one more `it` case in `parse.test.ts` next to its siblings; if a real sample fails, widen the key list in `parse.ts` until it passes. Do not edit a test to match a guess.

`packages/agent-stack-kit/test/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  parseBranch,
  parseBranchList,
  parseCheckpoint,
  parseJournalVerify,
  parseLayerDiff,
  parseLayerId,
} from '../src/parse';

describe('parseLayerId', () => {
  it('reads layer_id from JSON output', () => {
    expect(parseLayerId('{"layer_id":"lyr_9f2c","layer_name":"task","base_root_path":"/workspace"}')).toBe('lyr_9f2c');
  });

  it('finds a nested layer id', () => {
    expect(parseLayerId('{"layer":{"layerId":"lyr_nested"}}')).toBe('lyr_nested');
  });

  it('reads a labelled text line', () => {
    expect(parseLayerId('created layer\nlayer_id: lyr_text-1\nname: task')).toBe('lyr_text-1');
  });

  it('throws when no layer id is present', () => {
    expect(() => parseLayerId('{"ok":true}')).toThrow('layer id not found in output');
  });
});

describe('parseCheckpoint', () => {
  it('reads checkpoint_id from JSON output', () => {
    expect(parseCheckpoint('{"checkpoint_id":"step-03","layer_id":"lyr_1"}')).toEqual({ checkpointId: 'step-03' });
  });

  it('reads a labelled text line', () => {
    expect(parseCheckpoint('checkpoint id = seed')).toEqual({ checkpointId: 'seed' });
  });

  it('throws when no checkpoint id is present', () => {
    expect(() => parseCheckpoint('done')).toThrow('checkpoint id not found in output');
  });
});

describe('parseLayerDiff', () => {
  it('returns sorted unique paths from an array of change objects', () => {
    const stdout = JSON.stringify({
      changes: [
        { op: 'write', path: '/workspace/payments-api/src/charge.js' },
        { op: 'create', path: '/workspace/payments-api/src/idempotency.js' },
        { op: 'write', path: '/workspace/payments-api/src/charge.js' },
      ],
    });
    expect(parseLayerDiff(stdout)).toEqual([
      '/workspace/payments-api/src/charge.js',
      '/workspace/payments-api/src/idempotency.js',
    ]);
  });

  it('accepts a bare array of path strings', () => {
    expect(parseLayerDiff('["/b","/a"]')).toEqual(['/a', '/b']);
  });

  it('returns an empty list for an empty change set', () => {
    expect(parseLayerDiff('{"changes":[]}')).toEqual([]);
  });

  it('falls back to the last absolute path on each text line', () => {
    expect(parseLayerDiff('M /workspace/a.js\nA /workspace/b.js\n')).toEqual(['/workspace/a.js', '/workspace/b.js']);
  });
});

describe('parseJournalVerify', () => {
  it('reads a boolean flag', () => {
    expect(parseJournalVerify('{"ok":true,"entries":12}')).toEqual({ ok: true });
    expect(parseJournalVerify('{"valid":false}')).toEqual({ ok: false });
  });

  it('reads a status string', () => {
    expect(parseJournalVerify('{"status":"verified"}')).toEqual({ ok: true });
    expect(parseJournalVerify('{"status":"hash mismatch"}')).toEqual({ ok: false });
  });

  it('reads plain text', () => {
    expect(parseJournalVerify('journal verified')).toEqual({ ok: true });
    expect(parseJournalVerify('hash chain broken at entry 4')).toEqual({ ok: false });
  });

  it('throws on output it cannot classify', () => {
    expect(() => parseJournalVerify('???')).toThrow('journal verification result not found in output');
  });
});

describe('parseBranch', () => {
  it('reads branchId and state from JSON output', () => {
    expect(parseBranch('{"branchId":"br_123","displayName":"a1","state":"CREATING"}')).toEqual({
      branchId: 'br_123',
      state: 'CREATING',
    });
  });

  it('reads labelled text output', () => {
    expect(parseBranch('Branch ID: br_456\nState: ACTIVE\n')).toEqual({ branchId: 'br_456', state: 'ACTIVE' });
  });

  it('reports UNKNOWN when no state is printed', () => {
    expect(parseBranch('{"branch_id":"br_789"}')).toEqual({ branchId: 'br_789', state: 'UNKNOWN' });
  });

  it('throws when no branch id is present', () => {
    expect(() => parseBranch('created')).toThrow('branch id not found in output');
  });
});

describe('parseBranchList', () => {
  it('reads branches with endpoint details', () => {
    const stdout = JSON.stringify({
      branches: [
        {
          branchId: 'br_1',
          state: 'ACTIVE',
          userPrefix: '3pTAoNNegb47Uc8',
          endpoints: { public: { host: 'gateway01.us-east-1.prod.aws.tidbcloud.com', port: 4000 } },
        },
        { branchId: 'br_2', state: 'CREATING' },
      ],
    });
    expect(parseBranchList(stdout)).toEqual([
      {
        branchId: 'br_1',
        state: 'ACTIVE',
        host: 'gateway01.us-east-1.prod.aws.tidbcloud.com',
        port: 4000,
        userPrefix: '3pTAoNNegb47Uc8',
      },
      { branchId: 'br_2', state: 'CREATING', host: undefined, port: undefined, userPrefix: undefined },
    ]);
  });

  it('accepts a top-level array', () => {
    expect(parseBranchList('[{"id":"br_9","state":"ACTIVE"}]').map((branch) => branch.branchId)).toEqual(['br_9']);
  });

  it('throws when the output is not JSON', () => {
    expect(() => parseBranchList('table output')).toThrow('branch list not found in output');
  });
});
```

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/parse.test.ts
```

Expected FAIL: `Cannot find module '../src/parse'`.

`packages/agent-stack-kit/src/parse.ts`:

```ts
export type ParsedBranch = { readonly branchId: string; readonly state: string };

export type BranchInfo = ParsedBranch & {
  readonly host?: string;
  readonly port?: number;
  readonly userPrefix?: string;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const findValue = <T>(
  value: unknown,
  keys: readonly string[],
  accept: (candidate: unknown) => candidate is T,
): T | undefined => {
  if (isList(value)) return value.map((item) => findValue(item, keys, accept)).find((found) => found !== undefined);
  if (!isRecord(value)) return undefined;
  const direct = keys.map((key) => value[key]).find(accept);
  if (direct !== undefined) return direct;
  return Object.values(value)
    .map((child) => findValue(child, keys, accept))
    .find((found) => found !== undefined);
};

const isNonEmptyString = (candidate: unknown): candidate is string => typeof candidate === 'string' && candidate !== '';
const isBoolean = (candidate: unknown): candidate is boolean => typeof candidate === 'boolean';
const isFiniteNumber = (candidate: unknown): candidate is number =>
  typeof candidate === 'number' && Number.isFinite(candidate);

const findString = (value: unknown, keys: readonly string[]): string | undefined =>
  findValue(value, keys, isNonEmptyString);

const labelled = (stdout: string, label: string): string | undefined =>
  new RegExp(`${label}["']?\\s*[:=]\\s*["']?([A-Za-z0-9_.-]+)`, 'i').exec(stdout)?.[1];

const unrecognised = (what: string, stdout: string): Error =>
  new Error(`${what} not found in output: ${stdout.slice(0, 200)}`);

export const parseLayerId = (stdout: string): string => {
  const found = findString(parseJson(stdout), ['layer_id', 'layerId', 'id']) ?? labelled(stdout, 'layer[_ ]?id');
  if (found === undefined) throw unrecognised('layer id', stdout);
  return found;
};

export const parseCheckpoint = (stdout: string): { readonly checkpointId: string } => {
  const found =
    findString(parseJson(stdout), ['checkpoint_id', 'checkpointId', 'id']) ?? labelled(stdout, 'checkpoint[_ ]?id');
  if (found === undefined) throw unrecognised('checkpoint id', stdout);
  return { checkpointId: found };
};

const diffListKeys: readonly string[] = ['changes', 'entries', 'diff', 'items', 'paths', 'files'];

const diffEntries = (value: unknown): readonly unknown[] => {
  if (isList(value)) return value;
  if (!isRecord(value)) return [];
  const listed = diffListKeys.map((key) => value[key]).find(isList);
  if (listed !== undefined) return listed;
  return Object.values(value).flatMap((child) => (isRecord(child) ? diffEntries(child) : []));
};

const entryPath = (entry: unknown): string | undefined =>
  isNonEmptyString(entry) ? entry : findString(entry, ['path', 'file_path', 'filePath']);

const textPaths = (stdout: string): readonly string[] =>
  stdout
    .split('\n')
    .map((line) => /(\/\S+)\s*$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined);

const sortedUnique = (paths: readonly string[]): readonly string[] => [...new Set(paths)].sort();

export const parseLayerDiff = (stdout: string): readonly string[] => {
  const parsed = parseJson(stdout);
  if (parsed === undefined) return sortedUnique(textPaths(stdout));
  return sortedUnique(diffEntries(parsed).map(entryPath).filter((path): path is string => path !== undefined));
};

const verifyFlagKeys: readonly string[] = ['ok', 'valid', 'verified', 'is_valid', 'chain_valid'];

export const parseJournalVerify = (stdout: string): { readonly ok: boolean } => {
  const parsed = parseJson(stdout);
  const flag = findValue(parsed, verifyFlagKeys, isBoolean);
  if (flag !== undefined) return { ok: flag };
  const status = findString(parsed, ['status', 'result']);
  if (status !== undefined) return { ok: /^(ok|valid|verified|pass|passed|success)$/i.test(status) };
  if (/\b(invalid|broken|mismatch|failed|tamper)/i.test(stdout)) return { ok: false };
  if (/\b(valid|verified|ok)\b/i.test(stdout)) return { ok: true };
  throw unrecognised('journal verification result', stdout);
};

const branchIdKeys: readonly string[] = ['branchId', 'branch_id', 'branchID', 'id'];

export const parseBranch = (stdout: string): ParsedBranch => {
  const parsed = parseJson(stdout);
  const branchId =
    findString(parsed, branchIdKeys) ?? labelled(stdout, 'branch[ _-]?id') ?? labelled(stdout, '\\bid');
  if (branchId === undefined) throw unrecognised('branch id', stdout);
  const state = findString(parsed, ['state', 'status']) ?? labelled(stdout, '\\bstate') ?? 'UNKNOWN';
  return { branchId, state };
};

const branchFrom = (entry: unknown): BranchInfo | undefined => {
  const branchId = findString(entry, branchIdKeys);
  if (branchId === undefined) return undefined;
  return {
    branchId,
    state: findString(entry, ['state', 'status']) ?? 'UNKNOWN',
    host: findString(entry, ['host']),
    port: findValue(entry, ['port'], isFiniteNumber),
    userPrefix: findString(entry, ['userPrefix', 'user_prefix']),
  };
};

export const parseBranchList = (stdout: string): readonly BranchInfo[] => {
  const parsed = parseJson(stdout);
  if (parsed === undefined) throw unrecognised('branch list', stdout);
  const listed = isRecord(parsed) ? [parsed.branches, parsed.items, parsed.data].find(isList) : undefined;
  const entries = isList(parsed) ? parsed : (listed ?? []);
  return entries.map(branchFrom).filter((branch): branch is BranchInfo => branch !== undefined);
};
```

`parseBranch` returns exactly `{ branchId, state }`. `parseBranchList` is internal to the kit (not in the barrel); `branches.list` uses it to add the endpoint host, port and user-name prefix the runner needs to connect.

Run the same command. Expected PASS: `Tests  22 passed (22)`.

Commit:

```bash
git add packages/agent-stack-kit/src/parse.ts packages/agent-stack-kit/test/parse.test.ts
git commit -m "agent-stack-kit: add CLI output parsers"
```

### Task 6: `tiFs` adapter

- [ ] Not started

Every `ti` call is built by a pure argument builder, then run through an injected runner, so the tests assert the exact argv and the adapter never needs a live account to be tested. `checkpoint` drains the mount first (a checkpoint only holds what reached the service) and returns how long each half took. Every parse-dependent call passes `--output json` so the format does not depend on a profile default.

`packages/agent-stack-kit/test/tifs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CliOptions, CliResult, RunCli } from '../src/cli';
import { createTiFs } from '../src/tifs';

const recordingRunner = (
  responses: readonly CliResult[],
): { readonly calls: readonly CliOptions[]; readonly run: RunCli } => {
  const calls: CliOptions[] = [];
  const queue = [...responses];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      return queue.shift() ?? { code: 0, stdout: '', stderr: '' };
    },
  };
};

const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '' });

describe('createTiFs', () => {
  it('creates a restore-safe layer and returns its id', async () => {
    const { calls, run } = recordingRunner([ok('{"layer_id":"lyr_1"}')]);
    const result = await createTiFs(run).createLayer({
      baseRootPath: '/workspace',
      layerName: 'task',
      tags: { task: 'KIT-8812' },
    });
    expect(result).toEqual({ layerId: 'lyr_1' });
    expect(calls[0]).toEqual({
      bin: 'ti',
      args: [
        'fs',
        'create-layer',
        '--base-root-path',
        '/workspace',
        '--layer-name',
        'task',
        '--durability-mode',
        'restore-safe',
        '--tag',
        'task=KIT-8812',
        '--output',
        'json',
      ],
    });
  });

  it('drains the mount before it creates the checkpoint and times both', async () => {
    const times = [100, 140, 190];
    const clock = (): number => times.shift() ?? 0;
    const { calls, run } = recordingRunner([ok(''), ok('{"checkpoint_id":"step-01"}')]);
    const result = await createTiFs(run, clock).checkpoint({
      layerId: 'lyr_1',
      mountPath: '/mnt/a1',
      checkpointId: 'step-01',
    });
    expect(result).toEqual({ checkpointId: 'step-01', drainMs: 40, checkpointMs: 50 });
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['fs', 'drain-file-system'],
      ['fs', 'create-layer-checkpoint'],
    ]);
  });

  it('forks from a checkpoint', async () => {
    const { calls, run } = recordingRunner([ok('{"layer_id":"lyr_2"}')]);
    const result = await createTiFs(run).forkLayer({
      parentLayerRef: 'lyr_1',
      layerName: 'attempt-1',
      checkpointId: 'seed',
    });
    expect(result).toEqual({ layerId: 'lyr_2' });
    expect(calls[0]?.args).toEqual([
      'fs',
      'fork-layer',
      '--parent-layer-ref',
      'lyr_1',
      '--layer-name',
      'attempt-1',
      '--checkpoint-id',
      'seed',
      '--output',
      'json',
    ]);
  });

  it('mounts a layer through FUSE and can request a read-only checkpoint mount', async () => {
    const { calls, run } = recordingRunner([ok(''), ok('')]);
    const tiFs = createTiFs(run);
    await tiFs.mountLayer({ mountPath: '/mnt/a1', layerRef: 'lyr_2', remotePath: '/workspace' });
    await tiFs.mountLayer({
      mountPath: '/mnt/c',
      layerRef: 'lyr_2',
      remotePath: '/workspace',
      checkpointId: 'step-07',
      readOnly: true,
    });
    expect(calls[0]?.args).toEqual([
      'fs',
      'mount-file-system',
      '--mount-path',
      '/mnt/a1',
      '--remote-path',
      '/workspace',
      '--driver',
      'fuse',
      '--layer-ref',
      'lyr_2',
    ]);
    expect(calls[1]?.args.slice(-5)).toEqual(['--layer-ref', 'lyr_2', '--checkpoint-id', 'step-07', '--read-only']);
  });

  it('returns the changed paths from diff-layer', async () => {
    const { run } = recordingRunner([ok('{"changes":[{"path":"/workspace/a.js"}]}')]);
    expect(await createTiFs(run).diffLayer({ layerId: 'lyr_2' })).toEqual(['/workspace/a.js']);
  });

  it('passes cascade to delete-layer only when asked', async () => {
    const { calls, run } = recordingRunner([ok(''), ok('')]);
    const tiFs = createTiFs(run);
    await tiFs.deleteLayer({ layerRef: 'lyr_1' });
    await tiFs.deleteLayer({ layerRef: 'lyr_1', cascade: true });
    expect(calls[0]?.args).toEqual(['fs', 'delete-layer', '--layer-ref', 'lyr_1']);
    expect(calls[1]?.args).toEqual(['fs', 'delete-layer', '--layer-ref', 'lyr_1', '--cascade']);
  });

  it('appends a journal entry with an idempotency key', async () => {
    const { calls, run } = recordingRunner([ok('')]);
    await createTiFs(run).appendJournal({
      journalId: 'jrn-1',
      entry: { type: 'step.completed' },
      idempotencyKey: 'a1-step-01',
    });
    expect(calls[0]?.args).toEqual([
      'fs-journal',
      'append-journal-entries',
      '--journal-id',
      'jrn-1',
      '--entry-json',
      '{"type":"step.completed"}',
      '--idempotency-key',
      'a1-step-01',
    ]);
  });

  it('verifies a journal', async () => {
    const { run } = recordingRunner([ok('{"ok":true}')]);
    expect(await createTiFs(run).verifyJournal({ journalId: 'jrn-1' })).toEqual({ ok: true });
  });

  it('returns a trimmed vault grant token', async () => {
    const { calls, run } = recordingRunner([ok('tok_abc\n')]);
    const token = await createTiFs(run).createGrant({
      agentId: 'agent-1',
      scope: 'watchlist/API_KEY',
      permission: 'read',
      ttl: '10m',
    });
    expect(token).toBe('tok_abc');
    expect(calls[0]?.args).toContain('--token-only');
  });

  it('searches content inside a layer', async () => {
    const { calls, run } = recordingRunner([ok('/workspace/a.js:3:match')]);
    const text = await createTiFs(run).grep({ pattern: 'idempotency', layerId: 'lyr_2', limit: 5 });
    expect(text).toBe('/workspace/a.js:3:match');
    expect(calls[0]?.args).toEqual([
      'fs',
      'search-file-content',
      '--pattern',
      'idempotency',
      '--layer-id',
      'lyr_2',
      '--limit',
      '5',
    ]);
  });

  it('throws with the command name when the CLI exits nonzero', async () => {
    const { run } = recordingRunner([{ code: 1, stdout: '', stderr: 'unauthorized' }]);
    await expect(createTiFs(run).commitLayer({ layerId: 'lyr_1' })).rejects.toThrow(
      'ti fs commit-layer failed with exit code 1: unauthorized',
    );
  });
});
```

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/tifs.test.ts
```

Expected FAIL: `Cannot find module '../src/tifs'`.

`packages/agent-stack-kit/src/tifs.ts`:

```ts
import { runCli, stdoutOrThrow, type RunCli } from './cli';
import { parseCheckpoint, parseJournalVerify, parseLayerDiff, parseLayerId } from './parse';

export type TiFs = {
  readonly createLayer: (options: {
    readonly baseRootPath: string;
    readonly layerName: string;
    readonly actorId?: string;
    readonly tags?: Readonly<Record<string, string>>;
  }) => Promise<{ readonly layerId: string }>;
  readonly checkpoint: (options: {
    readonly layerId: string;
    readonly mountPath: string;
    readonly checkpointId: string;
    readonly label?: string;
    readonly drainTimeout?: string;
  }) => Promise<{ readonly checkpointId: string; readonly drainMs: number; readonly checkpointMs: number }>;
  readonly forkLayer: (options: {
    readonly parentLayerRef: string;
    readonly layerName: string;
    readonly checkpointId?: string;
    readonly actorId?: string;
  }) => Promise<{ readonly layerId: string }>;
  readonly mountLayer: (options: {
    readonly mountPath: string;
    readonly layerRef: string;
    readonly remotePath: string;
    readonly checkpointId?: string;
    readonly readOnly?: boolean;
  }) => Promise<void>;
  readonly unmount: (options: { readonly mountPath: string }) => Promise<void>;
  readonly diffLayer: (options: { readonly layerId: string }) => Promise<readonly string[]>;
  readonly commitLayer: (options: { readonly layerId: string }) => Promise<void>;
  readonly rollbackLayer: (options: { readonly layerId: string }) => Promise<void>;
  readonly deleteLayer: (options: { readonly layerRef: string; readonly cascade?: boolean }) => Promise<void>;
  readonly grep: (options: {
    readonly pattern: string;
    readonly path?: string;
    readonly layerId?: string;
    readonly limit?: number;
  }) => Promise<string>;
  readonly createJournal: (options: {
    readonly journalId: string;
    readonly journalKind?: string;
    readonly title?: string;
  }) => Promise<void>;
  readonly appendJournal: (options: {
    readonly journalId: string;
    readonly entry: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
  }) => Promise<void>;
  readonly verifyJournal: (options: { readonly journalId: string }) => Promise<{ readonly ok: boolean }>;
  readonly createGrant: (options: {
    readonly agentId: string;
    readonly scope: string;
    readonly permission: 'read' | 'write';
    readonly ttl: string;
  }) => Promise<string>;
};

const flag = (name: string, value: string | undefined): readonly string[] => (value === undefined ? [] : [name, value]);
const jsonOutput: readonly string[] = ['--output', 'json'];

export const createLayerArgs = (options: Parameters<TiFs['createLayer']>[0]): readonly string[] => [
  'fs',
  'create-layer',
  '--base-root-path',
  options.baseRootPath,
  '--layer-name',
  options.layerName,
  '--durability-mode',
  'restore-safe',
  ...flag('--actor-id', options.actorId),
  ...Object.entries(options.tags ?? {}).flatMap(([key, value]) => ['--tag', `${key}=${value}`]),
  ...jsonOutput,
];

export const drainArgs = (options: { readonly mountPath: string; readonly timeout?: string }): readonly string[] => [
  'fs',
  'drain-file-system',
  '--mount-path',
  options.mountPath,
  ...flag('--timeout', options.timeout),
];

export const checkpointArgs = (options: {
  readonly layerId: string;
  readonly checkpointId: string;
  readonly label?: string;
}): readonly string[] => [
  'fs',
  'create-layer-checkpoint',
  '--layer-id',
  options.layerId,
  '--checkpoint-id',
  options.checkpointId,
  ...flag('--label', options.label),
  ...jsonOutput,
];

export const forkLayerArgs = (options: Parameters<TiFs['forkLayer']>[0]): readonly string[] => [
  'fs',
  'fork-layer',
  '--parent-layer-ref',
  options.parentLayerRef,
  '--layer-name',
  options.layerName,
  ...flag('--checkpoint-id', options.checkpointId),
  ...flag('--actor-id', options.actorId),
  ...jsonOutput,
];

export const mountArgs = (options: Parameters<TiFs['mountLayer']>[0]): readonly string[] => [
  'fs',
  'mount-file-system',
  '--mount-path',
  options.mountPath,
  '--remote-path',
  options.remotePath,
  '--driver',
  'fuse',
  '--layer-ref',
  options.layerRef,
  ...flag('--checkpoint-id', options.checkpointId),
  ...(options.readOnly === true ? ['--read-only'] : []),
];

export const unmountArgs = (options: { readonly mountPath: string }): readonly string[] => [
  'fs',
  'unmount-file-system',
  '--mount-path',
  options.mountPath,
];

export const diffArgs = (options: { readonly layerId: string }): readonly string[] => [
  'fs',
  'diff-layer',
  '--layer-id',
  options.layerId,
  ...jsonOutput,
];

export const commitArgs = (options: { readonly layerId: string }): readonly string[] => [
  'fs',
  'commit-layer',
  '--layer-id',
  options.layerId,
];

export const rollbackArgs = (options: { readonly layerId: string }): readonly string[] => [
  'fs',
  'rollback-layer',
  '--layer-id',
  options.layerId,
];

export const deleteLayerArgs = (options: { readonly layerRef: string; readonly cascade?: boolean }): readonly string[] => [
  'fs',
  'delete-layer',
  '--layer-ref',
  options.layerRef,
  ...(options.cascade === true ? ['--cascade'] : []),
];

export const grepArgs = (options: Parameters<TiFs['grep']>[0]): readonly string[] => [
  'fs',
  'search-file-content',
  '--pattern',
  options.pattern,
  ...flag('--path', options.path),
  ...flag('--layer-id', options.layerId),
  ...(options.limit === undefined ? [] : ['--limit', String(options.limit)]),
];

export const createJournalArgs = (options: Parameters<TiFs['createJournal']>[0]): readonly string[] => [
  'fs-journal',
  'create-journal',
  '--journal-id',
  options.journalId,
  ...flag('--journal-kind', options.journalKind),
  ...flag('--title', options.title),
];

export const appendJournalArgs = (options: Parameters<TiFs['appendJournal']>[0]): readonly string[] => [
  'fs-journal',
  'append-journal-entries',
  '--journal-id',
  options.journalId,
  '--entry-json',
  JSON.stringify(options.entry),
  '--idempotency-key',
  options.idempotencyKey,
];

export const verifyJournalArgs = (options: { readonly journalId: string }): readonly string[] => [
  'fs-journal',
  'verify-journal',
  '--journal-id',
  options.journalId,
  ...jsonOutput,
];

export const grantArgs = (options: Parameters<TiFs['createGrant']>[0]): readonly string[] => [
  'fs-vault',
  'create-grant',
  '--agent-id',
  options.agentId,
  '--scope',
  options.scope,
  '--permission',
  options.permission,
  '--ttl',
  options.ttl,
  '--token-only',
];

export const createTiFs = (run: RunCli, clock: () => number = () => performance.now()): TiFs => {
  const exec = async (label: string, args: readonly string[]): Promise<string> =>
    stdoutOrThrow(await run({ bin: 'ti', args }), label);
  return {
    createLayer: async (options) => ({ layerId: parseLayerId(await exec('ti fs create-layer', createLayerArgs(options))) }),
    checkpoint: async (options) => {
      const drainStart = clock();
      await exec('ti fs drain-file-system', drainArgs({ mountPath: options.mountPath, timeout: options.drainTimeout }));
      const checkpointStart = clock();
      const stdout = await exec('ti fs create-layer-checkpoint', checkpointArgs(options));
      const finished = clock();
      return {
        checkpointId: parseCheckpoint(stdout).checkpointId,
        drainMs: checkpointStart - drainStart,
        checkpointMs: finished - checkpointStart,
      };
    },
    forkLayer: async (options) => ({ layerId: parseLayerId(await exec('ti fs fork-layer', forkLayerArgs(options))) }),
    mountLayer: async (options) => {
      await exec('ti fs mount-file-system', mountArgs(options));
    },
    unmount: async (options) => {
      await exec('ti fs unmount-file-system', unmountArgs(options));
    },
    diffLayer: async (options) => parseLayerDiff(await exec('ti fs diff-layer', diffArgs(options))),
    commitLayer: async (options) => {
      await exec('ti fs commit-layer', commitArgs(options));
    },
    rollbackLayer: async (options) => {
      await exec('ti fs rollback-layer', rollbackArgs(options));
    },
    deleteLayer: async (options) => {
      await exec('ti fs delete-layer', deleteLayerArgs(options));
    },
    grep: (options) => exec('ti fs search-file-content', grepArgs(options)),
    createJournal: async (options) => {
      await exec('ti fs-journal create-journal', createJournalArgs(options));
    },
    appendJournal: async (options) => {
      await exec('ti fs-journal append-journal-entries', appendJournalArgs(options));
    },
    verifyJournal: async (options) => parseJournalVerify(await exec('ti fs-journal verify-journal', verifyJournalArgs(options))),
    createGrant: async (options) => (await exec('ti fs-vault create-grant', grantArgs(options))).trim(),
  };
};

export const tiFs: TiFs = createTiFs(runCli);
```

The file system is selected by `TI_FS_FILE_SYSTEM_ID` in the environment the runner inherits, so no method takes a file system id.

Run the same command. Expected PASS: `Tests  11 passed (11)`.

Commit:

```bash
git add packages/agent-stack-kit/src/tifs.ts packages/agent-stack-kit/test/tifs.test.ts
git commit -m "agent-stack-kit: add tiFs adapter"
```

### Task 7: `branches` adapter

- [ ] Not started

Branches come from `ticloud serverless branch create` because it is the only documented command with a point-in-time parent. The wait is a pure decision function plus a polling loop with an injectable clock and sleep, so timeouts are tested without waiting.

`packages/agent-stack-kit/test/branches.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CliOptions, CliResult, RunCli } from '../src/cli';
import { branchWaitDecision, createBranchArgs, createBranches } from '../src/branches';

const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '' });

const scriptedRunner = (
  responses: readonly CliResult[],
): { readonly calls: readonly CliOptions[]; readonly run: RunCli } => {
  const calls: CliOptions[] = [];
  const queue = [...responses];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      return queue.shift() ?? ok('[]');
    },
  };
};

const listOf = (state: string): CliResult => ok(JSON.stringify([{ branchId: 'br_1', state }]));

describe('createBranchArgs', () => {
  it('builds a branch from the instance', () => {
    expect(createBranchArgs({ clusterId: 'c1', name: 'attempt-1' })).toEqual([
      'serverless',
      'branch',
      'create',
      '--cluster-id',
      'c1',
      '--display-name',
      'attempt-1',
      '--no-color',
    ]);
  });

  it('builds a point-in-time branch of another branch', () => {
    const args = createBranchArgs({
      clusterId: 'c1',
      name: 'replay',
      parentId: 'br_2',
      parentTimestamp: '2026-10-17T10:00:01Z',
    });
    expect(args).toContain('--parent-id');
    expect(args.slice(-3)).toEqual(['--parent-timestamp', '2026-10-17T10:00:01Z', '--no-color']);
  });

  it('rejects a parent timestamp that is not RFC3339', () => {
    expect(() => createBranchArgs({ clusterId: 'c1', name: 'x', parentTimestamp: '2026-10-17 10:00:01' })).toThrow(
      RangeError,
    );
  });
});

describe('branchWaitDecision', () => {
  it('is ready when ACTIVE regardless of case', () => {
    expect(branchWaitDecision({ state: 'active', elapsedMs: 0, timeoutMs: 10 })).toBe('ready');
  });

  it('fails on a terminal bad state', () => {
    expect(branchWaitDecision({ state: 'FAILED', elapsedMs: 0, timeoutMs: 10 })).toBe('failed');
  });

  it('waits while creating and times out afterwards', () => {
    expect(branchWaitDecision({ state: 'CREATING', elapsedMs: 5, timeoutMs: 10 })).toBe('wait');
    expect(branchWaitDecision({ state: 'CREATING', elapsedMs: 10, timeoutMs: 10 })).toBe('timeout');
    expect(branchWaitDecision({ state: undefined, elapsedMs: 11, timeoutMs: 10 })).toBe('timeout');
  });
});

describe('createBranches', () => {
  it('creates a branch and returns its id and state', async () => {
    const { calls, run } = scriptedRunner([ok('{"branchId":"br_1","state":"CREATING"}')]);
    const result = await createBranches(run).create({ clusterId: 'c1', name: 'attempt-1' });
    expect(result).toEqual({ branchId: 'br_1', state: 'CREATING' });
    expect(calls[0]?.bin).toBe('ticloud');
  });

  it('polls the list until the branch is ACTIVE', async () => {
    const { calls, run } = scriptedRunner([listOf('CREATING'), listOf('CREATING'), listOf('ACTIVE')]);
    const slept: number[] = [];
    const result = await createBranches(run, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).waitActive({ clusterId: 'c1', branchId: 'br_1', pollMs: 5 });
    expect(result.state).toBe('ACTIVE');
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([5, 5]);
  });

  it('throws when the branch fails', async () => {
    const { run } = scriptedRunner([listOf('FAILED')]);
    await expect(createBranches(run).waitActive({ clusterId: 'c1', branchId: 'br_1' })).rejects.toThrow(
      'branch br_1 entered state FAILED',
    );
  });

  it('throws when the timeout passes', async () => {
    const times = [0, 50, 100];
    const { run } = scriptedRunner([listOf('CREATING'), listOf('CREATING')]);
    await expect(
      createBranches(run, {
        clock: () => times.shift() ?? 100,
        sleep: async () => undefined,
      }).waitActive({ clusterId: 'c1', branchId: 'br_1', timeoutMs: 60, pollMs: 1 }),
    ).rejects.toThrow('not ACTIVE after 60ms');
  });

  it('deletes without a confirmation prompt', async () => {
    const { calls, run } = scriptedRunner([ok('')]);
    await createBranches(run).remove({ clusterId: 'c1', branchId: 'br_1' });
    expect(calls[0]?.args).toContain('--force');
  });
});
```

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/branches.test.ts
```

Expected FAIL: `Cannot find module '../src/branches'`.

`packages/agent-stack-kit/src/branches.ts`:

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { runCli, stdoutOrThrow, type RunCli } from './cli';
import { parseBranch, parseBranchList, type BranchInfo } from './parse';

export type Branches = {
  readonly create: (options: {
    readonly clusterId: string;
    readonly name: string;
    readonly parentId?: string;
    readonly parentTimestamp?: string;
  }) => Promise<{ readonly branchId: string; readonly state: string }>;
  readonly waitActive: (options: {
    readonly clusterId: string;
    readonly branchId: string;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
  }) => Promise<BranchInfo>;
  readonly remove: (options: { readonly clusterId: string; readonly branchId: string }) => Promise<void>;
  readonly list: (options: { readonly clusterId: string }) => Promise<readonly BranchInfo[]>;
};

export type BranchWaitDecision = 'ready' | 'wait' | 'failed' | 'timeout';

const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const flag = (name: string, value: string | undefined): readonly string[] => (value === undefined ? [] : [name, value]);

export const branchWaitDecision = (options: {
  readonly state: string | undefined;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}): BranchWaitDecision => {
  const state = options.state?.toUpperCase();
  if (state === 'ACTIVE') return 'ready';
  if (state === 'FAILED' || state === 'DELETED' || state === 'DELETING') return 'failed';
  return options.elapsedMs >= options.timeoutMs ? 'timeout' : 'wait';
};

export const createBranchArgs = (options: Parameters<Branches['create']>[0]): readonly string[] => {
  if (options.parentTimestamp !== undefined && !rfc3339Pattern.test(options.parentTimestamp)) {
    throw new RangeError(`parentTimestamp must be RFC3339, got: ${options.parentTimestamp}`);
  }
  return [
    'serverless',
    'branch',
    'create',
    '--cluster-id',
    options.clusterId,
    '--display-name',
    options.name,
    ...flag('--parent-id', options.parentId),
    ...flag('--parent-timestamp', options.parentTimestamp),
    '--no-color',
  ];
};

export const listBranchArgs = (options: { readonly clusterId: string }): readonly string[] => [
  'serverless',
  'branch',
  'list',
  options.clusterId,
  '-o',
  'json',
  '--no-color',
];

export const deleteBranchArgs = (options: { readonly clusterId: string; readonly branchId: string }): readonly string[] => [
  'serverless',
  'branch',
  'delete',
  '--cluster-id',
  options.clusterId,
  '--branch-id',
  options.branchId,
  '--force',
  '--no-color',
];

export const createBranches = (
  run: RunCli,
  options: { readonly clock?: () => number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Branches => {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const exec = async (label: string, args: readonly string[]): Promise<string> =>
    stdoutOrThrow(await run({ bin: 'ticloud', args }), label);
  const list: Branches['list'] = async (listOptions) =>
    parseBranchList(await exec('ticloud serverless branch list', listBranchArgs(listOptions)));
  const poll = async (
    waitOptions: Parameters<Branches['waitActive']>[0],
    startedAt: number,
  ): Promise<BranchInfo> => {
    const timeoutMs = waitOptions.timeoutMs ?? 900000;
    const found = (await list({ clusterId: waitOptions.clusterId })).find(
      (branch) => branch.branchId === waitOptions.branchId,
    );
    const decision = branchWaitDecision({ state: found?.state, elapsedMs: clock() - startedAt, timeoutMs });
    if (decision === 'ready' && found !== undefined) return found;
    if (decision === 'failed') throw new Error(`branch ${waitOptions.branchId} entered state ${found?.state}`);
    if (decision === 'timeout') {
      throw new Error(`branch ${waitOptions.branchId} not ACTIVE after ${timeoutMs}ms (state ${found?.state ?? 'missing'})`);
    }
    await sleep(waitOptions.pollMs ?? 10000);
    return poll(waitOptions, startedAt);
  };
  return {
    create: async (createOptions) =>
      parseBranch(await exec('ticloud serverless branch create', createBranchArgs(createOptions))),
    waitActive: (waitOptions) => poll(waitOptions, clock()),
    remove: async (removeOptions) => {
      await exec('ticloud serverless branch delete', deleteBranchArgs(removeOptions));
    },
    list,
  };
};

export const branches: Branches = createBranches(runCli);
```

Run the same command. Expected PASS: `Tests  11 passed (11)`.

Commit:

```bash
git add packages/agent-stack-kit/src/branches.ts packages/agent-stack-kit/test/branches.test.ts
git commit -m "agent-stack-kit: add branches adapter"
```

### Task 8: Lake configuration and client

- [ ] Not started

**The driver API is UNVERIFIED (U7)** and 12-V3 must have run first. The pure part (`lake-config.ts`) has tests; `lake-client.ts` is a thin adapter written against the documented shape, with its own file so the pure tests never import the driver. A failure to typecheck `lake-client.ts` means the real package differs from the documentation: fix only that file, using what 12-V3 pasted into section 4.

`packages/agent-stack-kit/test/lake-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isReadStatement, lakeConfigFromEnv, zipRecord } from '../src/lake-config';

const baseEnv = {
  LAKE_HOST: 'tenant.lake.example.com',
  LAKE_USER: 'lab',
  LAKE_PASSWORD: 'p@ss:word',
  LAKE_WAREHOUSE: 'agent-coding-wh',
  LAKE_DATABASE: 'agent_coding',
};

describe('lakeConfigFromEnv', () => {
  it('builds a DSN with encoded credentials and the warehouse parameter', () => {
    expect(lakeConfigFromEnv(baseEnv)).toEqual({
      dsn: 'lake://lab:p%40ss%3Aword@tenant.lake.example.com:443/agent_coding?warehouse=agent-coding-wh',
      warehouse: 'agent-coding-wh',
      database: 'agent_coding',
    });
  });

  it('honours an explicit port and defaults the database', () => {
    const config = lakeConfigFromEnv({ ...baseEnv, LAKE_PORT: '8443', LAKE_DATABASE: undefined });
    expect(config.dsn).toContain('@tenant.lake.example.com:8443/default?');
  });

  it('treats an empty database and port as unset', () => {
    const config = lakeConfigFromEnv({ ...baseEnv, LAKE_DATABASE: '', LAKE_PORT: '' });
    expect(config.dsn).toContain('@tenant.lake.example.com:443/default?');
  });

  it('names the missing variable', () => {
    expect(() => lakeConfigFromEnv({ ...baseEnv, LAKE_HOST: undefined })).toThrow('missing required env var: LAKE_HOST');
  });
});

describe('isReadStatement', () => {
  it('treats queries as reads', () => {
    expect(isReadStatement('  SELECT 1')).toBe(true);
    expect(isReadStatement('with x as (select 1) select * from x')).toBe(true);
    expect(isReadStatement('SHOW TASKS')).toBe(true);
  });

  it('treats DDL and DML as writes', () => {
    expect(isReadStatement('CREATE TABLE t (a INT)')).toBe(false);
    expect(isReadStatement('COPY INTO t FROM @s')).toBe(false);
    expect(isReadStatement('ALTER TASK x RESUME')).toBe(false);
  });
});

describe('zipRecord', () => {
  it('pairs column names with values', () => {
    expect(zipRecord(['a', 'b'], [1, 'x'])).toEqual({ a: 1, b: 'x' });
  });

  it('leaves a missing value undefined', () => {
    expect(zipRecord(['a', 'b'], [1])).toEqual({ a: 1, b: undefined });
  });
});
```

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/lake-config.test.ts
```

Expected FAIL: `Cannot find module '../src/lake-config'`.

`packages/agent-stack-kit/src/lake-config.ts`:

```ts
export type LakeConfig = {
  readonly dsn: string;
  readonly warehouse: string;
  readonly database: string;
};

export type LakeClient = {
  readonly query: (sql: string) => Promise<readonly Record<string, unknown>[]>;
};

type EnvLike = Readonly<Record<string, string | undefined>>;

const required = (env: EnvLike, name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const optional = (env: EnvLike, name: string, fallback: string): string => {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
};

export const lakeConfigFromEnv = (env: EnvLike): LakeConfig => {
  const host = required(env, 'LAKE_HOST');
  const user = required(env, 'LAKE_USER');
  const password = required(env, 'LAKE_PASSWORD');
  const warehouse = required(env, 'LAKE_WAREHOUSE');
  const database = optional(env, 'LAKE_DATABASE', 'default');
  const port = optional(env, 'LAKE_PORT', '443');
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return {
    dsn: `lake://${credentials}@${host}:${port}/${database}?warehouse=${encodeURIComponent(warehouse)}`,
    warehouse,
    database,
  };
};

export const isReadStatement = (sql: string): boolean => /^\s*(select|show|describe|desc|with|explain|list)\b/i.test(sql);

export const zipRecord = (names: readonly string[], values: readonly unknown[]): Record<string, unknown> =>
  Object.fromEntries(names.map((name, index) => [name, values[index]]));
```

`packages/agent-stack-kit/src/lake-client.ts`:

```ts
import { Client } from 'tidbcloudlake-driver';
import { isReadStatement, zipRecord, type LakeClient, type LakeConfig } from './lake-config';

export const createLakeClient = (config: LakeConfig): LakeClient => ({
  query: async (sql) => {
    const connection = await new Client(config.dsn).getConn();
    try {
      if (!isReadStatement(sql)) {
        await connection.exec(sql);
        return [];
      }
      const iterator = await connection.queryIter(sql);
      const names = iterator.schema().fields().map((field) => field.name);
      const rows: Record<string, unknown>[] = [];
      for await (const row of iterator) rows.push(zipRecord(names, row.values()));
      return rows;
    } finally {
      connection.close();
    }
  },
});
```

`createLakeClient` opens one connection per statement and closes it, so no long-lived socket outlives a warehouse suspend. Statements that do not start with `select`, `show`, `describe`, `desc`, `with`, `explain` or `list` go through `conn.exec` and return an empty list.

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/lake-config.test.ts
pnpm --filter @lab/agent-stack-kit typecheck
```

Expected PASS: `Tests  8 passed (8)`, then `tsc` exits 0.

Commit:

```bash
git add packages/agent-stack-kit/src/lake-config.ts packages/agent-stack-kit/src/lake-client.ts packages/agent-stack-kit/test/lake-config.test.ts
git commit -m "agent-stack-kit: add Lake config and client"
```

### Task 9: S3 event helpers and sink

- [ ] Not started

`packages/agent-stack-kit/test/s3-events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eventObjectKey, linesToBody, toNdjson } from '../src/s3-events';

describe('toNdjson', () => {
  it('writes one JSON object per line with a trailing newline', () => {
    expect(toNdjson([{ a: 1 }, { b: 'x' }])).toBe('{"a":1}\n{"b":"x"}\n');
  });

  it('writes nothing for no events', () => {
    expect(toNdjson([])).toBe('');
  });
});

describe('linesToBody', () => {
  it('joins lines and ends with a newline', () => {
    expect(linesToBody(['{"a":1}', '{"b":2}'])).toBe('{"a":1}\n{"b":2}\n');
  });
});

describe('eventObjectKey', () => {
  it('builds a sortable key under the prefix', () => {
    expect(eventObjectKey({ prefix: 'agent-coding/events', nowMs: Date.UTC(2026, 9, 17, 10, 0, 0, 250), id: 'abc' })).toBe(
      'agent-coding/events/2026-10-17T10-00-00-250Z-abc.ndjson',
    );
  });

  it('trims slashes from the prefix and supports an empty prefix', () => {
    expect(eventObjectKey({ prefix: '/p/', nowMs: 0, id: 'i' })).toBe('p/1970-01-01T00-00-00-000Z-i.ndjson');
    expect(eventObjectKey({ prefix: '', nowMs: 0, id: 'i' })).toBe('1970-01-01T00-00-00-000Z-i.ndjson');
  });
});
```

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/s3-events.test.ts
```

Expected FAIL: `Cannot find module '../src/s3-events'`.

`packages/agent-stack-kit/src/s3-events.ts`:

```ts
export const linesToBody = (lines: readonly string[]): string => `${lines.join('\n')}\n`;

export const toNdjson = (events: readonly object[]): string =>
  events.length === 0 ? '' : linesToBody(events.map((event) => JSON.stringify(event)));

export const eventObjectKey = (options: {
  readonly prefix: string;
  readonly nowMs: number;
  readonly id: string;
}): string => {
  const prefix = options.prefix.replace(/^\/+|\/+$/g, '');
  const stamp = new Date(options.nowMs).toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${options.id}.ndjson`;
  return prefix === '' ? name : `${prefix}/${name}`;
};
```

`packages/agent-stack-kit/src/s3-sink.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eventObjectKey, linesToBody } from './s3-events';

export type S3EventSink = {
  readonly write: (lines: readonly string[]) => Promise<{ readonly key: string }>;
};

export const createS3EventSink = (options: {
  readonly bucket: string;
  readonly prefix: string;
  readonly region: string;
}): S3EventSink => {
  const client = new S3Client({ region: options.region });
  return {
    write: async (lines) => {
      const key = eventObjectKey({ prefix: options.prefix, nowMs: Date.now(), id: randomUUID() });
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: linesToBody(lines),
          ContentType: 'application/x-ndjson',
        }),
      );
      return { key };
    },
  };
};
```

The sink writes one NDJSON object per call under a sortable key. Credentials come from the default AWS chain and the region from the `region` option; the relay loads `.env` into the runner's environment, and `.env` holds `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/s3-events.test.ts
pnpm --filter @lab/agent-stack-kit typecheck
```

Expected PASS: `Tests  5 passed (5)`, then `tsc` exits 0.

Commit:

```bash
git add packages/agent-stack-kit/src/s3-events.ts packages/agent-stack-kit/src/s3-sink.ts packages/agent-stack-kit/test/s3-events.test.ts
git commit -m "agent-stack-kit: add S3 event helpers and sink"
```

### Task 10: The kit's public surface

- [ ] Not started

Plan 13 imports from `@lab/agent-stack-kit`, so the barrel is pinned by a test: exactly these runtime names, exactly these `tiFs` and `branches` methods.

`packages/agent-stack-kit/test/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as kit from '../src/index';

describe('@lab/agent-stack-kit public surface', () => {
  it('exports exactly the documented runtime names', () => {
    expect(Object.keys(kit).sort()).toEqual([
      'branches',
      'createLakeClient',
      'createS3EventSink',
      'lakeConfigFromEnv',
      'parseBranch',
      'parseCheckpoint',
      'parseJournalVerify',
      'parseLayerDiff',
      'parseLayerId',
      'rfc3339Second',
      'runCli',
      'tiFs',
      'toNdjson',
    ]);
  });

  it('exposes every tiFs method Plan 13 relies on', () => {
    expect(Object.keys(kit.tiFs).sort()).toEqual([
      'appendJournal',
      'checkpoint',
      'commitLayer',
      'createGrant',
      'createJournal',
      'createLayer',
      'deleteLayer',
      'diffLayer',
      'forkLayer',
      'grep',
      'mountLayer',
      'rollbackLayer',
      'unmount',
      'verifyJournal',
    ]);
  });

  it('exposes every branches method Plan 13 relies on', () => {
    expect(Object.keys(kit.branches).sort()).toEqual(['create', 'list', 'remove', 'waitActive']);
  });
});
```

Run:

```bash
pnpm --filter @lab/agent-stack-kit exec vitest run test/index.test.ts
```

Expected FAIL: `Cannot find module '../src/index'`.

`packages/agent-stack-kit/src/index.ts`:

```ts
export { runCli } from './cli';
export type { CliOptions, CliResult, RunCli } from './cli';
export { parseBranch, parseCheckpoint, parseJournalVerify, parseLayerDiff, parseLayerId } from './parse';
export type { BranchInfo, ParsedBranch } from './parse';
export { tiFs } from './tifs';
export type { TiFs } from './tifs';
export { branches } from './branches';
export type { Branches } from './branches';
export { lakeConfigFromEnv } from './lake-config';
export type { LakeClient, LakeConfig } from './lake-config';
export { createLakeClient } from './lake-client';
export { createS3EventSink } from './s3-sink';
export type { S3EventSink } from './s3-sink';
export { toNdjson } from './s3-events';
export { rfc3339Second } from './time';
```

Run the whole package:

```bash
pnpm --filter @lab/agent-stack-kit test
pnpm --filter @lab/agent-stack-kit typecheck
```

Expected PASS: `Test Files  8 passed (8)` and `Tests  72 passed (72)`, then `tsc` exits 0.

Commit:

```bash
git add packages/agent-stack-kit/src/index.ts packages/agent-stack-kit/test/index.test.ts
git commit -m "agent-stack-kit: add public surface"
```

### Task 11: Scaffold the demo package

- [ ] Not started

Create the package skeleton (nothing to fail or pass yet). `vitest.config.ts` matters: Vitest's default include pattern would otherwise pick up the fixture repo's own `test/charge.test.js`, which is meant to fail until an attempt patches the code.

`demos/agent-coding/package.json`:

```json
{
  "name": "@lab/demo-agent-coding",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc -p tsconfig.json",
    "teardown": "node --import tsx runner/teardown.ts",
    "seed-fixture": "node --import tsx runner/seed-fixture.ts"
  },
  "dependencies": {
    "@lab/agent-stack-kit": "workspace:*",
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
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

`demos/agent-coding/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["runner", "test"]
}
```

`demos/agent-coding/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['runner/test/**/*.test.ts', 'test/**/*.test.ts'] },
});
```

`demos/agent-coding/.env.example`:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=
LAB_ENV_COMPONENT_TI_CLI=
LAB_ENV_COMPONENT_TICLOUD_CLI=
LAB_ENV_COMPONENT_FILESYSTEM=TiDB Cloud Filesystem (public preview), aws-us-east-1
LAB_ENV_COMPONENT_LAKE=TiDB Cloud Lake (preview), XSmall warehouse
LAB_ENV_COMPONENT_LAKE_DRIVER=
LAB_ENV_COMPONENT_FUSE=
LAB_ENV_COMPONENT_NODE=
TI_FS_FILE_SYSTEM_ID=
AGENT_ORG_CLUSTER_ID=
AGENT_FIXTURE_CLUSTER_ID=
FIXTURE_DATABASE=fixture
FIXTURE_HOST=
FIXTURE_PORT=4000
FIXTURE_ADMIN_USER=
FIXTURE_ADMIN_PASSWORD=
FIXTURE_SQL_USER=
FIXTURE_SQL_PASSWORD=
BRANCH_QUOTA=5
BRANCH_TIMEOUT_MS=900000
BRANCH_POLL_MS=10000
STEP_WAIT_MS=1000
AUTO_RUN=false
STAGE_PAUSE_MS=3000
LAKE_HOST=
LAKE_USER=
LAKE_PASSWORD=
LAKE_PORT=443
LAKE_WAREHOUSE=agent-coding-wh
LAKE_DATABASE=agent_coding
LAKE_FRESHNESS_TIMEOUT_MS=240000
LAKE_EXECUTE_TASK=false
EXPORT_TIMEOUT_MS=300000
HISTORY_RUNS=200
HISTORY_SEED=42
S3_BUCKET=
S3_REGION=us-east-1
S3_PREFIX=agent-coding
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
WORK_DIR=
```

Run:

```bash
mkdir -p demos/agent-coding/runner/src/stages demos/agent-coding/runner/test demos/agent-coding/test demos/agent-coding/traces demos/agent-coding/fixtures
pnpm install
ls demos/agent-coding/node_modules/@lab
```

Expected: `pnpm install` links `@lab/agent-stack-kit`, `@lab/contract` and `@lab/runner-kit` into the demo package and the second command lists `agent-stack-kit`, `contract` and `runner-kit`.

Commit:

```bash
git add demos/agent-coding/package.json demos/agent-coding/tsconfig.json demos/agent-coding/vitest.config.ts demos/agent-coding/.env.example pnpm-lock.yaml
git commit -m "agent-coding demo: scaffold package"
```

### Task 12: Manifest

- [ ] Not started

Write the failing test first.

`demos/agent-coding/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('agent-coding demo manifest', () => {
  it('parses against DemoManifestSchema', () => {
    expect(DemoManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('is demo number 12 with id agent-coding', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.id).toBe('agent-coding');
    expect(result.number).toBe(12);
  });

  it('names every node referenced by an edge', () => {
    const result = DemoManifestSchema.parse(manifest);
    const nodeIds = new Set(result.nodes.map((node) => node.id));
    result.edges.forEach((edge) => {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    });
  });

  it('gives every metric a howMeasured explanation', () => {
    const result = DemoManifestSchema.parse(manifest);
    result.metrics.forEach((metric) => {
      expect(metric.howMeasured.length).toBeGreaterThan(20);
    });
  });

  it('lists the nine phases in run order', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.phases.map((phase) => phase.id)).toEqual([
      'setup',
      'intake-memory-recall',
      'seed-checkpoint',
      'fan-out',
      'work-loop',
      'winner-pr',
      'replay-failed-step',
      'lake-eval',
      'write-lesson',
    ]);
  });

  it('offers the five controls', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.controls.map((control) => control.id)).toEqual([
      'fan-out',
      'inject-flaky-dependency',
      'replay-failed-step',
      'run-eval',
      'write-lesson',
    ]);
  });

  it('publishes to the hosted site', () => {
    expect(DemoManifestSchema.parse(manifest).publish).toBe(true);
  });

  it('runs the runner through node --import tsx runner/main.ts', () => {
    expect(DemoManifestSchema.parse(manifest).runner.command).toEqual(['node', '--import', 'tsx', 'runner/main.ts']);
  });

  it('says modeled where a metric uses synthetic history', () => {
    const result = DemoManifestSchema.parse(manifest);
    const evalMetric = result.metrics.find((metric) => metric.id === 'eval-query-ms');
    expect(evalMetric?.howMeasured).toContain('modeled');
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run test/manifest.test.ts
```

Expected FAIL: `Cannot find module '../manifest.json'` (file does not exist yet).

Minimal implementation. The flow diagram's nodes, edges, phases, metrics, checks and controls are exactly the ones in section 2 and section 3; every metric's `howMeasured` is the precise measurement.

`demos/agent-coding/manifest.json`:

```json
{
  "id": "agent-coding",
  "number": 12,
  "title": "TiDB Cloud agent stack: coding-agent platform (Filesystem + TiDB X + Lake)",
  "tagline": "Three scripted agent attempts, each with its own copy-on-write workspace and database branch, replayed from a checkpoint and judged in a lake.",
  "integrations": ["TiDB Cloud Filesystem", "TiDB Cloud Starter", "TiDB Cloud Lake", "Amazon S3"],
  "pattern": "Teams building a coding-agent platform that need an isolated workspace and database per attempt, replayable failures, durable org memory and an analytical store for eval.",
  "publish": true,
  "runner": {
    "command": ["node", "--import", "tsx", "runner/main.ts"],
    "cwd": "."
  },
  "nodes": [
    { "id": "fixture-repo", "label": "Fixture repo (payments-api)", "kind": "source", "x": 6, "y": 14 },
    { "id": "harness", "label": "Scripted agent harness", "kind": "client", "x": 6, "y": 55 },
    { "id": "filesystem", "label": "Filesystem: base, task layer, attempt layers", "kind": "tidb", "x": 38, "y": 12 },
    { "id": "fixture-db", "label": "Starter fixture instance + attempt branches", "kind": "tidb", "x": 40, "y": 38 },
    { "id": "org-memory", "label": "Starter org memory (hybrid search)", "kind": "tidb", "x": 40, "y": 62 },
    { "id": "ledger", "label": "Starter step ledger", "kind": "tidb", "x": 40, "y": 86 },
    { "id": "s3-events", "label": "S3 events and ledger export", "kind": "sink", "x": 68, "y": 78 },
    { "id": "lake", "label": "TiDB Cloud Lake", "kind": "tidb", "x": 86, "y": 52 },
    { "id": "eval", "label": "Eval queries", "kind": "service", "x": 88, "y": 18 }
  ],
  "edges": [
    { "id": "seed-repo", "from": "fixture-repo", "to": "filesystem", "label": "repo files seeded", "unit": "files" },
    { "id": "layer-io", "from": "harness", "to": "filesystem", "label": "fork, drain, checkpoint", "unit": "ops" },
    { "id": "branch-reads", "from": "harness", "to": "fixture-db", "label": "branch clock and checksum reads", "unit": "queries" },
    { "id": "recall", "from": "harness", "to": "org-memory", "label": "hybrid memory recall", "unit": "memories" },
    { "id": "step-ledger", "from": "harness", "to": "ledger", "label": "step records", "unit": "rows" },
    { "id": "events-out", "from": "harness", "to": "s3-events", "label": "run events as NDJSON", "unit": "events" },
    { "id": "ledger-export", "from": "ledger", "to": "s3-events", "label": "ledger export as Parquet", "unit": "rows" },
    { "id": "lake-load", "from": "s3-events", "to": "lake", "label": "COPY INTO from stage", "unit": "rows" },
    { "id": "eval-queries", "from": "lake", "to": "eval", "label": "eval queries", "unit": "queries" },
    { "id": "lesson-write", "from": "eval", "to": "org-memory", "label": "lesson written back", "unit": "rows" }
  ],
  "metrics": [
    { "id": "fork-layer-ms", "label": "Layer Fork Latency", "unit": "ms", "display": "both", "better": "lower", "group": "filesystem", "howMeasured": "Wall-clock milliseconds from timed() around one `ti fs fork-layer` CLI call (process start to exit, so it includes the CLI's network round trip). One sample per fork: three attempt forks from the seed checkpoint and one replay fork from a step checkpoint." },
    { "id": "checkpoint-ms", "label": "Drain plus Checkpoint Latency", "unit": "ms", "display": "both", "better": "lower", "group": "filesystem", "howMeasured": "Milliseconds for `ti fs drain-file-system` plus `ti fs create-layer-checkpoint`, each timed with performance.now() inside tiFs.checkpoint and summed. One sample per checkpoint: the seed checkpoint and one per attempt step." },
    { "id": "branch-create-s", "label": "Branch Create to ACTIVE", "unit": "s", "display": "tile", "better": "lower", "group": "branches", "howMeasured": "Seconds from the runner calling `ticloud serverless branch create` to the first `ticloud serverless branch list -o json` poll that reports that branch ACTIVE. Resolution is the poll interval BRANCH_POLL_MS. One sample per branch: three attempt branches and one replay branch. The vendor documents completion in a few minutes, so expect minutes, not milliseconds." },
    { "id": "hybrid-search-ms", "label": "Hybrid Recall Latency", "unit": "ms", "display": "both", "better": "lower", "group": "memory", "howMeasured": "timed() around the single reciprocal-rank-fusion query (VEC_EMBED_COSINE_DISTANCE vector list plus fts_match_word list, constant 60, top 3) on the org Starter instance. Sampled once at intake and on every poll of the lesson recall." },
    { "id": "lake-freshness-s", "label": "Lake Freshness Lag", "unit": "s", "display": "both", "better": "lower", "group": "lake", "howMeasured": "Seconds from the runner writing a marker NDJSON object to S3 until a poll (every 3 s) of SELECT COUNT(*) for that marker id in Lake first returns 1. It includes the Lake task schedule (one minute by default), so it is bounded below by the schedule rather than by S3 or the network." },
    { "id": "lake-rows-per-min", "label": "Lake Rows Loaded per Minute", "unit": "count", "display": "both", "better": "higher", "group": "lake", "howMeasured": "Live run events visible in Lake (SELECT COUNT(*) FROM run_events WHERE run_id = this run AND source = 'live') divided by the minutes elapsed since the first event object of the run was written to S3. Synthetic history rows are excluded." },
    { "id": "events-emitted", "label": "Run Events Emitted", "unit": "count", "display": "tile", "better": "neutral", "group": "lake", "howMeasured": "Cumulative count of NDJSON event lines the runner wrote to S3 for this run: one per attempt step, one per attempt finish and one freshness marker." },
    { "id": "lake-events-visible", "label": "Run Events Visible in Lake", "unit": "count", "display": "both", "better": "higher", "group": "lake", "howMeasured": "Result of SELECT COUNT(*) FROM run_events WHERE run_id = this run AND source = 'live' in Lake, polled every 3 s until it equals events-emitted or LAKE_FRESHNESS_TIMEOUT_MS passes." },
    { "id": "eval-query-ms", "label": "Lake Eval Query Latency", "unit": "ms", "display": "tile", "better": "lower", "group": "lake", "howMeasured": "timed() around each of the three eval queries (MATCH on ECONNRESET, merged attempts per dollar by model, COSINE_DISTANCE failure similarity) through the Node driver. Each query opens a new connection, so connection setup is included. Merged per dollar uses synthetic history and fixture model labels, so that result is modeled, not measured." }
  ],
  "phases": [
    { "id": "setup", "label": "Setup", "narration": "Three branches of a read-only fixture database start copying now. Branches take minutes, so we ask for them first and overlap everything else." },
    { "id": "intake-memory-recall", "label": "Intake memory recall", "narration": "Ticket KIT-8812 arrives: fix the double charge on retried payments. Before touching code the agent asks org memory one question that mixes meaning and exact words." },
    { "id": "seed-checkpoint", "label": "Seed checkpoint", "narration": "The fixture repo lands in a task layer and we checkpoint it as seed. Every attempt starts from exactly this state." },
    { "id": "fan-out", "label": "Fan out 3 attempts", "narration": "Three attempts fan out. Each gets a copy-on-write layer forked from seed and its own database branch. Nothing is copied by hand and all three databases start identical." },
    { "id": "work-loop", "label": "Work loop", "narration": "Every step is drained, checkpointed, stamped with the branch's own clock and written to the ledger, one second apart so each step lands on a distinct second." },
    { "id": "winner-pr", "label": "Winner PR", "narration": "The attempt whose tests pass with the smallest change wins and pushes a git branch. Its layer is never committed to the base." },
    { "id": "replay-failed-step", "label": "Replay the failed step", "narration": "Attempt 2 failed at step 7. We fork a layer from its step-07 checkpoint, branch its database at that step's timestamp and rerun the step. Same failing tests." },
    { "id": "lake-eval", "label": "Lake eval", "narration": "Run events and the ledger land in Lake through S3. Now we can search failures, price merged work per model and find failures like this one." },
    { "id": "write-lesson", "label": "Write the lesson", "narration": "The lesson goes back into org memory. The next ticket that mentions a retry loop recalls it in the first three results." }
  ],
  "checks": [
    { "id": "layer-isolation", "label": "Layer isolation", "description": "Every file that only one attempt wrote appears in that attempt's layer diff and in no other attempt's layer diff." },
    { "id": "fork-branches-identical", "label": "Fork branches identical", "description": "The three attempt branches return the same row count and the same row checksum before any step runs." },
    { "id": "replay-reproduces", "label": "Replay reproduces the failure", "description": "The replayed step fails the same tests with the same signature, and the replay layer tree and replay branch checksum equal the ledger record of that step." },
    { "id": "journal-verified", "label": "Journal verifies", "description": "ti fs-journal verify-journal reports the run journal's hash chain intact." },
    { "id": "lake-count-matches", "label": "Lake count matches emitted events", "description": "After the load lag, the count of this run's live events in Lake equals the number of event lines the runner wrote to S3." },
    { "id": "lesson-recalled", "label": "Lesson recalled", "description": "A hybrid search for a new retry-loop task returns the freshly written lesson in its top three results." }
  ],
  "controls": [
    { "id": "fan-out", "label": "Fan out", "description": "Forks three attempt layers, waits for the attempt branches, runs the work loop and opens the winner's pull request." },
    { "id": "inject-flaky-dependency", "label": "Inject flaky dependency", "description": "Before the fan-out: makes attempt 1 hit a gateway connection reset at its first verification so a different attempt wins." },
    { "id": "replay-failed-step", "label": "Replay failed step", "description": "Forks a layer from the failed step's checkpoint, branches the database at that step's timestamp and reruns the step." },
    { "id": "run-eval", "label": "Run eval", "description": "Exports the ledger, waits for events to appear in Lake and runs the three eval queries." },
    { "id": "write-lesson", "label": "Write lesson", "description": "Writes the lesson to org memory and checks that hybrid recall returns it." }
  ]
}
```

Run the same command. Expected PASS: `Tests  9 passed (9)`.

Commit:

```bash
git add demos/agent-coding/manifest.json demos/agent-coding/test/manifest.test.ts
git commit -m "agent-coding demo: add manifest"
```

### Task 13: Fixture repo, attempt scripts and the script schema

- [ ] Not started

The agent is a deterministic script, so its "candidate patches" are plain files. The fixture repo is a tiny payments service whose retried request records a second charge; two of its four tests fail until a patch lands. Three attempts patch it differently:

- attempt 1 adds an idempotency helper and uses it (two files changed, seven steps): the correct, smallest fix;
- attempt 2 inlines the lookup, then wraps the gateway call in a retry loop; its step 7 runs the suite against a gateway fault (`GATEWAY_FAULT=econnreset`), so it fails there by design;
- attempt 3 also passes but touches four files in nine steps, so it loses on score.

A script step is one of `read`, `baseline` (run the suite, failures expected), `write` (copy a patch file into the repo) or `verify` (run the suite, a failure halts the attempt). Write the failing test first.

`demos/agent-coding/runner/test/scripts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadAttemptScripts } from '../src/fixtureStore';
import { parseAttemptScript, pathOwners, writtenPaths } from '../src/scripts';

const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));

describe('parseAttemptScript', () => {
  it('rejects steps that are out of order', () => {
    expect(() =>
      parseAttemptScript({
        attemptId: 'attempt-9',
        model: 'fixture-model-a',
        stepCostUsd: 0.01,
        steps: [
          { step: 1, kind: 'read', note: 'a' },
          { step: 3, kind: 'read', note: 'b' },
        ],
      }),
    ).toThrow('step 3 is out of order');
  });

  it('rejects an unknown step kind', () => {
    expect(() =>
      parseAttemptScript({
        attemptId: 'attempt-9',
        model: 'm',
        stepCostUsd: 0,
        steps: [{ step: 1, kind: 'think', note: 'a' }],
      }),
    ).toThrow();
  });
});

describe('fixture attempt scripts', () => {
  it('loads three attempts in order', async () => {
    const scripts = await loadAttemptScripts(fixturesDir);
    expect(scripts.map((script) => script.attemptId)).toEqual(['attempt-1', 'attempt-2', 'attempt-3']);
  });

  it('has an attempt that fails at step 7', async () => {
    const scripts = await loadAttemptScripts(fixturesDir);
    const second = scripts.find((script) => script.attemptId === 'attempt-2');
    expect(second?.steps).toHaveLength(7);
    expect(second?.steps[6]).toMatchObject({ kind: 'verify', fault: 'econnreset' });
  });

  it('lists the files each attempt writes', async () => {
    const scripts = await loadAttemptScripts(fixturesDir);
    expect(scripts.map(writtenPaths)).toEqual([
      ['src/idempotency.js', 'src/charge.js'],
      ['src/charge.js', 'src/gateway.js'],
      ['src/ledger.js', 'src/retry.js', 'src/charge.js', 'README.md'],
    ]);
  });

  it('finds the files that only one attempt writes', async () => {
    const scripts = await loadAttemptScripts(fixturesDir);
    expect(pathOwners(scripts)).toEqual({
      'src/idempotency.js': 'attempt-1',
      'src/gateway.js': 'attempt-2',
      'src/ledger.js': 'attempt-3',
      'src/retry.js': 'attempt-3',
      'README.md': 'attempt-3',
    });
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/scripts.test.ts
```

Expected FAIL: `Cannot find module '../src/fixtureStore'`.

The fixture repo (plain ES modules, tests with `node:test`, no dependencies):

`demos/agent-coding/fixtures/payments-api/package.json`:

```json
{
  "name": "payments-api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/charge.test.js"
  }
}
```

`demos/agent-coding/fixtures/payments-api/README.md`:

```markdown
# payments-api

A tiny payments service used as a fixture. A charge request carries an idempotency key. Retrying a request with the same key must not record a second charge.
```

`demos/agent-coding/fixtures/payments-api/src/gateway.js`:

```js
export function authorize(amountCents) {
  if (process.env.GATEWAY_FAULT === 'econnreset') {
    const error = new Error('connect ECONNRESET 10.0.0.7:443');
    error.code = 'ECONNRESET';
    throw error;
  }
  return { authorized: true, amountCents };
}
```

`demos/agent-coding/fixtures/payments-api/src/ledger.js`:

```js
export function createLedger() {
  return { charges: [] };
}

export function record(ledger, charge) {
  ledger.charges.push(charge);
  return charge;
}
```

`demos/agent-coding/fixtures/payments-api/src/charge.js`:

```js
import { authorize } from './gateway.js';
import { record } from './ledger.js';

export function processCharge(ledger, request) {
  authorize(request.amountCents);
  const id = `ch_${ledger.charges.length + 1}`;
  return record(ledger, {
    id,
    idempotencyKey: request.idempotencyKey,
    amountCents: request.amountCents,
  });
}
```

`demos/agent-coding/fixtures/payments-api/test/charge.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../src/ledger.js';
import { processCharge } from '../src/charge.js';

const request = { idempotencyKey: 'order-1001', amountCents: 2500 };

test('records one charge for a first request', () => {
  const ledger = createLedger();
  const charge = processCharge(ledger, request);
  assert.equal(ledger.charges.length, 1);
  assert.equal(charge.amountCents, 2500);
});

test('a retried request with the same idempotency key records one charge', () => {
  const ledger = createLedger();
  processCharge(ledger, request);
  processCharge(ledger, request);
  assert.equal(ledger.charges.length, 1);
});

test('a retried request returns the original charge id', () => {
  const ledger = createLedger();
  const first = processCharge(ledger, request);
  const second = processCharge(ledger, request);
  assert.equal(second.id, first.id);
});

test('different idempotency keys record separate charges', () => {
  const ledger = createLedger();
  processCharge(ledger, { idempotencyKey: 'order-1', amountCents: 100 });
  processCharge(ledger, { idempotencyKey: 'order-2', amountCents: 200 });
  assert.equal(ledger.charges.length, 2);
});
```

Attempt 1 (the correct, smallest patch):

`demos/agent-coding/fixtures/attempts/attempt-1.json`:

```json
{
  "attemptId": "attempt-1",
  "model": "fixture-model-a",
  "stepCostUsd": 0.05,
  "steps": [
    { "step": 1, "kind": "read", "note": "Read src/charge.js and the failing test" },
    { "step": 2, "kind": "baseline", "note": "Run the suite and capture the failing tests" },
    { "step": 3, "kind": "write", "path": "src/idempotency.js", "from": "attempt-1/idempotency.js", "note": "Add a helper that finds an existing charge by idempotency key" },
    { "step": 4, "kind": "write", "path": "src/charge.js", "from": "attempt-1/charge.js", "note": "Return the existing charge when a request is retried" },
    { "step": 5, "kind": "verify", "note": "Run the suite" },
    { "step": 6, "kind": "read", "note": "Review the change before opening a pull request" },
    { "step": 7, "kind": "verify", "note": "Final full run of the suite" }
  ]
}
```

`demos/agent-coding/fixtures/attempts/attempt-1/idempotency.js`:

```js
export function findExisting(ledger, idempotencyKey) {
  return ledger.charges.find((charge) => charge.idempotencyKey === idempotencyKey);
}
```

`demos/agent-coding/fixtures/attempts/attempt-1/charge.js`:

```js
import { authorize } from './gateway.js';
import { record } from './ledger.js';
import { findExisting } from './idempotency.js';

export function processCharge(ledger, request) {
  const existing = findExisting(ledger, request.idempotencyKey);
  if (existing) return existing;
  authorize(request.amountCents);
  const id = `ch_${ledger.charges.length + 1}`;
  return record(ledger, {
    id,
    idempotencyKey: request.idempotencyKey,
    amountCents: request.amountCents,
  });
}
```

Attempt 2 (retry loop, fails at step 7 with the gateway fault):

`demos/agent-coding/fixtures/attempts/attempt-2.json`:

```json
{
  "attemptId": "attempt-2",
  "model": "fixture-model-b",
  "stepCostUsd": 0.03,
  "steps": [
    { "step": 1, "kind": "read", "note": "Read src/charge.js and the failing test" },
    { "step": 2, "kind": "baseline", "note": "Run the suite and capture the failing tests" },
    { "step": 3, "kind": "write", "path": "src/charge.js", "from": "attempt-2/charge.js", "note": "Look up an existing charge inline" },
    { "step": 4, "kind": "write", "path": "src/gateway.js", "from": "attempt-2/gateway.js", "note": "Add a retrying gateway call" },
    { "step": 5, "kind": "verify", "note": "Run the suite" },
    { "step": 6, "kind": "write", "path": "src/charge.js", "from": "attempt-2/charge-with-retry.js", "note": "Use the retrying gateway call" },
    { "step": 7, "kind": "verify", "fault": "econnreset", "note": "Run the suite against the retrying gateway call" }
  ]
}
```

`demos/agent-coding/fixtures/attempts/attempt-2/charge.js`:

```js
import { authorize } from './gateway.js';
import { record } from './ledger.js';

export function processCharge(ledger, request) {
  const existing = ledger.charges.find((charge) => charge.idempotencyKey === request.idempotencyKey);
  if (existing) return existing;
  authorize(request.amountCents);
  const id = `ch_${ledger.charges.length + 1}`;
  return record(ledger, {
    id,
    idempotencyKey: request.idempotencyKey,
    amountCents: request.amountCents,
  });
}
```

`demos/agent-coding/fixtures/attempts/attempt-2/gateway.js`:

```js
export function authorize(amountCents) {
  if (process.env.GATEWAY_FAULT === 'econnreset') {
    const error = new Error('connect ECONNRESET 10.0.0.7:443');
    error.code = 'ECONNRESET';
    throw error;
  }
  return { authorized: true, amountCents };
}

export function authorizeWithRetry(amountCents, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return authorize(amountCents);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
```

`demos/agent-coding/fixtures/attempts/attempt-2/charge-with-retry.js`:

```js
import { authorizeWithRetry } from './gateway.js';
import { record } from './ledger.js';

export function processCharge(ledger, request) {
  const existing = ledger.charges.find((charge) => charge.idempotencyKey === request.idempotencyKey);
  if (existing) return existing;
  authorizeWithRetry(request.amountCents);
  const id = `ch_${ledger.charges.length + 1}`;
  return record(ledger, {
    id,
    idempotencyKey: request.idempotencyKey,
    amountCents: request.amountCents,
  });
}
```

Attempt 3 (passes, but four files):

`demos/agent-coding/fixtures/attempts/attempt-3.json`:

```json
{
  "attemptId": "attempt-3",
  "model": "fixture-model-a",
  "stepCostUsd": 0.05,
  "steps": [
    { "step": 1, "kind": "read", "note": "Read src/charge.js and the failing test" },
    { "step": 2, "kind": "baseline", "note": "Run the suite and capture the failing tests" },
    { "step": 3, "kind": "write", "path": "src/ledger.js", "from": "attempt-3/ledger.js", "note": "Add findByKey to the ledger" },
    { "step": 4, "kind": "write", "path": "src/retry.js", "from": "attempt-3/retry.js", "note": "Add a generic retry helper" },
    { "step": 5, "kind": "write", "path": "src/charge.js", "from": "attempt-3/charge.js", "note": "Use findByKey and retry the gateway call" },
    { "step": 6, "kind": "write", "path": "README.md", "from": "attempt-3/README.md", "note": "Document the idempotency behaviour" },
    { "step": 7, "kind": "verify", "note": "Run the suite" },
    { "step": 8, "kind": "read", "note": "Review the change before opening a pull request" },
    { "step": 9, "kind": "verify", "note": "Final full run of the suite" }
  ]
}
```

`demos/agent-coding/fixtures/attempts/attempt-3/ledger.js`:

```js
export function createLedger() {
  return { charges: [] };
}

export function record(ledger, charge) {
  ledger.charges.push(charge);
  return charge;
}

export function findByKey(ledger, idempotencyKey) {
  return ledger.charges.find((charge) => charge.idempotencyKey === idempotencyKey);
}
```

`demos/agent-coding/fixtures/attempts/attempt-3/retry.js`:

```js
export function withRetry(task, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return task();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
```

`demos/agent-coding/fixtures/attempts/attempt-3/charge.js`:

```js
import { authorize } from './gateway.js';
import { record, findByKey } from './ledger.js';
import { withRetry } from './retry.js';

export function processCharge(ledger, request) {
  const existing = findByKey(ledger, request.idempotencyKey);
  if (existing) return existing;
  withRetry(() => authorize(request.amountCents));
  const id = `ch_${ledger.charges.length + 1}`;
  return record(ledger, {
    id,
    idempotencyKey: request.idempotencyKey,
    amountCents: request.amountCents,
  });
}
```

`demos/agent-coding/fixtures/attempts/attempt-3/README.md`:

```markdown
# payments-api

A tiny payments service used as a fixture. A charge request carries an idempotency key. Retrying a request with the same key must not record a second charge.

## Idempotency

The ledger exposes `findByKey`. `processCharge` returns the stored charge when the key was already recorded, and the gateway call is retried up to three times.
```

The schema and loader (`zod` validates every script; steps must be numbered in order; `pathOwners` finds the files only one attempt writes, which the layer-isolation check uses):

`demos/agent-coding/runner/src/scripts.ts`:

```ts
import { z } from 'zod';

const Fault = z.literal('econnreset');
const common = { step: z.number().int().min(1), note: z.string().min(1) };

export const ScriptStepSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('read') }),
  z.object({ ...common, kind: z.literal('baseline'), fault: Fault.optional() }),
  z.object({ ...common, kind: z.literal('write'), path: z.string().min(1), from: z.string().min(1) }),
  z.object({ ...common, kind: z.literal('verify'), fault: Fault.optional() }),
]);

export const AttemptScriptSchema = z
  .object({
    attemptId: z.string().regex(/^attempt-[0-9]+$/),
    model: z.string().min(1),
    stepCostUsd: z.number().nonnegative(),
    steps: z.array(ScriptStepSchema).min(1),
  })
  .superRefine((script, ctx) => {
    script.steps
      .filter((step, index) => step.step !== index + 1)
      .forEach((step) => ctx.addIssue({ code: 'custom', message: `step ${step.step} is out of order` }));
  });

export type ScriptStep = z.infer<typeof ScriptStepSchema>;
export type AttemptScript = z.infer<typeof AttemptScriptSchema>;

export const parseAttemptScript = (value: unknown): AttemptScript => AttemptScriptSchema.parse(value);

export const writtenPaths = (script: AttemptScript): readonly string[] => [
  ...new Set(script.steps.flatMap((step) => (step.kind === 'write' ? [step.path] : []))),
];

export const pathOwners = (scripts: readonly AttemptScript[]): Readonly<Record<string, string>> => {
  const writers = scripts.flatMap((script) =>
    writtenPaths(script).map((path) => ({ path, attemptId: script.attemptId })),
  );
  const owned = [...new Set(writers.map((writer) => writer.path))].flatMap((path) => {
    const owners = writers.filter((writer) => writer.path === path);
    const only = owners[0];
    return owners.length === 1 && only !== undefined ? [only] : [];
  });
  return Object.fromEntries(owned.map((owner) => [owner.path, owner.attemptId]));
};
```

`demos/agent-coding/runner/src/fixtureStore.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAttemptScript, type AttemptScript } from './scripts';

export const loadAttemptScripts = async (fixturesDir: string): Promise<readonly AttemptScript[]> => {
  const directory = join(fixturesDir, 'attempts');
  const names = (await readdir(directory)).filter((name) => /^attempt-[0-9]+\.json$/.test(name)).sort();
  return Promise.all(
    names.map(async (name) => parseAttemptScript(JSON.parse(await readFile(join(directory, name), 'utf8')))),
  );
};
```

Run the fixture's own suite by hand to see the planted bug:

```bash
cd demos/agent-coding/fixtures/payments-api
node --test --test-reporter=tap test/charge.test.js
cd ../../../..
```

Expected: exit code 1 and a TAP summary ending `# tests 4`, `# pass 2`, `# fail 2`, with `not ok 2 - a retried request with the same idempotency key records one charge` and `not ok 3 - a retried request returns the original charge id`. Then the harness environment variable:

```bash
GATEWAY_FAULT=econnreset node --test --test-reporter=tap demos/agent-coding/fixtures/payments-api/test/charge.test.js
```

Expected: all four tests `not ok`, each with `code: 'ECONNRESET'`.

Run the schema test:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/scripts.test.ts
```

Expected PASS: `Tests  6 passed (6)`.

Commit:

```bash
git add demos/agent-coding/fixtures demos/agent-coding/runner/src/scripts.ts demos/agent-coding/runner/src/fixtureStore.ts demos/agent-coding/runner/test/scripts.test.ts
git commit -m "agent-coding demo: add fixture repo, attempt scripts and schema"
```

### Task 14: TAP parsing, scoring and the tree hash

- [ ] Not started

`parseTap` turns `node --test --test-reporter=tap` output into the failing test names (sorted) and a failure signature. `scoreAttempt` is `100 - 10 x changed files - steps` for an attempt that passed and `0` otherwise; this is a formula over measured values, and the demo labels it "formula, modeled". `pickWinner` takes the best passing attempt, ties broken by attempt id; `pickReplayTarget` takes the halted attempt that got furthest. `treeHash` is a content hash of a file tree, used to prove a replay layer equals the checkpoint it came from.

`demos/agent-coding/runner/test/tap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { failureSignature, parseTap } from '../src/tap';

const baselineOutput = [
  'TAP version 13',
  'ok 1 - records one charge for a first request',
  'not ok 2 - a retried request with the same idempotency key records one charge',
  '  code: \'ERR_ASSERTION\'',
  'not ok 3 - a retried request returns the original charge id',
  'ok 4 - different idempotency keys record separate charges',
  '1..4',
].join('\n');

describe('parseTap', () => {
  it('lists failing test names alphabetically and counts passing tests', () => {
    expect(parseTap(baselineOutput)).toEqual({
      failing: [
        'a retried request returns the original charge id',
        'a retried request with the same idempotency key records one charge',
      ],
      passing: 2,
      signature: 'AssertionError',
    });
  });

  it('reports no failures for a clean run', () => {
    expect(parseTap('ok 1 - a\nok 2 - b\n')).toEqual({ failing: [], passing: 2, signature: undefined });
  });
});

describe('failureSignature', () => {
  it('prefers the gateway reset signature', () => {
    expect(failureSignature("not ok 1 - a\n  error: 'connect ECONNRESET 10.0.0.7:443'\n  code: 'ECONNRESET'")).toBe(
      'ECONNRESET',
    );
  });

  it('falls back to an unknown failure', () => {
    expect(failureSignature('not ok 1 - a')).toBe('UnknownFailure');
  });
});
```

`demos/agent-coding/runner/test/score.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pickReplayTarget, pickWinner, scoreAttempt } from '../src/score';

describe('scoreAttempt', () => {
  it('rewards small, short attempts that pass', () => {
    expect(scoreAttempt({ passed: true, changedFiles: 2, steps: 7 })).toBe(73);
    expect(scoreAttempt({ passed: true, changedFiles: 4, steps: 9 })).toBe(51);
  });

  it('scores a failed attempt zero', () => {
    expect(scoreAttempt({ passed: false, changedFiles: 1, steps: 3 })).toBe(0);
  });

  it('never goes below zero', () => {
    expect(scoreAttempt({ passed: true, changedFiles: 20, steps: 40 })).toBe(0);
  });
});

describe('pickWinner', () => {
  const results = [
    { attemptId: 'attempt-1', passed: true, changedFiles: 2, steps: 7 },
    { attemptId: 'attempt-2', passed: false, changedFiles: 2, steps: 7 },
    { attemptId: 'attempt-3', passed: true, changedFiles: 4, steps: 9 },
  ];

  it('picks the highest scoring attempt that passed', () => {
    expect(pickWinner(results)?.attemptId).toBe('attempt-1');
  });

  it('lets a lower scoring attempt win when the better one failed', () => {
    const failedFirst = results.map((result) => (result.attemptId === 'attempt-1' ? { ...result, passed: false } : result));
    expect(pickWinner(failedFirst)?.attemptId).toBe('attempt-3');
  });

  it('breaks ties by attempt id', () => {
    expect(
      pickWinner([
        { attemptId: 'attempt-2', passed: true, changedFiles: 1, steps: 1 },
        { attemptId: 'attempt-1', passed: true, changedFiles: 1, steps: 1 },
      ])?.attemptId,
    ).toBe('attempt-1');
  });

  it('returns nothing when no attempt passed', () => {
    expect(pickWinner(results.map((result) => ({ ...result, passed: false })))).toBeUndefined();
  });
});

describe('pickReplayTarget', () => {
  it('chooses the attempt that got furthest before it halted', () => {
    expect(
      pickReplayTarget([
        { attemptId: 'attempt-1', haltedAtStep: 5 },
        { attemptId: 'attempt-2', haltedAtStep: 7 },
      ]),
    ).toEqual({ attemptId: 'attempt-2', haltedAtStep: 7 });
  });

  it('returns nothing when no attempt halted', () => {
    expect(pickReplayTarget([])).toBeUndefined();
  });
});
```

`demos/agent-coding/runner/test/tree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { changedPaths, stripPrefix, treeHash } from '../src/tree';

describe('treeHash', () => {
  it('does not depend on key order', () => {
    expect(treeHash({ a: '1', b: '2' })).toBe(treeHash({ b: '2', a: '1' }));
  });

  it('changes when content changes', () => {
    expect(treeHash({ a: '1' })).not.toBe(treeHash({ a: '2' }));
  });

  it('distinguishes a path split from a content shift', () => {
    expect(treeHash({ ab: 'c' })).not.toBe(treeHash({ a: 'bc' }));
  });
});

describe('changedPaths', () => {
  it('lists modified, added and removed files', () => {
    expect(changedPaths({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' })).toEqual(['b', 'c', 'd']);
  });

  it('is empty for identical trees', () => {
    expect(changedPaths({ a: '1' }, { a: '1' })).toEqual([]);
  });
});

describe('stripPrefix', () => {
  it('removes a directory prefix', () => {
    expect(stripPrefix('/workspace/payments-api/src/a.js', '/workspace/payments-api')).toBe('src/a.js');
  });

  it('leaves other paths alone', () => {
    expect(stripPrefix('/other/a.js', '/workspace')).toBe('/other/a.js');
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/tap.test.ts runner/test/score.test.ts runner/test/tree.test.ts
```

Expected FAIL: `Cannot find module '../src/tap'` (and the same for `score` and `tree`).

`demos/agent-coding/runner/src/tap.ts`:

```ts
export type TapSummary = {
  readonly failing: readonly string[];
  readonly passing: number;
  readonly signature: string | undefined;
};

const failingLine = /^not ok \d+ - (.+)$/;
const passingLine = /^ok \d+ - /;

export const failureSignature = (stdout: string): string | undefined => {
  if (stdout.includes('ECONNRESET')) return 'ECONNRESET';
  if (stdout.includes('ERR_ASSERTION')) return 'AssertionError';
  return stdout.includes('not ok') ? 'UnknownFailure' : undefined;
};

export const parseTap = (stdout: string): TapSummary => {
  const lines = stdout.split('\n');
  return {
    failing: lines
      .map((line) => failingLine.exec(line)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort(),
    passing: lines.filter((line) => passingLine.test(line)).length,
    signature: failureSignature(stdout),
  };
};
```

`demos/agent-coding/runner/src/score.ts`:

```ts
export type AttemptResult = {
  readonly attemptId: string;
  readonly passed: boolean;
  readonly changedFiles: number;
  readonly steps: number;
};

export const scoreAttempt = (result: Omit<AttemptResult, 'attemptId'>): number =>
  result.passed ? Math.max(0, 100 - 10 * result.changedFiles - result.steps) : 0;

export const pickWinner = (results: readonly AttemptResult[]): AttemptResult | undefined =>
  results
    .filter((result) => result.passed)
    .reduce<AttemptResult | undefined>((best, result) => {
      if (best === undefined) return result;
      const gap = scoreAttempt(result) - scoreAttempt(best);
      if (gap > 0) return result;
      if (gap < 0) return best;
      return result.attemptId < best.attemptId ? result : best;
    }, undefined);

export const pickReplayTarget = (
  halted: readonly { readonly attemptId: string; readonly haltedAtStep: number }[],
): { readonly attemptId: string; readonly haltedAtStep: number } | undefined =>
  halted.reduce<{ readonly attemptId: string; readonly haltedAtStep: number } | undefined>((best, item) => {
    if (best === undefined) return item;
    if (item.haltedAtStep > best.haltedAtStep) return item;
    if (item.haltedAtStep < best.haltedAtStep) return best;
    return item.attemptId < best.attemptId ? item : best;
  }, undefined);
```

`demos/agent-coding/runner/src/tree.ts`:

```ts
import { createHash } from 'node:crypto';

export type Tree = Readonly<Record<string, string>>;

export const treeHash = (tree: Tree): string => {
  const hash = createHash('sha256');
  Object.keys(tree)
    .sort()
    .forEach((path) => {
      hash.update(`${path}\0${tree[path] ?? ''}\0`);
    });
  return hash.digest('hex');
};

export const changedPaths = (base: Tree, current: Tree): readonly string[] =>
  [...new Set([...Object.keys(base), ...Object.keys(current)])].filter((path) => base[path] !== current[path]).sort();

export const stripPrefix = (path: string, prefix: string): string => {
  const normalised = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(normalised) ? path.slice(normalised.length) : path;
};
```

Run the same command. Expected PASS: `Test Files  3 passed (3)` and `Tests  20 passed (20)`.
Commit:

```bash
git add demos/agent-coding/runner/src/tap.ts demos/agent-coding/runner/src/score.ts demos/agent-coding/runner/src/tree.ts demos/agent-coding/runner/test/tap.test.ts demos/agent-coding/runner/test/score.test.ts demos/agent-coding/runner/test/tree.test.ts
git commit -m "agent-coding demo: add TAP parsing, scoring and tree hash"
```

### Task 15: The harness, tested end to end on local files

- [ ] Not started

The harness is the part of the demo that is real and local: it copies a patch file into a repo directory, runs the fixture's tests with `node --test`, and halts an attempt at a failing `verify` step. Its test plays all three scripted attempts against temp copies of the fixture repo, so the planted behaviour (attempt 2 halts at step 7, attempt 1 wins, an injected fault takes attempt 1 down at its first verification) is proven before any cloud service is involved. The test takes a couple of seconds because it really runs `node --test`.

`demos/agent-coding/runner/test/harness.test.ts`:

```ts
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAttemptScripts } from '../src/fixtureStore';
import { readTree, runAttempt, runTests, type StepOutcome } from '../src/harness';
import { pickWinner, scoreAttempt } from '../src/score';
import { changedPaths } from '../src/tree';

const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));
const baselineDir = join(fixturesDir, 'payments-api');

const withRepo = async <T>(task: (repoDir: string) => Promise<T>): Promise<T> => {
  const repoDir = await mkdtemp(join(tmpdir(), 'agent-coding-test-'));
  try {
    await cp(baselineDir, repoDir, { recursive: true });
    return await task(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
};

const scriptFor = async (attemptId: string) => {
  const script = (await loadAttemptScripts(fixturesDir)).find((candidate) => candidate.attemptId === attemptId);
  if (script === undefined) throw new Error(`no script for ${attemptId}`);
  return script;
};

const play = async (attemptId: string, injectedFault = false) => {
  const script = await scriptFor(attemptId);
  const baseline = await readTree(baselineDir);
  return withRepo(async (repoDir) => {
    const seen: StepOutcome[] = [];
    const outcomes = await runAttempt(script, { repoDir, fixturesDir, injectedFault }, async (outcome) => {
      seen.push(outcome);
    });
    const changed = changedPaths(baseline, await readTree(repoDir));
    return { outcomes, seen, changed };
  });
};

describe('the fixture repo', () => {
  it('fails exactly the two idempotency tests before any patch', async () => {
    await withRepo(async (repoDir) => {
      const result = await runTests({ repoDir, fault: undefined });
      expect(result.passed).toBe(false);
      expect(result.failing).toEqual([
        'a retried request returns the original charge id',
        'a retried request with the same idempotency key records one charge',
      ]);
      expect(result.passing).toBe(2);
    });
  });

  it('fails every test when the gateway resets the connection', async () => {
    await withRepo(async (repoDir) => {
      const result = await runTests({ repoDir, fault: 'econnreset' });
      expect(result.failing).toHaveLength(4);
      expect(result.signature).toBe('ECONNRESET');
    });
  });
});

describe('the scripted attempts', () => {
  it('attempt 1 passes in seven steps and changes two files', async () => {
    const { outcomes, changed } = await play('attempt-1');
    expect(outcomes).toHaveLength(7);
    expect(outcomes.at(-1)?.test?.passed).toBe(true);
    expect(changed).toEqual(['src/charge.js', 'src/idempotency.js']);
  });

  it('attempt 2 halts at step 7 with a gateway reset', async () => {
    const { outcomes, seen } = await play('attempt-2');
    const last = outcomes.at(-1);
    expect(last).toMatchObject({ step: 7, halted: true });
    expect(last?.test?.signature).toBe('ECONNRESET');
    expect(last?.test?.failing).toHaveLength(4);
    expect(seen).toHaveLength(7);
  });

  it('attempt 2 passes its step 5 verification before it breaks', async () => {
    const { outcomes } = await play('attempt-2');
    expect(outcomes[4]?.test?.passed).toBe(true);
  });

  it('attempt 3 passes in nine steps and changes four files', async () => {
    const { outcomes, changed } = await play('attempt-3');
    expect(outcomes).toHaveLength(9);
    expect(outcomes.at(-1)?.test?.passed).toBe(true);
    expect(changed).toEqual(['README.md', 'src/charge.js', 'src/ledger.js', 'src/retry.js']);
  });

  it('an injected fault halts attempt 1 at its first verification', async () => {
    const { outcomes } = await play('attempt-1', true);
    expect(outcomes.at(-1)).toMatchObject({ step: 5, halted: true });
  });

  it('attempt 1 wins on score and attempt 3 loses', async () => {
    const results = await Promise.all(
      ['attempt-1', 'attempt-2', 'attempt-3'].map(async (attemptId) => {
        const { outcomes, changed } = await play(attemptId);
        return {
          attemptId,
          passed: outcomes.at(-1)?.halted === false && outcomes.at(-1)?.test?.passed === true,
          changedFiles: changed.length,
          steps: outcomes.length,
        };
      }),
    );
    expect(results.map(scoreAttempt.bind(null))).toEqual([73, 0, 51]);
    expect(pickWinner(results)?.attemptId).toBe('attempt-1');
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/harness.test.ts
```

Expected FAIL: `Cannot find module '../src/harness'`.

`demos/agent-coding/runner/src/harness.ts`:

```ts
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCli, type RunCli } from '@lab/agent-stack-kit';
import type { AttemptScript, ScriptStep } from './scripts';
import { parseTap } from './tap';
import type { Tree } from './tree';

export type TestResult = {
  readonly passed: boolean;
  readonly failing: readonly string[];
  readonly passing: number;
  readonly signature: string | undefined;
};

export type StepOutcome = {
  readonly step: number;
  readonly kind: ScriptStep['kind'];
  readonly note: string;
  readonly wrote?: string;
  readonly test?: TestResult;
  readonly halted: boolean;
};

export type StepContext = {
  readonly repoDir: string;
  readonly fixturesDir: string;
  readonly run?: RunCli;
  readonly injectedFault?: boolean;
};

export const runTests = async (options: {
  readonly repoDir: string;
  readonly fault: 'econnreset' | undefined;
  readonly run?: RunCli;
}): Promise<TestResult> => {
  const run = options.run ?? runCli;
  const result = await run({
    bin: process.execPath,
    args: ['--test', '--test-reporter=tap', join(options.repoDir, 'test', 'charge.test.js')],
    env: { GATEWAY_FAULT: options.fault ?? '' },
  });
  const summary = parseTap(result.stdout);
  return {
    passed: result.code === 0 && summary.failing.length === 0,
    failing: summary.failing,
    passing: summary.passing,
    signature: summary.signature,
  };
};

const isFirstVerify = (script: AttemptScript, step: ScriptStep): boolean =>
  script.steps.find((candidate) => candidate.kind === 'verify')?.step === step.step;

const faultFor = (script: AttemptScript, step: ScriptStep, injectedFault: boolean): 'econnreset' | undefined => {
  if (step.kind !== 'baseline' && step.kind !== 'verify') return undefined;
  if (step.fault !== undefined) return step.fault;
  return injectedFault && step.kind === 'verify' && isFirstVerify(script, step) ? 'econnreset' : undefined;
};

export const runStep = async (script: AttemptScript, step: ScriptStep, context: StepContext): Promise<StepOutcome> => {
  const base = { step: step.step, kind: step.kind, note: step.note };
  if (step.kind === 'read') return { ...base, halted: false };
  if (step.kind === 'write') {
    const target = join(context.repoDir, step.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(context.fixturesDir, 'attempts', step.from), target);
    return { ...base, wrote: step.path, halted: false };
  }
  const test = await runTests({
    repoDir: context.repoDir,
    fault: faultFor(script, step, context.injectedFault === true),
    run: context.run,
  });
  return { ...base, test, halted: step.kind === 'verify' && !test.passed };
};

export const runAttempt = async (
  script: AttemptScript,
  context: StepContext,
  afterStep: (outcome: StepOutcome) => Promise<void>,
): Promise<readonly StepOutcome[]> => {
  const walk = async (remaining: readonly ScriptStep[], done: readonly StepOutcome[]): Promise<readonly StepOutcome[]> => {
    const [next, ...rest] = remaining;
    if (next === undefined) return done;
    const outcome = await runStep(script, next, context);
    await afterStep(outcome);
    const finished = [...done, outcome];
    return outcome.halted ? finished : walk(rest, finished);
  };
  return walk(script.steps, []);
};

export const readTree = async (dir: string, prefix = ''): Promise<Tree> => {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const parts = await Promise.all(
    entries
      .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
      .map(async (entry): Promise<Tree> => {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) return readTree(dir, relative);
        return { [relative]: await readFile(join(dir, relative), 'utf8') };
      }),
  );
  return parts.reduce<Tree>((merged, part) => ({ ...merged, ...part }), {});
};
```

`runAttempt` calls `afterStep` after every step, including the step that halts the attempt. In the live run that callback does the drain, checkpoint, branch clock read, ledger write and one second wait; in this test it does nothing.

Run the same command. Expected PASS: `Tests  8 passed (8)`.

Commit:

```bash
git add demos/agent-coding/runner/src/harness.ts demos/agent-coding/runner/test/harness.test.ts
git commit -m "agent-coding demo: add the scripted harness"
```

### Task 16: Fixture rows, the branch snapshot query and the hashed embedding

- [ ] Not started

`generateOrders` makes the fixture instance's `orders` rows from a seed (the instance is read-only to the demo, so every branch starts identical). `buildSnapshotSql` reads, from a branch, the branch's own clock (`UTC_TIMESTAMP(3)`, formatted as ISO text so no time zone setting matters), the row count and an order-independent row checksum (`BIT_XOR` of `CRC32` over every column that defines a row). `hashEmbedding` is a deterministic hashed bag-of-words vector, used only so Lake can compare failure messages with `COSINE_DISTANCE`; it is labeled as a hashed embedding, not a model.

`demos/agent-coding/runner/test/fixtureData.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chunk, fixtureStatements, generateOrders, insertOrdersSql, orderRowsAsParams } from '../src/fixtureData';

describe('generateOrders', () => {
  it('is deterministic for a seed', () => {
    expect(generateOrders({ seed: 7, count: 50 })).toEqual(generateOrders({ seed: 7, count: 50 }));
  });

  it('differs between seeds', () => {
    expect(generateOrders({ seed: 7, count: 50 })).not.toEqual(generateOrders({ seed: 8, count: 50 }));
  });

  it('numbers rows from one and keeps amounts positive', () => {
    const rows = generateOrders({ seed: 1, count: 20 });
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(rows.every((row) => row.amountCents >= 500)).toBe(true);
  });
});

describe('chunk', () => {
  it('splits into batches with a short last batch', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('orderRowsAsParams', () => {
  it('flattens rows into column order', () => {
    expect(orderRowsAsParams([{ id: 1, customer: 'c', amountCents: 5, status: 'paid' }])).toEqual([[1, 'c', 5, 'paid']]);
  });
});

describe('fixtureStatements', () => {
  it('creates the database and the orders table with quoted identifiers', () => {
    expect(fixtureStatements('fixture')).toEqual([
      'CREATE DATABASE IF NOT EXISTS `fixture`',
      'CREATE TABLE IF NOT EXISTS `fixture`.orders (id INT PRIMARY KEY, customer VARCHAR(40) NOT NULL, amount_cents INT NOT NULL, status VARCHAR(16) NOT NULL)',
    ]);
  });
});

describe('insertOrdersSql', () => {
  it('writes one placeholder tuple per row and ignores rows that already exist', () => {
    expect(insertOrdersSql('fixture', 2)).toBe(
      'INSERT IGNORE INTO `fixture`.orders (id, customer, amount_cents, status) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    );
  });
});
```

`demos/agent-coding/runner/test/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSnapshotSql, normalizeDbTime, parseSnapshotRow } from '../src/snapshot';

describe('normalizeDbTime', () => {
  it('trims microseconds to milliseconds', () => {
    expect(normalizeDbTime('2026-10-17T10:00:00.250000Z')).toBe('2026-10-17T10:00:00.250Z');
  });

  it('pads a short fraction', () => {
    expect(normalizeDbTime('2026-10-17T10:00:00.5Z')).toBe('2026-10-17T10:00:00.500Z');
  });

  it('adds a zero fraction when none is present', () => {
    expect(normalizeDbTime('2026-10-17T10:00:00Z')).toBe('2026-10-17T10:00:00.000Z');
  });

  it('rejects other formats', () => {
    expect(() => normalizeDbTime('2026-10-17 10:00:00')).toThrow('unexpected db_time format');
  });
});

describe('buildSnapshotSql', () => {
  it('quotes the database and checksums every column that defines a row', () => {
    const sql = buildSnapshotSql('fixture');
    expect(sql).toContain('FROM `fixture`.orders');
    expect(sql).toContain("CRC32(CONCAT_WS('|', id, customer, amount_cents, status))");
    expect(sql).toContain('UTC_TIMESTAMP(3)');
  });

  it('escapes a hostile database name', () => {
    expect(buildSnapshotSql('a`b')).toContain('FROM `a``b`.orders');
  });
});

describe('parseSnapshotRow', () => {
  it('normalises a database row', () => {
    expect(
      parseSnapshotRow({ db_time: '2026-10-17T10:00:00.250000Z', row_count: '2000', checksum: '1234567890' }),
    ).toEqual({ dbTime: '2026-10-17T10:00:00.250Z', rowCount: 2000, checksum: '1234567890' });
  });

  it('rejects a row count that is not an integer', () => {
    expect(() => parseSnapshotRow({ db_time: '2026-10-17T10:00:00Z', row_count: 'x', checksum: '1' })).toThrow(
      'unexpected row_count',
    );
  });
});
```

`demos/agent-coding/runner/test/embedding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashEmbedding, vectorLiteral } from '../src/embedding';

const cosine = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

describe('hashEmbedding', () => {
  it('returns a unit vector of the requested size', () => {
    const vector = hashEmbedding('connect ECONNRESET gateway', 64);
    expect(vector).toHaveLength(64);
    expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 4);
  });

  it('is deterministic', () => {
    expect(hashEmbedding('same text')).toEqual(hashEmbedding('same text'));
  });

  it('places similar failures closer than unrelated text', () => {
    const query = hashEmbedding('connect ECONNRESET gateway retry');
    const near = hashEmbedding('gateway ECONNRESET on retry');
    const far = hashEmbedding('assertion expected 1 actual 2 in ledger');
    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far));
  });

  it('returns zeros for text with no tokens', () => {
    expect(hashEmbedding('---', 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('vectorLiteral', () => {
  it('renders a bracketed list', () => {
    expect(vectorLiteral([0.5, 0, 1])).toBe('[0.5,0,1]');
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/fixtureData.test.ts runner/test/snapshot.test.ts runner/test/embedding.test.ts
```

Expected FAIL: `Cannot find module '../src/fixtureData'` (and the same for `snapshot` and `embedding`).

`demos/agent-coding/runner/src/random.ts`:

```ts
export const mulberry32 = (seed: number): (() => number) => {
  const state = { value: seed >>> 0 };
  return () => {
    state.value = (state.value + 0x6d2b79f5) >>> 0;
    const mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value);
    const scrambled = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((scrambled ^ (scrambled >>> 14)) >>> 0) / 4294967296;
  };
};
```

`demos/agent-coding/runner/src/fixtureData.ts`:

```ts
import { quoteIdentifier } from '@lab/runner-kit';
import { mulberry32 } from './random';

export type OrderRow = {
  readonly id: number;
  readonly customer: string;
  readonly amountCents: number;
  readonly status: string;
};

const statuses: readonly string[] = ['paid', 'paid', 'paid', 'refunded', 'pending'];

export const generateOrders = (options: { readonly seed: number; readonly count: number }): readonly OrderRow[] => {
  const next = mulberry32(options.seed);
  return Array.from({ length: options.count }, (_, index) => ({
    id: index + 1,
    customer: `cust-${String(Math.floor(next() * 400)).padStart(4, '0')}`,
    amountCents: 500 + Math.floor(next() * 50000),
    status: statuses[Math.floor(next() * statuses.length)] ?? 'paid',
  }));
};

export const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export const orderRowsAsParams = (rows: readonly OrderRow[]): readonly (readonly (string | number)[])[] =>
  rows.map((row) => [row.id, row.customer, row.amountCents, row.status]);

export const fixtureStatements = (database: string): readonly string[] => [
  `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)}`,
  `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(database)}.orders (id INT PRIMARY KEY, customer VARCHAR(40) NOT NULL, amount_cents INT NOT NULL, status VARCHAR(16) NOT NULL)`,
];

export const insertOrdersSql = (database: string, rowCount: number): string =>
  `INSERT IGNORE INTO ${quoteIdentifier(database)}.orders (id, customer, amount_cents, status) VALUES ${Array.from({ length: rowCount }, () => '(?, ?, ?, ?)').join(', ')}`;
```

`demos/agent-coding/runner/src/snapshot.ts`:

```ts
import { quoteIdentifier } from '@lab/runner-kit';

export type BranchSnapshot = {
  readonly dbTime: string;
  readonly rowCount: number;
  readonly checksum: string;
};

export const normalizeDbTime = (raw: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(raw);
  if (match === null) throw new Error(`unexpected db_time format: ${raw}`);
  const fraction = (match[2] ?? '').padEnd(3, '0').slice(0, 3);
  return `${match[1]}.${fraction}Z`;
};

export const buildSnapshotSql = (database: string): string =>
  `SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS db_time, COUNT(*) AS row_count, CAST(BIT_XOR(CRC32(CONCAT_WS('|', id, customer, amount_cents, status))) AS CHAR) AS checksum FROM ${quoteIdentifier(database)}.orders`;

export const parseSnapshotRow = (row: Readonly<Record<string, unknown>>): BranchSnapshot => {
  const rowCount = Number(row.row_count);
  if (!Number.isInteger(rowCount)) throw new Error(`unexpected row_count: ${String(row.row_count)}`);
  return {
    dbTime: normalizeDbTime(String(row.db_time)),
    rowCount,
    checksum: String(row.checksum),
  };
};
```

`demos/agent-coding/runner/src/embedding.ts`:

```ts
const fnv1a = (text: string): number =>
  [...text].reduce((hash, char) => Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0, 2166136261);

export const hashEmbedding = (text: string, dimensions = 64): readonly number[] => {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slots = tokens.map((token) => fnv1a(token) % dimensions);
  const counts = Array.from({ length: dimensions }, (_, slot) => slots.filter((candidate) => candidate === slot).length);
  const norm = Math.sqrt(counts.reduce((sum, count) => sum + count * count, 0));
  if (norm === 0) return counts;
  return counts.map((count) => Math.round((count / norm) * 1e6) / 1e6);
};

export const vectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`;
```

Run the same command. Expected PASS: `Test Files  3 passed (3)` and `Tests  21 passed (21)`.
Commit:

```bash
git add demos/agent-coding/runner/src/random.ts demos/agent-coding/runner/src/fixtureData.ts demos/agent-coding/runner/src/snapshot.ts demos/agent-coding/runner/src/embedding.ts demos/agent-coding/runner/test/fixtureData.test.ts demos/agent-coding/runner/test/snapshot.test.ts demos/agent-coding/runner/test/embedding.test.ts
git commit -m "agent-coding demo: add fixture rows, branch snapshot and embedding"
```

### Task 17: Starter SQL: memories, ledger and the hybrid search

- [ ] Not started

12-V5 must have confirmed that this account's Starter instance accepts the memories table and answers the hybrid statement (U10). The statement is the documented reciprocal-rank-fusion query with the query text bound once per placeholder; the runner sends it with `pool.query` (client-side escaping), not a prepared statement, because the embedding function takes the text as an argument.

`demos/agent-coding/runner/test/starterSql.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHybridSearch, createLedgerSql, createMemoriesSql, parseMemoryHits, seedMemories } from '../src/starterSql';

describe('createMemoriesSql', () => {
  it('declares auto-embedding, a full-text index and a vector index', () => {
    expect(createMemoriesSql).toContain('EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", content)');
    expect(createMemoriesSql).toContain('FULLTEXT INDEX ft_content (content) WITH PARSER STANDARD');
    expect(createMemoriesSql).toContain('VECTOR INDEX idx_vec ((VEC_COSINE_DISTANCE(content_vector)))');
  });
});

describe('createLedgerSql', () => {
  it('keys the ledger by run, attempt and step', () => {
    expect(createLedgerSql).toContain('PRIMARY KEY (run_id, attempt_id, step)');
  });
});

describe('seedMemories', () => {
  it('has ten memories and no empty text', () => {
    expect(seedMemories).toHaveLength(10);
    expect(seedMemories.every((text) => text.length > 20)).toBe(true);
  });
});

describe('buildHybridSearch', () => {
  it('fuses a vector list and a full-text list with reciprocal rank fusion at 60', () => {
    const { sql } = buildHybridSearch({ text: 'double charge', limit: 3 });
    expect(sql).toContain('VEC_EMBED_COSINE_DISTANCE(content_vector, ?)');
    expect(sql).toContain('fts_match_word(?, content)');
    expect(sql).toContain('1.0 / (60 + r)');
    expect(sql).toContain('LIMIT 3');
  });

  it('binds the query text once per placeholder', () => {
    const { sql, params } = buildHybridSearch({ text: 'double charge', limit: 3 });
    expect(sql.match(/\?/g)).toHaveLength(3);
    expect(params).toEqual(['double charge', 'double charge', 'double charge']);
  });

  it('uses the candidate count in both lists', () => {
    const { sql } = buildHybridSearch({ text: 'x', limit: 3, candidates: 7 });
    expect(sql.match(/LIMIT 7/g)).toHaveLength(2);
  });

  it('rejects a limit that is not a positive integer', () => {
    expect(() => buildHybridSearch({ text: 'x', limit: 0 })).toThrow(RangeError);
    expect(() => buildHybridSearch({ text: 'x', limit: 1.5 })).toThrow(RangeError);
  });
});

describe('parseMemoryHits', () => {
  it('reads id, kind and content', () => {
    expect(parseMemoryHits([{ id: '4', kind: 'lesson', content: 'text', rrf_score: 0.03 }])).toEqual([
      { id: 4, kind: 'lesson', content: 'text' },
    ]);
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/starterSql.test.ts
```

Expected FAIL: `Cannot find module '../src/starterSql'`.

`demos/agent-coding/runner/src/starterSql.ts`:

```ts
export const createMemoriesSql = `CREATE TABLE IF NOT EXISTS memories (
  id INT PRIMARY KEY AUTO_INCREMENT,
  kind VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  content_vector VECTOR(1024) GENERATED ALWAYS AS (
    EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", content)
  ) STORED,
  FULLTEXT INDEX ft_content (content) WITH PARSER STANDARD,
  VECTOR INDEX idx_vec ((VEC_COSINE_DISTANCE(content_vector)))
)`;

export const createLedgerSql = `CREATE TABLE IF NOT EXISTS ledger (
  run_id VARCHAR(40) NOT NULL,
  attempt_id VARCHAR(16) NOT NULL,
  step INT NOT NULL,
  checkpoint_id VARCHAR(40) NOT NULL,
  db_time VARCHAR(30) NOT NULL,
  tree_hash CHAR(64) NOT NULL,
  db_checksum VARCHAR(24) NOT NULL,
  db_rows INT NOT NULL,
  PRIMARY KEY (run_id, attempt_id, step)
)`;

export const seedMemories: readonly string[] = [
  'Retried payment requests must be idempotent: look up the idempotency key before recording a charge.',
  'A connection reset from the gateway during a verification run is infrastructure noise: rerun once before judging the patch.',
  'Keep patches small and touch only the files the failing test covers.',
  'Never edit the failing test to make it pass.',
  'Charge records are append-only: fix duplicates by preventing the second write.',
  'Review the diff before opening a pull request.',
  'Do not wrap payment authorization in a retry loop without a backoff and a retry budget.',
  'Document behaviour changes in the README when a public contract changes.',
  'Prefer a ledger helper over an inlined lookup so the check lives in one place.',
  'A pull request needs a passing test run recorded in the ledger before it is opened.',
];

export const insertMemorySql = 'INSERT INTO memories (kind, content) VALUES (?, ?)';

export const insertLedgerSql =
  'INSERT INTO ledger (run_id, attempt_id, step, checkpoint_id, db_time, tree_hash, db_checksum, db_rows) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

export const buildHybridSearch = (options: {
  readonly text: string;
  readonly limit: number;
  readonly candidates?: number;
}): { readonly sql: string; readonly params: readonly string[] } => {
  const candidates = options.candidates ?? 20;
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError('limit must be a positive integer');
  if (!Number.isInteger(candidates) || candidates < 1) throw new RangeError('candidates must be a positive integer');
  const sql = `WITH
vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY distance, id) AS r
  FROM (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[memories]) */ id, VEC_EMBED_COSINE_DISTANCE(content_vector, ?) AS distance
    FROM memories
    ORDER BY distance
    LIMIT ${candidates}
  ) v
),
fts AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY score DESC, id) AS r
  FROM (
    SELECT id, fts_match_word(?, content) AS score
    FROM memories
    WHERE fts_match_word(?, content)
    ORDER BY score DESC
    LIMIT ${candidates}
  ) f
),
hits AS (
  SELECT id, 1.0 / (60 + r) AS contribution, r AS vector_rank, NULL AS fulltext_rank FROM vec
  UNION ALL
  SELECT id, 1.0 / (60 + r), NULL, r FROM fts
),
top_hits AS (
  SELECT id, SUM(contribution) AS rrf_score, MAX(vector_rank) AS vector_rank, MAX(fulltext_rank) AS fulltext_rank
  FROM hits
  GROUP BY id
  ORDER BY rrf_score DESC, id
  LIMIT ${options.limit}
)
SELECT m.id, m.kind, m.content, t.rrf_score, t.vector_rank, t.fulltext_rank
FROM top_hits t
JOIN memories m ON m.id = t.id
ORDER BY t.rrf_score DESC, t.id`;
  return { sql, params: [options.text, options.text, options.text] };
};

export type MemoryHit = {
  readonly id: number;
  readonly kind: string;
  readonly content: string;
};

export const parseMemoryHits = (rows: readonly Readonly<Record<string, unknown>>[]): readonly MemoryHit[] =>
  rows.map((row) => ({ id: Number(row.id), kind: String(row.kind), content: String(row.content) }));
```

Run the same command. Expected PASS: `Tests  8 passed (8)`.

Commit:

```bash
git add demos/agent-coding/runner/src/starterSql.ts demos/agent-coding/runner/test/starterSql.test.ts
git commit -m "agent-coding demo: add Starter SQL builders"
```

### Task 18: Lake SQL

- [ ] Not started

Everything Lake runs is built here as plain strings with a strict check on every interpolated value (`safeName`, `safeLiteral`, `safeBucket`), because the Lake driver takes whole statements. 12-V3 and 12-V4 must have confirmed the vector insert, the NDJSON timestamp parse, the Parquet load and the task behaviour (U6, U8). The stages are per-run: the stage URLs include the run id, so a new run never reloads an old run's objects.

`demos/agent-coding/runner/test/lakeSql.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildFailureInsert,
  countLedgerSql,
  countMarkerSql,
  countRunEventsSql,
  createWarehouseSql,
  lakeBootstrapStatements,
  lakeSetupStatements,
  lakeTeardownStatements,
  matchResetSql,
  mergedPerDollarSql,
  similarFailuresSql,
} from '../src/lakeSql';

const setup = {
  warehouse: 'agent-coding-wh',
  database: 'agent_coding',
  bucket: 'lab-agent-coding-123',
  prefix: '/agent-coding/',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret/with+chars',
};

describe('lakeSetupStatements', () => {
  const statements = lakeSetupStatements(setup);

  it('points the stages at the events and ledger prefixes', () => {
    expect(statements.some((sql) => sql.includes("URL = 's3://lab-agent-coding-123/agent-coding/events/'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("URL = 's3://lab-agent-coding-123/agent-coding/ledger/'"))).toBe(true);
  });

  it('creates a task that loads NDJSON every minute and then resumes it', () => {
    const task = statements.find((sql) => sql.startsWith('CREATE OR REPLACE TASK'));
    expect(task).toContain("WAREHOUSE = 'agent-coding-wh'");
    expect(task).toContain('SCHEDULE = 1 MINUTE');
    expect(task).toContain("PATTERN = '.*[.]ndjson'");
    expect(statements.at(-1)).toBe('ALTER TASK ingest_run_events RESUME');
  });

  it('indexes the message column for full-text search and the failure vector for similarity', () => {
    expect(statements.some((sql) => sql.includes('CREATE INVERTED INDEX idx_run_events_message ON run_events(message)'))).toBe(true);
    expect(statements.some((sql) => sql.includes("VECTOR INDEX idx_failure_vec(vec) distance = 'cosine'"))).toBe(true);
  });

  it('rejects a secret that would break out of the literal', () => {
    expect(() => lakeSetupStatements({ ...setup, secretAccessKey: "x' OR 1=1" })).toThrow('secret access key');
  });

  it('rejects an invalid warehouse name', () => {
    expect(() => lakeSetupStatements({ ...setup, warehouse: "a'b" })).toThrow('warehouse');
  });
});

describe('bootstrap and warehouse statements', () => {
  it('creates the database', () => {
    expect(lakeBootstrapStatements(setup)).toEqual(['CREATE DATABASE IF NOT EXISTS agent_coding']);
  });

  it('creates an extra small warehouse that suspends after the minimum idle time', () => {
    expect(createWarehouseSql('agent-coding-wh')).toBe(
      "CREATE WAREHOUSE IF NOT EXISTS 'agent-coding-wh' WITH warehouse_size = XSmall auto_suspend = 300",
    );
  });
});

describe('eval and count queries', () => {
  it('counts live events for one run', () => {
    expect(countRunEventsSql('run-1')).toBe("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'run-1' AND source = 'live'");
  });

  it('counts exported ledger rows for one run', () => {
    expect(countLedgerSql('run-1')).toBe("SELECT COUNT(*) AS n FROM ledger_lake WHERE run_id = 'run-1'");
  });

  it('counts a marker by id', () => {
    expect(countMarkerSql({ runId: 'run-1', markerId: 'mk-1' })).toContain("message = 'mk-1'");
  });

  it('finds gateway resets with full-text match', () => {
    expect(matchResetSql).toContain("MATCH(message, 'ECONNRESET')");
  });

  it('prices merged attempts per model', () => {
    expect(mergedPerDollarSql).toContain('GROUP BY model');
    expect(mergedPerDollarSql).toContain('/ SUM(cost_usd)');
  });

  it('ranks past failures by cosine distance and skips the current run', () => {
    const sql = similarFailuresSql({ runId: 'run-1', vector: [0.5, 0.5], limit: 3 });
    expect(sql).toContain('COSINE_DISTANCE(vec, [0.5,0.5])');
    expect(sql).toContain("run_id <> 'run-1'");
    expect(sql).toContain('LIMIT 3');
  });

  it('rejects an id with a quote', () => {
    expect(() => countRunEventsSql("a'b")).toThrow('run id');
  });
});

describe('buildFailureInsert', () => {
  it('writes one tuple per row with a vector literal', () => {
    const sql = buildFailureInsert([
      { run_id: 'r1', attempt_id: 'attempt-1', message: 'ECONNRESET at step 7', vector: [1, 0] },
      { run_id: 'r2', attempt_id: 'attempt-2', message: 'AssertionError at step 4', vector: [0, 1] },
    ]);
    expect(sql).toBe(
      "INSERT INTO run_failures (run_id, attempt_id, message, vec) VALUES\n('r1', 'attempt-1', 'ECONNRESET at step 7', [1,0]),\n('r2', 'attempt-2', 'AssertionError at step 4', [0,1])",
    );
  });

  it('refuses an empty batch', () => {
    expect(() => buildFailureInsert([])).toThrow(RangeError);
  });
});

describe('lakeTeardownStatements', () => {
  it('suspends the task and warehouse and drops what the demo created', () => {
    expect(lakeTeardownStatements(setup)).toEqual([
      'ALTER TASK ingest_run_events SUSPEND',
      'DROP TASK IF EXISTS ingest_run_events',
      'DROP DATABASE IF EXISTS agent_coding',
      'DROP CONNECTION IF EXISTS agent_s3',
      "ALTER WAREHOUSE 'agent-coding-wh' SUSPEND",
      "DROP WAREHOUSE IF EXISTS 'agent-coding-wh'",
    ]);
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/lakeSql.test.ts
```

Expected FAIL: `Cannot find module '../src/lakeSql'`.

`demos/agent-coding/runner/src/lakeSql.ts`:

```ts
import { vectorLiteral } from './embedding';
import type { FailureRow } from './history';

export type LakeSetup = {
  readonly warehouse: string;
  readonly database: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

const safeName = (value: string, what: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${what} may contain only letters, digits, hyphen and underscore`);
  return value;
};

const safeLiteral = (value: string, what: string): string => {
  if (/['\\]/.test(value) || value === '') throw new Error(`${what} must be non-empty and contain no quote or backslash`);
  return value;
};

const safeBucket = (value: string): string => {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)) throw new Error('bucket is not a valid S3 bucket name');
  return value;
};

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

export const runEventsTable = 'run_events';
export const ledgerTable = 'ledger_lake';
export const failuresTable = 'run_failures';

export const eventsTaskName = 'ingest_run_events';

export const lakeBootstrapStatements = (setup: Pick<LakeSetup, 'database'>): readonly string[] => [
  `CREATE DATABASE IF NOT EXISTS ${safeName(setup.database, 'database')}`,
];

export const createWarehouseSql = (warehouse: string): string =>
  `CREATE WAREHOUSE IF NOT EXISTS '${safeName(warehouse, 'warehouse')}' WITH warehouse_size = XSmall auto_suspend = 300`;

export const lakeSetupStatements = (setup: LakeSetup): readonly string[] => {
  const warehouse = safeName(setup.warehouse, 'warehouse');
  const root = `s3://${safeBucket(setup.bucket)}/${trimSlashes(setup.prefix)}`;
  return [
    `CREATE OR REPLACE CONNECTION agent_s3 STORAGE_TYPE = 's3' ACCESS_KEY_ID = '${safeLiteral(setup.accessKeyId, 'access key id')}' SECRET_ACCESS_KEY = '${safeLiteral(setup.secretAccessKey, 'secret access key')}'`,
    `CREATE OR REPLACE STAGE events_stage URL = '${root}/events/' CONNECTION = (CONNECTION_NAME = 'agent_s3')`,
    `CREATE OR REPLACE STAGE ledger_stage URL = '${root}/ledger/' CONNECTION = (CONNECTION_NAME = 'agent_s3')`,
    `CREATE OR REPLACE TABLE ${runEventsTable} (
  run_id STRING, attempt_id STRING, step INT, kind STRING, status STRING, model STRING,
  cost_usd DOUBLE, merged BOOLEAN, message STRING, emitted_at TIMESTAMP, source STRING
)`,
    `CREATE INVERTED INDEX idx_run_events_message ON ${runEventsTable}(message)`,
    `CREATE OR REPLACE TABLE ${ledgerTable} (
  run_id STRING, attempt_id STRING, step INT, checkpoint_id STRING, db_time STRING,
  tree_hash STRING, db_checksum STRING, db_rows INT
)`,
    `CREATE OR REPLACE TABLE ${failuresTable} (
  run_id STRING, attempt_id STRING, message STRING, vec VECTOR(64),
  VECTOR INDEX idx_failure_vec(vec) distance = 'cosine'
)`,
    `CREATE OR REPLACE TASK ${eventsTaskName} WAREHOUSE = '${warehouse}' SCHEDULE = 1 MINUTE AS COPY INTO ${runEventsTable} FROM @events_stage PATTERN = '.*[.]ndjson' FILE_FORMAT = (TYPE = NDJSON)`,
    `ALTER TASK ${eventsTaskName} RESUME`,
  ];
};

export const copyLedgerSql = `COPY INTO ${ledgerTable} FROM @ledger_stage PATTERN = '.*[.]parquet' FILE_FORMAT = (TYPE = PARQUET)`;

export const executeEventsTaskSql = `EXECUTE TASK ${eventsTaskName}`;

export const buildFailureInsert = (rows: readonly FailureRow[]): string => {
  if (rows.length === 0) throw new RangeError('at least one failure row is required');
  const values = rows
    .map(
      (row) =>
        `('${safeLiteral(row.run_id, 'run id')}', '${safeLiteral(row.attempt_id, 'attempt id')}', '${safeLiteral(row.message, 'message')}', ${vectorLiteral(row.vector)})`,
    )
    .join(',\n');
  return `INSERT INTO ${failuresTable} (run_id, attempt_id, message, vec) VALUES\n${values}`;
};

export const countRunEventsSql = (runId: string): string =>
  `SELECT COUNT(*) AS n FROM ${runEventsTable} WHERE run_id = '${safeLiteral(runId, 'run id')}' AND source = 'live'`;

export const countMarkerSql = (options: { readonly runId: string; readonly markerId: string }): string =>
  `SELECT COUNT(*) AS n FROM ${runEventsTable} WHERE run_id = '${safeLiteral(options.runId, 'run id')}' AND kind = 'marker' AND message = '${safeLiteral(options.markerId, 'marker id')}'`;

export const countLedgerSql = (runId: string): string =>
  `SELECT COUNT(*) AS n FROM ${ledgerTable} WHERE run_id = '${safeLiteral(runId, 'run id')}'`;

export const matchResetSql = `SELECT COUNT(*) AS matches, COUNT(DISTINCT run_id) AS runs FROM ${runEventsTable} WHERE MATCH(message, 'ECONNRESET')`;

export const mergedPerDollarSql = `SELECT model, SUM(CASE WHEN merged THEN 1 ELSE 0 END) AS merged_attempts, SUM(cost_usd) AS cost_usd, SUM(CASE WHEN merged THEN 1 ELSE 0 END) / SUM(cost_usd) AS merged_per_dollar FROM ${runEventsTable} WHERE kind = 'attempt.finished' GROUP BY model ORDER BY merged_per_dollar DESC`;

export const similarFailuresSql = (options: {
  readonly runId: string;
  readonly vector: readonly number[];
  readonly limit: number;
}): string => {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError('limit must be a positive integer');
  return `SELECT run_id, attempt_id, message, COSINE_DISTANCE(vec, ${vectorLiteral(options.vector)}) AS distance FROM ${failuresTable} WHERE run_id <> '${safeLiteral(options.runId, 'run id')}' ORDER BY distance ASC LIMIT ${options.limit}`;
};

export const lakeTeardownStatements = (setup: Pick<LakeSetup, 'warehouse' | 'database'>): readonly string[] => {
  const warehouse = safeName(setup.warehouse, 'warehouse');
  return [
    `ALTER TASK ${eventsTaskName} SUSPEND`,
    `DROP TASK IF EXISTS ${eventsTaskName}`,
    `DROP DATABASE IF EXISTS ${safeName(setup.database, 'database')}`,
    `DROP CONNECTION IF EXISTS agent_s3`,
    `ALTER WAREHOUSE '${warehouse}' SUSPEND`,
    `DROP WAREHOUSE IF EXISTS '${warehouse}'`,
  ];
};
```

Run the same command. Expected PASS: `Tests  17 passed (17)`.

Commit:

```bash
git add demos/agent-coding/runner/src/lakeSql.ts demos/agent-coding/runner/test/lakeSql.test.ts
git commit -m "agent-coding demo: add Lake SQL builders"
```

### Task 19: Synthetic history and run events

- [ ] Not started

Run events are the NDJSON objects the runner sends to S3, with snake_case keys so Lake maps them by column name. `generateHistory` produces labelled synthetic past runs (`source` is `synthetic-history`, model names are fixture labels) so the eval has something to aggregate; every use of them in the demo says modeled. `failureRows` embeds the failed history rows for the cosine-distance query.

`demos/agent-coding/runner/test/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { attemptFinishedEvent, markerEvent, stepEvent, toLakeTimestamp } from '../src/events';
import type { StepOutcome } from '../src/harness';
import type { AttemptScript } from '../src/scripts';

const script: AttemptScript = {
  attemptId: 'attempt-2',
  model: 'fixture-model-b',
  stepCostUsd: 0.03,
  steps: [{ step: 1, kind: 'read', note: 'Read' }],
};

const failing: StepOutcome = {
  step: 7,
  kind: 'verify',
  note: 'Run the suite',
  halted: true,
  test: { passed: false, failing: ['a'], passing: 0, signature: 'ECONNRESET' },
};

describe('toLakeTimestamp', () => {
  it('formats UTC with a space and milliseconds', () => {
    expect(toLakeTimestamp(Date.UTC(2026, 9, 17, 10, 0, 0, 250))).toBe('2026-10-17 10:00:00.250');
  });
});

describe('stepEvent', () => {
  it('marks a halted step as failed and carries the signature', () => {
    const event = stepEvent({ runId: 'run-1', script, outcome: failing, nowMs: 0 });
    expect(event).toMatchObject({
      run_id: 'run-1',
      attempt_id: 'attempt-2',
      step: 7,
      kind: 'step',
      status: 'failed',
      source: 'live',
      message: 'ECONNRESET: Run the suite',
    });
  });

  it('marks an ordinary step as ok', () => {
    const event = stepEvent({
      runId: 'run-1',
      script,
      outcome: { step: 1, kind: 'read', note: 'Read', halted: false },
      nowMs: 0,
    });
    expect(event.status).toBe('ok');
  });
});

describe('attemptFinishedEvent', () => {
  it('prices an attempt at its fixture step cost times the steps it ran', () => {
    const event = attemptFinishedEvent({
      runId: 'run-1',
      script,
      outcomes: [
        { step: 1, kind: 'read', note: 'Read', halted: false },
        { ...failing, step: 2 },
      ],
      merged: false,
      nowMs: 0,
    });
    expect(event).toMatchObject({ status: 'failed', cost_usd: 0.06, merged: false, message: 'ECONNRESET at step 2' });
  });

  it('reports a passing attempt and whether it merged', () => {
    const event = attemptFinishedEvent({
      runId: 'run-1',
      script,
      outcomes: [{ step: 1, kind: 'read', note: 'Read', halted: false }],
      merged: true,
      nowMs: 0,
    });
    expect(event).toMatchObject({ status: 'passed', merged: true, message: 'tests passed' });
  });
});

describe('markerEvent', () => {
  it('carries the marker id as its message', () => {
    expect(markerEvent({ runId: 'run-1', markerId: 'mk-1', nowMs: 0 })).toMatchObject({
      kind: 'marker',
      message: 'mk-1',
      source: 'live',
    });
  });
});
```

`demos/agent-coding/runner/test/history.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { failureRows, generateHistory } from '../src/history';

const options = { seed: 42, runs: 50, endMs: Date.UTC(2026, 9, 17) };

describe('generateHistory', () => {
  it('is deterministic for a seed', () => {
    expect(generateHistory(options)).toEqual(generateHistory(options));
  });

  it('writes three attempt rows for every run', () => {
    const events = generateHistory(options);
    expect(events).toHaveLength(150);
    expect(new Set(events.map((event) => event.run_id)).size).toBe(50);
  });

  it('labels every row as synthetic history with a fixture model name', () => {
    const events = generateHistory(options);
    expect(events.every((event) => event.source === 'synthetic-history')).toBe(true);
    expect(events.every((event) => event.model.startsWith('fixture-model-'))).toBe(true);
  });

  it('only merges attempts that passed', () => {
    expect(generateHistory(options).filter((event) => event.merged).every((event) => event.status === 'passed')).toBe(true);
  });

  it('includes gateway reset failures that full-text search can find', () => {
    expect(generateHistory(options).some((event) => event.message.includes('ECONNRESET'))).toBe(true);
  });
});

describe('failureRows', () => {
  it('keeps only failed attempts and embeds their messages', () => {
    const events = generateHistory(options);
    const rows = failureRows(events);
    expect(rows.length).toBe(events.filter((event) => event.status === 'failed').length);
    expect(rows.every((row) => row.vector.length === 64)).toBe(true);
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/events.test.ts runner/test/history.test.ts
```

Expected FAIL: `Cannot find module '../src/events'` (and the same for `history`).

`demos/agent-coding/runner/src/events.ts`:

```ts
import type { AttemptScript } from './scripts';
import type { StepOutcome } from './harness';

export type RunEvent = {
  readonly run_id: string;
  readonly attempt_id: string;
  readonly step: number;
  readonly kind: string;
  readonly status: string;
  readonly model: string;
  readonly cost_usd: number;
  readonly merged: boolean;
  readonly message: string;
  readonly emitted_at: string;
  readonly source: string;
};

export const toLakeTimestamp = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

const roundUsd = (value: number): number => Math.round(value * 10000) / 10000;

export const stepEvent = (options: {
  readonly runId: string;
  readonly script: AttemptScript;
  readonly outcome: StepOutcome;
  readonly nowMs: number;
}): RunEvent => {
  const failed = options.outcome.halted;
  return {
    run_id: options.runId,
    attempt_id: options.script.attemptId,
    step: options.outcome.step,
    kind: 'step',
    status: failed ? 'failed' : 'ok',
    model: options.script.model,
    cost_usd: roundUsd(options.script.stepCostUsd),
    merged: false,
    message: failed ? `${options.outcome.test?.signature ?? 'failure'}: ${options.outcome.note}` : options.outcome.note,
    emitted_at: toLakeTimestamp(options.nowMs),
    source: 'live',
  };
};

export const attemptFinishedEvent = (options: {
  readonly runId: string;
  readonly script: AttemptScript;
  readonly outcomes: readonly StepOutcome[];
  readonly merged: boolean;
  readonly nowMs: number;
}): RunEvent => {
  const last = options.outcomes.at(-1);
  const failed = last?.halted === true;
  return {
    run_id: options.runId,
    attempt_id: options.script.attemptId,
    step: options.outcomes.length,
    kind: 'attempt.finished',
    status: failed ? 'failed' : 'passed',
    model: options.script.model,
    cost_usd: roundUsd(options.script.stepCostUsd * options.outcomes.length),
    merged: options.merged,
    message: failed ? `${last?.test?.signature ?? 'failure'} at step ${last?.step ?? 0}` : 'tests passed',
    emitted_at: toLakeTimestamp(options.nowMs),
    source: 'live',
  };
};

export const markerEvent = (options: { readonly runId: string; readonly markerId: string; readonly nowMs: number }): RunEvent => ({
  run_id: options.runId,
  attempt_id: 'none',
  step: 0,
  kind: 'marker',
  status: 'ok',
  model: 'none',
  cost_usd: 0,
  merged: false,
  message: options.markerId,
  emitted_at: toLakeTimestamp(options.nowMs),
  source: 'live',
});
```

`demos/agent-coding/runner/src/history.ts`:

```ts
import { mulberry32 } from './random';
import { toLakeTimestamp, type RunEvent } from './events';
import { hashEmbedding } from './embedding';

const models: readonly string[] = ['fixture-model-a', 'fixture-model-b', 'fixture-model-c'];

const failureMessages: readonly string[] = [
  'ECONNRESET at step 7: connect ECONNRESET from payment gateway stub',
  'ECONNRESET at step 5: connect ECONNRESET while verifying retry wrapper',
  'AssertionError at step 6: expected one charge but ledger holds two',
  'AssertionError at step 4: charge id differs after a retried request',
  'TimeoutError at step 8: test run exceeded the step budget',
];

export const generateHistory = (options: {
  readonly seed: number;
  readonly runs: number;
  readonly endMs: number;
}): readonly RunEvent[] => {
  const next = mulberry32(options.seed);
  return Array.from({ length: options.runs }, (_, runIndex) =>
    Array.from({ length: 3 }, (_, attemptIndex): RunEvent => {
      const model = models[Math.floor(next() * models.length)] ?? 'fixture-model-a';
      const steps = 5 + Math.floor(next() * 6);
      const passed = next() < 0.55;
      const merged = passed && next() < 0.7;
      const message = passed
        ? 'tests passed'
        : (failureMessages[Math.floor(next() * failureMessages.length)] ?? 'unknown failure');
      return {
        run_id: `hist-${String(runIndex + 1).padStart(4, '0')}`,
        attempt_id: `attempt-${attemptIndex + 1}`,
        step: steps,
        kind: 'attempt.finished',
        status: passed ? 'passed' : 'failed',
        model,
        cost_usd: Math.round(steps * (0.02 + next() * 0.04) * 10000) / 10000,
        merged,
        message,
        emitted_at: toLakeTimestamp(options.endMs - (options.runs - runIndex) * 3600000),
        source: 'synthetic-history',
      };
    }),
  ).flat();
};

export type FailureRow = {
  readonly run_id: string;
  readonly attempt_id: string;
  readonly message: string;
  readonly vector: readonly number[];
};

export const failureRows = (events: readonly RunEvent[]): readonly FailureRow[] =>
  events
    .filter((event) => event.status === 'failed' && event.kind === 'attempt.finished')
    .map((event) => ({
      run_id: event.run_id,
      attempt_id: event.attempt_id,
      message: event.message,
      vector: hashEmbedding(event.message),
    }));
```

Run the same command. Expected PASS: `Test Files  2 passed (2)` and `Tests  12 passed (12)`.
Commit:

```bash
git add demos/agent-coding/runner/src/events.ts demos/agent-coding/runner/src/history.ts demos/agent-coding/runner/test/events.test.ts demos/agent-coding/runner/test/history.test.ts
git commit -m "agent-coding demo: add run events and synthetic history"
```

### Task 20: Check verdicts, control gating and the lesson text

- [ ] Not started

Each check is a pure verdict over measured values, so a pass is never asserted: `isolationVerdict` (a file only one attempt wrote must appear in that attempt's layer diff and no other), `snapshotsVerdict` (equal row count and checksum on every attempt branch), `replayVerdict` (same failing tests, same signature, same tree hash and same row checksum as the ledger record), `countVerdict` (events visible in Lake equal events emitted). `gateControl` decides whether a pressed control may run; `assertBranchHeadroom` refuses to start when the branch quota cannot fit the run.

`demos/agent-coding/runner/test/checks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countVerdict, isolationVerdict, replayVerdict, snapshotsVerdict } from '../src/checks';

const owners = { 'src/idempotency.js': 'attempt-1', 'src/retry.js': 'attempt-3' };

describe('isolationVerdict', () => {
  it('passes when each private file shows only in its own layer', () => {
    const verdict = isolationVerdict({
      owners,
      diffs: {
        'attempt-1': ['/workspace/payments-api/src/charge.js', '/workspace/payments-api/src/idempotency.js'],
        'attempt-2': ['/workspace/payments-api/src/charge.js'],
        'attempt-3': ['/workspace/payments-api/src/retry.js'],
      },
    });
    expect(verdict).toEqual({ pass: true, observed: '2 attempt-private files appear only in their own layer diff' });
  });

  it('fails when one attempt edit shows up in another layer', () => {
    const verdict = isolationVerdict({
      owners,
      diffs: {
        'attempt-1': ['src/idempotency.js'],
        'attempt-2': ['src/idempotency.js'],
        'attempt-3': ['src/retry.js'],
      },
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.observed).toBe('src/idempotency.js written by attempt-1 appears in attempt-2');
  });

  it('fails when an owner diff is missing its own file', () => {
    const verdict = isolationVerdict({ owners, diffs: { 'attempt-1': [], 'attempt-3': ['src/retry.js'] } });
    expect(verdict.observed).toBe('src/idempotency.js missing from attempt-1');
  });

  it('does not treat a longer file name as a match', () => {
    const verdict = isolationVerdict({
      owners: { 'src/retry.js': 'attempt-3' },
      diffs: { 'attempt-1': ['src/backoff-retry.js'], 'attempt-3': ['src/retry.js'] },
    });
    expect(verdict.pass).toBe(true);
  });
});

describe('snapshotsVerdict', () => {
  const snapshot = { dbTime: '2026-10-17T10:00:00.000Z', rowCount: 2000, checksum: '99' };

  it('passes when every branch has the same rows and checksum', () => {
    expect(snapshotsVerdict({ 'attempt-1': snapshot, 'attempt-2': snapshot, 'attempt-3': snapshot }).pass).toBe(true);
  });

  it('names the branch that differs', () => {
    const verdict = snapshotsVerdict({
      'attempt-1': snapshot,
      'attempt-2': { ...snapshot, checksum: '100' },
      'attempt-3': snapshot,
    });
    expect(verdict).toEqual({ pass: false, observed: 'differs from attempt-1: attempt-2' });
  });

  it('fails when nothing was measured', () => {
    expect(snapshotsVerdict({}).pass).toBe(false);
  });
});

describe('replayVerdict', () => {
  const record = { failing: ['a', 'b'], signature: 'ECONNRESET', treeHash: 'h', checksum: 'c' };

  it('passes when the failure, tree and rows all match', () => {
    expect(replayVerdict({ original: record, replay: { ...record } }).pass).toBe(true);
  });

  it('lists every mismatch', () => {
    const verdict = replayVerdict({
      original: record,
      replay: { failing: ['a'], signature: 'AssertionError', treeHash: 'x', checksum: 'y' },
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.observed).toBe(
      'failing tests differ; failure signature differs; file tree differs from the checkpoint record; branch row checksum differs from the ledger record',
    );
  });
});

describe('countVerdict', () => {
  it('passes on equal counts and reports both numbers otherwise', () => {
    expect(countVerdict({ emitted: 26, visible: 26 }).pass).toBe(true);
    expect(countVerdict({ emitted: 26, visible: 20 })).toEqual({
      pass: false,
      observed: '20 visible in Lake but 26 emitted',
    });
  });
});
```

`demos/agent-coding/runner/test/gates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertBranchHeadroom, gateControl } from '../src/gates';

describe('gateControl', () => {
  it('lets fan-out run once', () => {
    expect(gateControl({ control: 'fan-out', done: [] })).toEqual({ run: true });
    expect(gateControl({ control: 'fan-out', done: ['fan-out'] })).toMatchObject({ run: false });
  });

  it('only arms the flaky dependency before the fan-out', () => {
    expect(gateControl({ control: 'inject-flaky-dependency', done: [] })).toEqual({ run: true });
    expect(gateControl({ control: 'inject-flaky-dependency', done: ['fan-out'] })).toMatchObject({ run: false });
  });

  it('needs the fan-out before a replay or an eval', () => {
    expect(gateControl({ control: 'replay-failed-step', done: [] })).toEqual({ run: false, reason: 'press fan-out first' });
    expect(gateControl({ control: 'run-eval', done: [] })).toEqual({ run: false, reason: 'press fan-out first' });
    expect(gateControl({ control: 'replay-failed-step', done: ['fan-out'] })).toEqual({ run: true });
    expect(gateControl({ control: 'run-eval', done: ['fan-out'] })).toEqual({ run: true });
  });

  it('writes the lesson only after both the replay and the eval', () => {
    expect(gateControl({ control: 'write-lesson', done: ['fan-out', 'run-eval'] })).toEqual({
      run: false,
      reason: 'replay the failed step first',
    });
    expect(gateControl({ control: 'write-lesson', done: ['fan-out', 'replay-failed-step'] })).toEqual({
      run: false,
      reason: 'run the eval first',
    });
    expect(gateControl({ control: 'write-lesson', done: ['fan-out', 'replay-failed-step', 'run-eval'] })).toEqual({
      run: true,
    });
  });

  it('refuses a second lesson and an unknown control', () => {
    expect(
      gateControl({ control: 'write-lesson', done: ['fan-out', 'replay-failed-step', 'run-eval', 'write-lesson'] }),
    ).toMatchObject({ run: false });
    expect(gateControl({ control: 'nope', done: [] })).toEqual({ run: false, reason: 'unknown control: nope' });
  });
});

describe('assertBranchHeadroom', () => {
  it('accepts a plan that fits the quota', () => {
    expect(() => assertBranchHeadroom({ existing: 1, needed: 4, quota: 5 })).not.toThrow();
  });

  it('names the numbers when it does not fit', () => {
    expect(() => assertBranchHeadroom({ existing: 2, needed: 4, quota: 5 })).toThrow(
      'branch quota exceeded: 2 existing + 4 needed is more than 5',
    );
  });
});
```

`demos/agent-coding/runner/test/lesson.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildLesson, intakeQuery, lessonRecalled } from '../src/lesson';

describe('intakeQuery', () => {
  it('joins the ticket title and id', () => {
    expect(intakeQuery({ id: 'KIT-8812', title: 'fix double charge on retried payments' })).toBe(
      'fix double charge on retried payments KIT-8812',
    );
  });
});

describe('buildLesson', () => {
  const base = {
    ticketId: 'KIT-8812',
    attemptId: 'attempt-2',
    step: 7,
    signature: 'ECONNRESET',
    reproduced: true,
    winnerId: 'attempt-1',
  };

  it('states the failure, the reproduction and the winner', () => {
    expect(buildLesson(base)).toBe(
      'KIT-8812: attempt-2 failed at step 7 with ECONNRESET after it wrapped the gateway call in a retry loop. Replaying from the step-07 checkpoint reproduced the same failing tests. attempt-1 won with a smaller change. Fix idempotency in the ledger first and treat gateway connection resets as retryable infrastructure faults, not patch defects.',
    );
  });

  it('says so when the replay did not reproduce', () => {
    expect(buildLesson({ ...base, reproduced: false, winnerId: undefined })).toContain(
      'The replay did not reproduce the failure, so treat it as flaky. No attempt passed.',
    );
  });

  it('contains no em dash', () => {
    expect(buildLesson(base)).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('lessonRecalled', () => {
  it('finds the lesson id among the hits', () => {
    expect(lessonRecalled([{ id: 3 }, { id: 11 }], 11)).toBe(true);
    expect(lessonRecalled([{ id: 3 }], 11)).toBe(false);
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/checks.test.ts runner/test/gates.test.ts runner/test/lesson.test.ts
```

Expected FAIL: `Cannot find module '../src/checks'` (and the same for `gates` and `lesson`).

`demos/agent-coding/runner/src/checks.ts`:

```ts
import type { BranchSnapshot } from './snapshot';

export type CheckVerdict = { readonly pass: boolean; readonly observed: string };

const touches = (diff: readonly string[], path: string): boolean =>
  diff.some((entry) => entry === path || entry.endsWith(`/${path}`));

export const isolationVerdict = (options: {
  readonly diffs: Readonly<Record<string, readonly string[]>>;
  readonly owners: Readonly<Record<string, string>>;
}): CheckVerdict => {
  const violations = Object.entries(options.owners).flatMap(([path, owner]) =>
    Object.entries(options.diffs).flatMap(([attemptId, diff]) => {
      const present = touches(diff, path);
      if (attemptId === owner && !present) return [`${path} missing from ${owner}`];
      if (attemptId !== owner && present) return [`${path} written by ${owner} appears in ${attemptId}`];
      return [];
    }),
  );
  const checked = Object.keys(options.owners).length;
  return violations.length === 0
    ? { pass: true, observed: `${checked} attempt-private files appear only in their own layer diff` }
    : { pass: false, observed: violations.join('; ') };
};

export const snapshotsVerdict = (snapshots: Readonly<Record<string, BranchSnapshot>>): CheckVerdict => {
  const entries = Object.entries(snapshots);
  const first = entries[0]?.[1];
  if (first === undefined) return { pass: false, observed: 'no branch snapshots were taken' };
  const odd = entries.filter(([, snapshot]) => snapshot.checksum !== first.checksum || snapshot.rowCount !== first.rowCount);
  return odd.length === 0
    ? { pass: true, observed: `${entries.length} branches agree: ${first.rowCount} rows, checksum ${first.checksum}` }
    : { pass: false, observed: `differs from ${entries[0]?.[0]}: ${odd.map(([attemptId]) => attemptId).join(', ')}` };
};

export type StepRecord = {
  readonly failing: readonly string[];
  readonly signature: string | undefined;
  readonly treeHash: string;
  readonly checksum: string;
};

export const replayVerdict = (options: { readonly original: StepRecord; readonly replay: StepRecord }): CheckVerdict => {
  const { original, replay } = options;
  const mismatches = [
    original.failing.join('|') !== replay.failing.join('|') ? 'failing tests differ' : undefined,
    original.signature !== replay.signature ? 'failure signature differs' : undefined,
    original.treeHash !== replay.treeHash ? 'file tree differs from the checkpoint record' : undefined,
    original.checksum !== replay.checksum ? 'branch row checksum differs from the ledger record' : undefined,
  ].filter((item): item is string => item !== undefined);
  return mismatches.length === 0
    ? {
        pass: true,
        observed: `${replay.failing.length} failing tests, ${replay.signature ?? 'no signature'}, tree and rows match the step record`,
      }
    : { pass: false, observed: mismatches.join('; ') };
};

export const countVerdict = (options: { readonly emitted: number; readonly visible: number }): CheckVerdict =>
  options.emitted === options.visible
    ? { pass: true, observed: `${options.visible} of ${options.emitted} emitted events visible in Lake` }
    : { pass: false, observed: `${options.visible} visible in Lake but ${options.emitted} emitted` };
```

`demos/agent-coding/runner/src/gates.ts`:

```ts
export type Gate =
  | { readonly run: true }
  | { readonly run: false; readonly reason: string };

const allow: Gate = { run: true };
const refuse = (reason: string): Gate => ({ run: false, reason });

export const gateControl = (options: { readonly control: string; readonly done: readonly string[] }): Gate => {
  const has = (stage: string): boolean => options.done.includes(stage);
  switch (options.control) {
    case 'inject-flaky-dependency':
      return has('fan-out') ? refuse('the fan-out already ran; restart the runner and press this first') : allow;
    case 'fan-out':
      return has('fan-out') ? refuse('the fan-out already ran; restart the runner for a new run') : allow;
    case 'replay-failed-step':
      if (!has('fan-out')) return refuse('press fan-out first');
      return has('replay-failed-step') ? refuse('the replay already ran') : allow;
    case 'run-eval':
      if (!has('fan-out')) return refuse('press fan-out first');
      return has('run-eval') ? refuse('the eval already ran') : allow;
    case 'write-lesson':
      if (!has('replay-failed-step')) return refuse('replay the failed step first');
      if (!has('run-eval')) return refuse('run the eval first');
      return has('write-lesson') ? refuse('the lesson is already written') : allow;
    default:
      return refuse(`unknown control: ${options.control}`);
  }
};

export const assertBranchHeadroom = (options: {
  readonly existing: number;
  readonly needed: number;
  readonly quota: number;
}): void => {
  if (options.existing + options.needed <= options.quota) return;
  throw new Error(
    `branch quota exceeded: ${options.existing} existing + ${options.needed} needed is more than ${options.quota}; delete old branches or raise the quota`,
  );
};
```

`demos/agent-coding/runner/src/lesson.ts`:

```ts
export const intakeQuery = (ticket: { readonly id: string; readonly title: string }): string => `${ticket.title} ${ticket.id}`;

export const buildLesson = (options: {
  readonly ticketId: string;
  readonly attemptId: string;
  readonly step: number;
  readonly signature: string;
  readonly reproduced: boolean;
  readonly winnerId: string | undefined;
}): string => {
  const outcome = options.reproduced
    ? `Replaying from the step-${String(options.step).padStart(2, '0')} checkpoint reproduced the same failing tests.`
    : 'The replay did not reproduce the failure, so treat it as flaky.';
  const winner = options.winnerId === undefined ? 'No attempt passed.' : `${options.winnerId} won with a smaller change.`;
  return `${options.ticketId}: ${options.attemptId} failed at step ${options.step} with ${options.signature} after it wrapped the gateway call in a retry loop. ${outcome} ${winner} Fix idempotency in the ledger first and treat gateway connection resets as retryable infrastructure faults, not patch defects.`;
};

export const lessonRecalled = (hits: readonly { readonly id: number }[], lessonId: number): boolean =>
  hits.some((hit) => hit.id === lessonId);
```

Run the same command. Expected PASS: `Test Files  3 passed (3)` and `Tests  22 passed (22)`.
Commit:

```bash
git add demos/agent-coding/runner/src/checks.ts demos/agent-coding/runner/src/gates.ts demos/agent-coding/runner/src/lesson.ts demos/agent-coding/runner/test/checks.test.ts demos/agent-coding/runner/test/gates.test.ts demos/agent-coding/runner/test/lesson.test.ts
git commit -m "agent-coding demo: add check verdicts, control gating and lesson text"
```

### Task 21: Configuration, the branch connection environment and export helpers

- [ ] Not started

`runConfigFromEnv` reads and validates every variable once (an empty value counts as unset, because the relay loads `.env` files that contain empty keys). `branchEnv` builds an environment for `createTidbPool` that points the standard `TIDB_*` variables at a branch, so branch connections still go through the shared connection helpers (platform rule 5). `branchUser` applies the user-name prefix rule, which is UNVERIFIED (U4): 12-V2 confirms or replaces it. The export helpers build the `ticloud serverless export` arguments and read its output; the output shapes are UNVERIFIED (U6).

`demos/agent-coding/runner/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeRunId, runConfigFromEnv } from '../src/config';

const env = {
  AGENT_ORG_CLUSTER_ID: 'org-1',
  AGENT_FIXTURE_CLUSTER_ID: 'fix-1',
  FIXTURE_SQL_USER: 'reader',
  FIXTURE_SQL_PASSWORD: 'pw',
  S3_BUCKET: 'lab-bucket',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  LAKE_WAREHOUSE: 'agent-coding-wh',
};

const options = { fixturesDir: '/repo/fixtures', now: new Date('2026-10-17T10:11:12Z'), homeDir: '/home/lab' };

describe('makeRunId', () => {
  it('encodes the start time to the second', () => {
    expect(makeRunId(new Date('2026-10-17T10:11:12Z'))).toBe('run-20261017-101112');
  });
});

describe('runConfigFromEnv', () => {
  it('applies the documented defaults', () => {
    const config = runConfigFromEnv(env, options);
    expect(config).toMatchObject({
      runId: 'run-20261017-101112',
      ticket: { id: 'KIT-8812', title: 'fix double charge on retried payments' },
      workDir: '/home/lab/lab-agent-coding-work',
      fixtureDatabase: 'fixture',
      branchQuota: 5,
      stepWaitMs: 1000,
      autoRun: false,
      executeLakeTask: false,
      region: 'us-east-1',
      prefix: 'agent-coding',
      lakeDatabase: 'agent_coding',
    });
  });

  it('reads overrides', () => {
    const config = runConfigFromEnv(
      { ...env, STEP_WAIT_MS: '1500', AUTO_RUN: 'true', LAKE_EXECUTE_TASK: 'true', WORK_DIR: '/data/w' },
      options,
    );
    expect(config).toMatchObject({ stepWaitMs: 1500, autoRun: true, executeLakeTask: true, workDir: '/data/w' });
  });

  it('treats empty optional variables as unset', () => {
    const config = runConfigFromEnv({ ...env, WORK_DIR: '', S3_REGION: '', S3_PREFIX: '', LAKE_DATABASE: '', FIXTURE_DATABASE: '' }, options);
    expect(config).toMatchObject({
      workDir: '/home/lab/lab-agent-coding-work',
      region: 'us-east-1',
      prefix: 'agent-coding',
      lakeDatabase: 'agent_coding',
      fixtureDatabase: 'fixture',
    });
  });

  it('names a missing required variable', () => {
    expect(() => runConfigFromEnv({ ...env, S3_BUCKET: undefined }, options)).toThrow('missing required env var: S3_BUCKET');
  });

  it('rejects a number that is not numeric', () => {
    expect(() => runConfigFromEnv({ ...env, BRANCH_QUOTA: 'five' }, options)).toThrow('BRANCH_QUOTA must be a number');
  });
});
```

`demos/agent-coding/runner/test/branchEnv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tidbConfigFromEnv } from '@lab/runner-kit';
import { branchEnv, branchUser } from '../src/branchEnv';

describe('branchUser', () => {
  it('prefixes a bare user name', () => {
    expect(branchUser({ userPrefix: '3pTAoNNegb47Uc8', user: 'reader' })).toBe('3pTAoNNegb47Uc8.reader');
  });

  it('keeps a user that already carries a prefix', () => {
    expect(branchUser({ userPrefix: 'abc', user: 'abc.reader' })).toBe('abc.reader');
  });

  it('keeps the user when no prefix is known', () => {
    expect(branchUser({ userPrefix: undefined, user: 'reader' })).toBe('reader');
  });
});

describe('branchEnv', () => {
  const env = branchEnv({
    base: { TIDB_HOST: 'org-host', S3_BUCKET: 'b', UNSET: undefined },
    host: 'branch-host',
    port: 4000,
    user: 'p.reader',
    password: 'pw',
    database: 'fixture',
  });

  it('points the standard TiDB variables at the branch with TLS on', () => {
    expect(env).toMatchObject({
      TIDB_HOST: 'branch-host',
      TIDB_PORT: '4000',
      TIDB_USER: 'p.reader',
      TIDB_PASSWORD: 'pw',
      TIDB_DATABASE: 'fixture',
      TIDB_TLS: 'true',
      TIDB_POOL_SIZE: '2',
    });
  });

  it('keeps unrelated variables and drops undefined ones', () => {
    expect(env.S3_BUCKET).toBe('b');
    expect('UNSET' in env).toBe(false);
  });

  it('is accepted by the shared connection config builder', () => {
    expect(tidbConfigFromEnv(env)).toMatchObject({ host: 'branch-host', port: 4000, user: 'p.reader' });
  });
});
```

`demos/agent-coding/runner/test/ticloudExport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildExportArgs, parseExportId, parseExportState } from '../src/ticloudExport';

describe('buildExportArgs', () => {
  it('exports one table to S3 as Parquet without a prompt', () => {
    const args = buildExportArgs({
      clusterId: 'c1',
      s3Uri: 's3://b/agent-coding/ledger/run-1',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      filter: 'agent_coding.ledger',
    });
    expect(args.slice(0, 3)).toEqual(['serverless', 'export', 'create']);
    expect(args).toEqual(expect.arrayContaining(['--file-type', 'PARQUET', '--filter', 'agent_coding.ledger', '--force']));
    expect(args[args.indexOf('--s3.uri') + 1]).toBe('s3://b/agent-coding/ledger/run-1');
  });
});

describe('parseExportId', () => {
  it('reads a JSON id', () => {
    expect(parseExportId('{"exportId":"exp-123abc"}')).toBe('exp-123abc');
  });

  it('reads a text line', () => {
    expect(parseExportId('Export task created. Export ID: exp-456def')).toBe('exp-456def');
  });

  it('throws when nothing matches', () => {
    expect(() => parseExportId('ok')).toThrow('export id not found in output');
  });
});

describe('parseExportState', () => {
  it('classifies the three outcomes', () => {
    expect(parseExportState('state: COMPLETED')).toBe('completed');
    expect(parseExportState('state: FAILED')).toBe('failed');
    expect(parseExportState('state: RUNNING')).toBe('running');
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/config.test.ts runner/test/branchEnv.test.ts runner/test/ticloudExport.test.ts
```

Expected FAIL: `Cannot find module '../src/config'` (and the same for `branchEnv` and `ticloudExport`).

`demos/agent-coding/runner/src/config.ts`:

```ts
export type RunConfig = {
  readonly runId: string;
  readonly ticket: { readonly id: string; readonly title: string };
  readonly workDir: string;
  readonly fixturesDir: string;
  readonly orgClusterId: string;
  readonly fixtureClusterId: string;
  readonly fixtureDatabase: string;
  readonly branchSqlUser: string;
  readonly branchSqlPassword: string;
  readonly branchQuota: number;
  readonly branchTimeoutMs: number;
  readonly branchPollMs: number;
  readonly stepWaitMs: number;
  readonly autoRun: boolean;
  readonly stagePauseMs: number;
  readonly freshnessTimeoutMs: number;
  readonly exportTimeoutMs: number;
  readonly executeLakeTask: boolean;
  readonly historyRuns: number;
  readonly historySeed: number;
  readonly bucket: string;
  readonly region: string;
  readonly prefix: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly lakeWarehouse: string;
  readonly lakeDatabase: string;
};

type EnvLike = Readonly<Record<string, string | undefined>>;

const required = (env: EnvLike, name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const optional = (env: EnvLike, name: string, fallback: string): string => {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
};

const numberFrom = (env: EnvLike, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
};

export const makeRunId = (date: Date): string =>
  `run-${date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;

export const runConfigFromEnv = (
  env: EnvLike,
  options: { readonly fixturesDir: string; readonly now: Date; readonly homeDir: string },
): RunConfig => ({
  runId: makeRunId(options.now),
  ticket: { id: 'KIT-8812', title: 'fix double charge on retried payments' },
  workDir: optional(env, 'WORK_DIR', `${options.homeDir}/lab-agent-coding-work`),
  fixturesDir: options.fixturesDir,
  orgClusterId: required(env, 'AGENT_ORG_CLUSTER_ID'),
  fixtureClusterId: required(env, 'AGENT_FIXTURE_CLUSTER_ID'),
  fixtureDatabase: optional(env, 'FIXTURE_DATABASE', 'fixture'),
  branchSqlUser: required(env, 'FIXTURE_SQL_USER'),
  branchSqlPassword: required(env, 'FIXTURE_SQL_PASSWORD'),
  branchQuota: numberFrom(env, 'BRANCH_QUOTA', 5),
  branchTimeoutMs: numberFrom(env, 'BRANCH_TIMEOUT_MS', 900000),
  branchPollMs: numberFrom(env, 'BRANCH_POLL_MS', 10000),
  stepWaitMs: numberFrom(env, 'STEP_WAIT_MS', 1000),
  autoRun: env.AUTO_RUN === 'true',
  stagePauseMs: numberFrom(env, 'STAGE_PAUSE_MS', 3000),
  freshnessTimeoutMs: numberFrom(env, 'LAKE_FRESHNESS_TIMEOUT_MS', 240000),
  exportTimeoutMs: numberFrom(env, 'EXPORT_TIMEOUT_MS', 300000),
  executeLakeTask: env.LAKE_EXECUTE_TASK === 'true',
  historyRuns: numberFrom(env, 'HISTORY_RUNS', 200),
  historySeed: numberFrom(env, 'HISTORY_SEED', 42),
  bucket: required(env, 'S3_BUCKET'),
  region: optional(env, 'S3_REGION', 'us-east-1'),
  prefix: optional(env, 'S3_PREFIX', 'agent-coding'),
  s3AccessKeyId: required(env, 'AWS_ACCESS_KEY_ID'),
  s3SecretAccessKey: required(env, 'AWS_SECRET_ACCESS_KEY'),
  lakeWarehouse: required(env, 'LAKE_WAREHOUSE'),
  lakeDatabase: optional(env, 'LAKE_DATABASE', 'agent_coding'),
});
```

`demos/agent-coding/runner/src/branchEnv.ts`:

```ts
type EnvLike = Readonly<Record<string, string | undefined>>;

export const branchUser = (options: { readonly userPrefix: string | undefined; readonly user: string }): string => {
  if (options.userPrefix === undefined || options.user.includes('.')) return options.user;
  return `${options.userPrefix}.${options.user}`;
};

export const branchEnv = (options: {
  readonly base: EnvLike;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}): Record<string, string> => {
  const inherited = Object.fromEntries(
    Object.entries(options.base).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    TIDB_HOST: options.host,
    TIDB_PORT: String(options.port),
    TIDB_USER: options.user,
    TIDB_PASSWORD: options.password,
    TIDB_DATABASE: options.database,
    TIDB_TLS: 'true',
    TIDB_POOL_SIZE: '2',
  };
};
```

`demos/agent-coding/runner/src/ticloudExport.ts`:

```ts
export type ExportState = 'running' | 'completed' | 'failed';

export const buildExportArgs = (options: {
  readonly clusterId: string;
  readonly s3Uri: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly filter: string;
}): readonly string[] => [
  'serverless',
  'export',
  'create',
  '--cluster-id',
  options.clusterId,
  '--target-type',
  'S3',
  '--s3.uri',
  options.s3Uri,
  '--s3.access-key-id',
  options.accessKeyId,
  '--s3.secret-access-key',
  options.secretAccessKey,
  '--file-type',
  'PARQUET',
  '--filter',
  options.filter,
  '--force',
  '--no-color',
];

export const buildExportDescribeArgs = (options: { readonly clusterId: string; readonly exportId: string }): readonly string[] => [
  'serverless',
  'export',
  'describe',
  '--cluster-id',
  options.clusterId,
  '--export-id',
  options.exportId,
  '--no-color',
];

export const parseExportId = (stdout: string): string => {
  const fromJson = /"(?:exportId|export_id|id)"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
  const fromText = /export[ _-]?id["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i.exec(stdout)?.[1];
  const found = fromJson ?? fromText;
  if (found === undefined) throw new Error(`export id not found in output: ${stdout.slice(0, 200)}`);
  return found;
};

export const parseExportState = (stdout: string): ExportState => {
  if (/\b(failed|canceled|cancelled)\b/i.test(stdout)) return 'failed';
  if (/\b(completed|succeeded|success)\b/i.test(stdout)) return 'completed';
  return 'running';
};
```

Add every real sample that 12-V2 and 12-V4 pasted into section 4 as an extra test case in `ticloudExport.test.ts` (export id, `describe` states) and `branchEnv.test.ts` (the prefix rule) before moving on. Then run the same command. Expected PASS: `Test Files  3 passed (3)` and `Tests  17 passed (17)`.
Commit:

```bash
git add demos/agent-coding/runner/src/config.ts demos/agent-coding/runner/src/branchEnv.ts demos/agent-coding/runner/src/ticloudExport.ts demos/agent-coding/runner/test/config.test.ts demos/agent-coding/runner/test/branchEnv.test.ts demos/agent-coding/runner/test/ticloudExport.test.ts
git commit -m "agent-coding demo: add configuration, branch environment and export helpers"
```

### Task 22: Run state and the teardown plan

- [ ] Not started

The runner records every resource it creates (layer ids, mount paths, branch ids, the journal id) in `state.json` as it goes, so teardown works even after a crash. `buildTeardownPlan` turns that state into the ordered CLI steps: unmount, delete every branch of the fixture instance, cascade-delete the task layer (which abandons every layer forked from it), empty the S3 prefix, and with `--destroy-instances` delete the file system and both Starter instances.

`demos/agent-coding/runner/test/state.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyState, withBranch, withJournal, withLayer, withMount, withoutMount } from '../src/state';
import { readState, writeState } from '../src/stateStore';

describe('run state', () => {
  it('records layers, mounts, branches and the journal without mutating the original', () => {
    const start = emptyState('run-1');
    const next = withJournal(
      withBranch(withMount(withLayer(start, 'lyr_1'), '/mnt/a'), { clusterId: 'c1', branchId: 'br_1' }),
      'jrn-1',
    );
    expect(start).toEqual({ runId: 'run-1', layers: [], mounts: [], branches: [] });
    expect(next).toEqual({
      runId: 'run-1',
      layers: ['lyr_1'],
      mounts: ['/mnt/a'],
      branches: [{ clusterId: 'c1', branchId: 'br_1' }],
      journalId: 'jrn-1',
    });
  });

  it('does not list a mount twice and can drop one', () => {
    const mounted = withMount(withMount(emptyState('r'), '/mnt/a'), '/mnt/a');
    expect(mounted.mounts).toEqual(['/mnt/a']);
    expect(withoutMount(mounted, '/mnt/a').mounts).toEqual([]);
  });
});

describe('state store', () => {
  it('round-trips a state file and reports a missing file as undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-coding-state-'));
    try {
      const path = join(dir, 'nested', 'state.json');
      expect(await readState(path)).toBeUndefined();
      const state = withLayer(emptyState('run-1'), 'lyr_1');
      await writeState(path, state);
      expect(await readState(path)).toEqual(state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

`demos/agent-coding/runner/test/teardownPlan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState, withBranch, withLayer, withMount } from '../src/state';
import { buildTeardownPlan } from '../src/teardownPlan';

const state = withBranch(
  withMount(withLayer(withLayer(emptyState('run-1'), 'lyr_task'), 'lyr_a1'), '/tmp/work/attempt-1'),
  { clusterId: 'fix', branchId: 'br_1' },
);

const base = {
  state,
  fixtureClusterId: 'fix',
  fixtureBranchIds: ['br_1', 'br_2'],
  orgClusterId: 'org',
  fileSystemId: 'fs-1',
  bucket: 'lab-bucket',
  prefix: '/agent-coding/',
  destroyInstances: false,
};

describe('buildTeardownPlan', () => {
  it('unmounts, deletes every fixture branch once, cascades the task layer and empties the prefix', () => {
    expect(buildTeardownPlan(base).map((step) => step.label)).toEqual([
      'unmount /tmp/work/attempt-1',
      'delete branch br_1',
      'delete branch br_2',
      'delete layer lyr_task and every layer forked from it',
      'empty s3://lab-bucket/agent-coding',
    ]);
  });

  it('uses the documented commands', () => {
    const steps = buildTeardownPlan(base);
    expect(steps[0]).toEqual({
      label: 'unmount /tmp/work/attempt-1',
      bin: 'ti',
      args: ['fs', 'unmount-file-system', '--mount-path', '/tmp/work/attempt-1', '--ignore-absent'],
    });
    expect(steps[3]?.args).toEqual(['fs', 'delete-layer', '--layer-ref', 'lyr_task', '--cascade']);
    expect(steps[4]?.args).toEqual(['s3', 'rm', 's3://lab-bucket/agent-coding', '--recursive']);
  });

  it('adds the file system and both instances only when asked', () => {
    const steps = buildTeardownPlan({ ...base, destroyInstances: true });
    expect(steps.slice(-3).map((step) => step.args)).toEqual([
      ['fs', 'delete-file-system', '--file-system-id', 'fs-1'],
      ['db', 'delete-db-cluster', '--db-cluster-id', 'fix', '--wait'],
      ['db', 'delete-db-cluster', '--db-cluster-id', 'org', '--wait'],
    ]);
  });

  it('skips the layer step when no layer was recorded', () => {
    const steps = buildTeardownPlan({ ...base, state: emptyState('run-1'), fixtureBranchIds: [] });
    expect(steps.map((step) => step.label)).toEqual(['empty s3://lab-bucket/agent-coding']);
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/state.test.ts runner/test/teardownPlan.test.ts
```

Expected FAIL: `Cannot find module '../src/state'` (and the same for `stateStore` and `teardownPlan`).

`demos/agent-coding/runner/src/state.ts`:

```ts
import { z } from 'zod';

export const RunStateSchema = z.object({
  runId: z.string().min(1),
  layers: z.array(z.string()),
  mounts: z.array(z.string()),
  branches: z.array(z.object({ clusterId: z.string(), branchId: z.string() })),
  journalId: z.string().optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;

export const emptyState = (runId: string): RunState => ({ runId, layers: [], mounts: [], branches: [] });

export const withLayer = (state: RunState, layerId: string): RunState => ({ ...state, layers: [...state.layers, layerId] });

export const withMount = (state: RunState, mountPath: string): RunState => ({
  ...state,
  mounts: state.mounts.includes(mountPath) ? state.mounts : [...state.mounts, mountPath],
});

export const withoutMount = (state: RunState, mountPath: string): RunState => ({
  ...state,
  mounts: state.mounts.filter((candidate) => candidate !== mountPath),
});

export const withBranch = (state: RunState, branch: { readonly clusterId: string; readonly branchId: string }): RunState => ({
  ...state,
  branches: [...state.branches, branch],
});

export const withJournal = (state: RunState, journalId: string): RunState => ({ ...state, journalId });
```

`demos/agent-coding/runner/src/stateStore.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RunStateSchema, type RunState } from './state';

export const readState = async (path: string): Promise<RunState | undefined> => {
  try {
    return RunStateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

export const writeState = async (path: string, state: RunState): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
};
```

`demos/agent-coding/runner/src/teardownPlan.ts`:

```ts
import type { RunState } from './state';

export type TeardownStep = {
  readonly label: string;
  readonly bin: string;
  readonly args: readonly string[];
};

export const buildTeardownPlan = (options: {
  readonly state: RunState;
  readonly fixtureClusterId: string;
  readonly fixtureBranchIds: readonly string[];
  readonly orgClusterId: string;
  readonly fileSystemId: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly destroyInstances: boolean;
}): readonly TeardownStep[] => {
  const prefix = options.prefix.replace(/^\/+|\/+$/g, '');
  const branchIds = [...new Set([...options.fixtureBranchIds, ...options.state.branches.map((branch) => branch.branchId)])];
  const taskLayer = options.state.layers[0];
  const cleanup: readonly TeardownStep[] = [
    ...options.state.mounts.map((mountPath) => ({
      label: `unmount ${mountPath}`,
      bin: 'ti',
      args: ['fs', 'unmount-file-system', '--mount-path', mountPath, '--ignore-absent'],
    })),
    ...branchIds.map((branchId) => ({
      label: `delete branch ${branchId}`,
      bin: 'ticloud',
      args: [
        'serverless',
        'branch',
        'delete',
        '--cluster-id',
        options.fixtureClusterId,
        '--branch-id',
        branchId,
        '--force',
        '--no-color',
      ],
    })),
    ...(taskLayer === undefined
      ? []
      : [
          {
            label: `delete layer ${taskLayer} and every layer forked from it`,
            bin: 'ti',
            args: ['fs', 'delete-layer', '--layer-ref', taskLayer, '--cascade'],
          },
        ]),
    {
      label: `empty s3://${options.bucket}/${prefix}`,
      bin: 'aws',
      args: ['s3', 'rm', `s3://${options.bucket}/${prefix}`, '--recursive'],
    },
  ];
  if (!options.destroyInstances) return cleanup;
  return [
    ...cleanup,
    {
      label: `delete file system ${options.fileSystemId}`,
      bin: 'ti',
      args: ['fs', 'delete-file-system', '--file-system-id', options.fileSystemId],
    },
    ...[options.fixtureClusterId, options.orgClusterId].map((clusterId) => ({
      label: `delete Starter instance ${clusterId}`,
      bin: 'ti',
      args: ['db', 'delete-db-cluster', '--db-cluster-id', clusterId, '--wait'],
    })),
  ];
};
```

Run the same command. Expected PASS: `Test Files  2 passed (2)` and `Tests  7 passed (7)`.
Commit:

```bash
git add demos/agent-coding/runner/src/state.ts demos/agent-coding/runner/src/stateStore.ts demos/agent-coding/runner/src/teardownPlan.ts demos/agent-coding/runner/test/state.test.ts demos/agent-coding/runner/test/teardownPlan.test.ts
git commit -m "agent-coding demo: add run state and teardown plan"
```

### Task 23: Push the winner to a local bare repository

- [ ] Not started

The winning attempt's tree is committed on a branch of a throwaway clone and pushed to a bare repository under the work directory. The layer itself is never committed. The test plays attempt 1 for real, pushes it and asks the bare repository which branches exist.

`demos/agent-coding/runner/test/git.test.ts`:

```ts
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '@lab/agent-stack-kit';
import { loadAttemptScripts } from '../src/fixtureStore';
import { pushWinnerBranch, remoteBranchExists } from '../src/git';
import { runAttempt } from '../src/harness';

const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));
const baselineDir = join(fixturesDir, 'payments-api');

describe('pushWinnerBranch', () => {
  it('pushes the winning attempt as a branch of a local bare repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-coding-git-'));
    try {
      const winnerDir = join(root, 'attempt-1');
      await cp(baselineDir, winnerDir, { recursive: true });
      const script = (await loadAttemptScripts(fixturesDir)).find((candidate) => candidate.attemptId === 'attempt-1');
      if (script === undefined) throw new Error('missing attempt-1');
      await runAttempt(script, { repoDir: winnerDir, fixturesDir }, async () => undefined);

      const remoteDir = join(root, 'remote.git');
      const result = await pushWinnerBranch({
        run: runCli,
        remoteDir,
        cloneDir: join(root, 'clone'),
        baselineDir,
        winnerDir,
        branch: 'fix/KIT-8812-attempt-1',
        message: 'KIT-8812: fix double charge on retried payments',
      });

      expect(result.files).toEqual(['src/charge.js', 'src/idempotency.js']);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(await remoteBranchExists(runCli, remoteDir, 'fix/KIT-8812-attempt-1')).toBe(true);
      expect(await remoteBranchExists(runCli, remoteDir, 'fix/never-pushed')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/git.test.ts
```

Expected FAIL: `Cannot find module '../src/git'`.

`demos/agent-coding/runner/src/git.ts`:

```ts
import { cp, mkdir, rm } from 'node:fs/promises';
import type { RunCli } from '@lab/agent-stack-kit';

const identity = ['-c', 'user.name=Kiteline Lab', '-c', 'user.email=lab@example.invalid'];

export const pushWinnerBranch = async (options: {
  readonly run: RunCli;
  readonly remoteDir: string;
  readonly cloneDir: string;
  readonly baselineDir: string;
  readonly winnerDir: string;
  readonly branch: string;
  readonly message: string;
}): Promise<{ readonly commit: string; readonly files: readonly string[] }> => {
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await options.run({ bin: 'git', args });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const inClone = (args: readonly string[]): Promise<string> => git(['-C', options.cloneDir, ...identity, ...args]);
  await rm(options.remoteDir, { recursive: true, force: true });
  await rm(options.cloneDir, { recursive: true, force: true });
  await mkdir(options.cloneDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', options.remoteDir]);
  await git(['init', '--initial-branch=main', options.cloneDir]);
  await cp(options.baselineDir, options.cloneDir, { recursive: true });
  await inClone(['add', '-A']);
  await inClone(['commit', '-m', 'baseline']);
  await inClone(['remote', 'add', 'origin', options.remoteDir]);
  await inClone(['push', 'origin', 'main']);
  await inClone(['checkout', '-b', options.branch]);
  await cp(options.winnerDir, options.cloneDir, { recursive: true });
  await inClone(['add', '-A']);
  await inClone(['commit', '-m', options.message]);
  await inClone(['push', 'origin', options.branch]);
  const commit = (await inClone(['rev-parse', 'HEAD'])).trim();
  const files = (await inClone(['diff', '--name-only', 'main', options.branch])).split('\n').filter((line) => line !== '');
  return { commit, files: [...files].sort() };
};

export const remoteBranchExists = async (run: RunCli, remoteDir: string, branch: string): Promise<boolean> => {
  const result = await run({ bin: 'git', args: ['--git-dir', remoteDir, 'rev-parse', '--verify', `refs/heads/${branch}`] });
  return result.code === 0;
};
```

Run the same command. Expected PASS: `Tests  1 passed (1)`.

Commit:

```bash
git add demos/agent-coding/runner/src/git.ts demos/agent-coding/runner/test/git.test.ts
git commit -m "agent-coding demo: push the winner to a local bare repository"
```

### Task 24: The whole run against in-memory stand-ins (RED)

- [ ] Not started

The stage code in Tasks 25 to 28 is thin orchestration over adapters that cannot run without cloud accounts. This test is what drives it: it runs the entire nine-phase run with in-memory stand-ins for the three services and S3 while the harness, git, tree hashing, scoring, SQL builders, checks and gates run for real. The stand-ins are small:

- a fake `tiFs` keeps layers as directories (fork copies, checkpoint snapshots, diff compares against the seed) and throws if `commitLayer` is ever called;
- a fake `branches` hands out ids and reports ACTIVE;
- a fake branch `Sql` returns a clock that moves one second per read and a fixed row count and checksum;
- a fake org `Sql` stores memories and ledger rows;
- a fake Lake answers the count, match, aggregate and similarity queries from what the fake sink received;
- a fake runner answers `ticloud` export calls and passes everything else (node, git) through.

The test parses every emitted line with `parseEventLine` and checks it with `eventReferenceErrors` against the real `manifest.json`, so a runner that emits an id the manifest does not declare fails here, not on camera. It also checks that every manifest metric, edge and node is used, that the phases come in order, that all six checks pass, that attempt 1 wins and no layer is committed, that ledger and event counts add up, that the replay branch is created from attempt 2's branch at the step's timestamp, and that arming the flaky dependency makes attempt 3 win.

`demos/agent-coding/runner/test/fakes.ts`:

```ts
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli, type BranchInfo, type Branches, type CliOptions, type CliResult, type LakeClient, type RunCli, type S3EventSink, type TiFs } from '@lab/agent-stack-kit';
import { readTree } from '../src/harness';
import type { Row, Sql } from '../src/sql';
import { changedPaths, type Tree } from '../src/tree';

export type FakeTiFs = {
  readonly tiFs: TiFs;
  readonly calls: string[];
  readonly journal: Record<string, unknown>[];
};

export const createFakeTiFs = (root: string): FakeTiFs => {
  const calls: string[] = [];
  const journal: Record<string, unknown>[] = [];
  const layers = new Map<string, string>();
  const state: { next: number; seed: Tree } = { next: 0, seed: {} };
  const newLayer = async (copyFrom: string | undefined): Promise<{ readonly layerId: string }> => {
    state.next += 1;
    const layerId = `lyr_${state.next}`;
    const dir = join(root, 'layers', layerId);
    await mkdir(dir, { recursive: true });
    if (copyFrom !== undefined) await cp(copyFrom, dir, { recursive: true });
    layers.set(layerId, dir);
    return { layerId };
  };
  const dirOf = (layerId: string): string => {
    const dir = layers.get(layerId);
    if (dir === undefined) throw new Error(`unknown layer ${layerId}`);
    return dir;
  };
  const tiFs: TiFs = {
    createLayer: async () => {
      calls.push('createLayer');
      return newLayer(undefined);
    },
    checkpoint: async (options) => {
      calls.push(`checkpoint ${options.layerId} ${options.checkpointId}`);
      const dir = dirOf(options.layerId);
      await rm(dir, { recursive: true, force: true });
      await cp(options.mountPath, dir, { recursive: true });
      const snapshot = join(root, 'cp', `${options.layerId}-${options.checkpointId}`);
      await cp(options.mountPath, snapshot, { recursive: true });
      if (options.checkpointId === 'seed') state.seed = await readTree(join(snapshot, 'payments-api'));
      return { checkpointId: options.checkpointId, drainMs: 1, checkpointMs: 2 };
    },
    forkLayer: async (options) => {
      calls.push(`forkLayer ${options.parentLayerRef} ${options.checkpointId ?? 'tip'}`);
      const source =
        options.checkpointId === undefined
          ? dirOf(options.parentLayerRef)
          : join(root, 'cp', `${options.parentLayerRef}-${options.checkpointId}`);
      return newLayer(source);
    },
    mountLayer: async (options) => {
      calls.push(`mountLayer ${options.layerRef}`);
      await mkdir(options.mountPath, { recursive: true });
      await cp(dirOf(options.layerRef), options.mountPath, { recursive: true });
    },
    unmount: async (options) => {
      calls.push(`unmount ${options.mountPath}`);
    },
    diffLayer: async (options) => {
      const tree = await readTree(join(dirOf(options.layerId), 'payments-api'));
      return changedPaths(state.seed, tree).map((path) => `/workspace/payments-api/${path}`);
    },
    commitLayer: async () => {
      calls.push('commitLayer');
      throw new Error('a coding attempt must never commit its layer');
    },
    rollbackLayer: async () => {
      calls.push('rollbackLayer');
    },
    deleteLayer: async () => {
      calls.push('deleteLayer');
    },
    grep: async () => '',
    createJournal: async (options) => {
      journal.push({ type: 'journal.created', journalId: options.journalId });
    },
    appendJournal: async (options) => {
      journal.push({ journalId: options.journalId, ...options.entry });
    },
    verifyJournal: async () => ({ ok: true }),
    createGrant: async () => 'token',
  };
  return { tiFs, calls, journal };
};

export type BranchCall = { readonly clusterId: string; readonly name: string; readonly parentId?: string; readonly parentTimestamp?: string };

export const createFakeBranches = (): { readonly branches: Branches; readonly created: BranchCall[] } => {
  const created: BranchCall[] = [];
  const info = (branchId: string): BranchInfo => ({
    branchId,
    state: 'ACTIVE',
    host: 'branch.example.test',
    port: 4000,
    userPrefix: 'pfx',
  });
  const branches: Branches = {
    create: async (options) => {
      created.push(options);
      return { branchId: `br_${created.length}`, state: 'CREATING' };
    },
    waitActive: async (options) => info(options.branchId),
    remove: async () => undefined,
    list: async () => [],
  };
  return { branches, created };
};

export const createFakeBranchSql = (): Sql => {
  const state = { seconds: 0 };
  return {
    rows: async () => {
      state.seconds += 1;
      const dbTime = new Date(Date.UTC(2026, 9, 17, 10, 0, state.seconds)).toISOString().replace('.000Z', '.250000Z');
      return [{ db_time: dbTime, row_count: '2000', checksum: '1234567890' }];
    },
    insert: async () => 0,
    exec: async () => undefined,
    end: async () => undefined,
  };
};

export type FakeOrg = {
  readonly sql: Sql;
  readonly memories: { readonly id: number; readonly kind: string; readonly content: string }[];
  readonly ledger: (readonly (string | number)[])[];
};

export const createFakeOrg = (): FakeOrg => {
  const memories: { id: number; kind: string; content: string }[] = [];
  const ledger: (readonly (string | number)[])[] = [];
  const sql: Sql = {
    rows: async (statement): Promise<readonly Row[]> => {
      if (statement.includes('COUNT(*) AS n FROM memories')) return [{ n: memories.length }];
      if (statement.includes('COUNT(*) AS n FROM ledger')) return [{ n: ledger.length }];
      if (statement.startsWith('WITH')) return [...memories].reverse().slice(0, 3);
      return [];
    },
    insert: async (statement, params) => {
      if (statement.includes('INTO memories')) {
        const id = memories.length + 1;
        memories.push({ id, kind: String(params[0]), content: String(params[1]) });
        return id;
      }
      ledger.push(params);
      return 0;
    },
    exec: async () => undefined,
    end: async () => undefined,
  };
  return { sql, memories, ledger };
};

export const createFakeSink = (): { readonly sink: S3EventSink; readonly lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      write: async (batch) => {
        lines.push(...batch);
        return { key: `events/${lines.length}.ndjson` };
      },
    },
  };
};

export const createFakeLake = (options: { readonly lines: readonly string[]; readonly ledgerRows: () => number }): LakeClient => ({
  query: async (statement) => {
    if (statement.includes("kind = 'marker'")) return [{ n: 1 }];
    if (statement.includes('FROM run_events WHERE run_id')) {
      const runId = /run_id = '([^']+)'/.exec(statement)?.[1];
      return [{ n: options.lines.filter((line) => line.includes(`"run_id":"${runId}"`)).length }];
    }
    if (statement.includes('FROM ledger_lake WHERE run_id')) return [{ n: options.ledgerRows() }];
    if (statement.includes("MATCH(message, 'ECONNRESET')")) return [{ matches: 12, runs: 7 }];
    if (statement.includes('GROUP BY model')) return [{ model: 'fixture-model-a', merged_per_dollar: 4.2 }];
    if (statement.includes('COSINE_DISTANCE')) return [{ distance: 0.12, message: 'ECONNRESET at step 7: connect ECONNRESET' }];
    return [];
  },
});

export const createFakeRun = (): RunCli => async (command: CliOptions): Promise<CliResult> => {
  if (command.bin === 'ticloud' && command.args.includes('create')) return { code: 0, stdout: '{"exportId":"exp-abc123"}', stderr: '' };
  if (command.bin === 'ticloud') return { code: 0, stdout: 'state: COMPLETED', stderr: '' };
  return runCli(command);
};
```

`demos/agent-coding/runner/test/runner.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rfc3339Second, runCli } from '@lab/agent-stack-kit';
import { DemoManifestSchema, eventReferenceErrors, parseEventLine, type DemoEvent } from '@lab/contract';
import { createEmitter } from '@lab/runner-kit';
import manifestJson from '../../manifest.json';
import { runConfigFromEnv } from '../src/config';
import { loadAttemptScripts } from '../src/fixtureStore';
import { createRunner } from '../src/runner';
import {
  createFakeBranches,
  createFakeBranchSql,
  createFakeLake,
  createFakeOrg,
  createFakeRun,
  createFakeSink,
  createFakeTiFs,
} from './fakes';

const manifest = DemoManifestSchema.parse(manifestJson);
const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));

const env = {
  AGENT_ORG_CLUSTER_ID: 'org-1',
  AGENT_FIXTURE_CLUSTER_ID: 'fix-1',
  FIXTURE_SQL_USER: 'reader',
  FIXTURE_SQL_PASSWORD: 'pw',
  S3_BUCKET: 'lab-bucket',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  LAKE_WAREHOUSE: 'agent-coding-wh',
  STEP_WAIT_MS: '0',
  STAGE_PAUSE_MS: '0',
  HISTORY_RUNS: '5',
};

const play = async (options: { readonly autoRun: boolean; readonly controls: readonly string[] }) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-coding-run-'));
  try {
    const config = runConfigFromEnv(
      { ...env, WORK_DIR: join(root, 'work'), AUTO_RUN: options.autoRun ? 'true' : 'false' },
      { fixturesDir, now: new Date('2026-10-17T10:00:00Z'), homeDir: root },
    );
    const lines: string[] = [];
    const fs = createFakeTiFs(join(root, 'fake-fs'));
    const fakeBranches = createFakeBranches();
    const org = createFakeOrg();
    const sink = createFakeSink();
    const saved: unknown[] = [];
    const runner = createRunner({
      config,
      env: { TIDB_DATABASE: 'agent_coding' },
      emitter: createEmitter({ write: (line) => lines.push(line) }),
      orgPool: org.sql,
      tiFs: fs.tiFs,
      branches: fakeBranches.branches,
      lake: createFakeLake({ lines: sink.lines, ledgerRows: () => org.ledger.length }),
      lakeBootstrap: createFakeLake({ lines: sink.lines, ledgerRows: () => 0 }),
      sink: sink.sink,
      run: createFakeRun(),
      scripts: await loadAttemptScripts(fixturesDir),
      sleep: async () => undefined,
      openBranchPool: () => createFakeBranchSql(),
      saveState: async (state) => {
        saved.push(state);
      },
    });
    await runner.start();
    options.controls.forEach((control) => runner.onControl(control));
    await runner.idle();
    const events: DemoEvent[] = lines.flatMap((line) => {
      const parsed = parseEventLine(line);
      return parsed.ok ? [parsed.event] : [];
    });
    const remote = join(config.workDir, 'remote.git');
    const refs = await runCli({ bin: 'git', args: ['--git-dir', remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'] });
    return {
      lines,
      events,
      fs,
      org,
      sink,
      created: fakeBranches.created,
      pushedBranches: refs.stdout.split('\n').filter((name) => name !== '').sort(),
      saved,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const lastCheckStatuses = (events: readonly DemoEvent[]): Record<string, string> =>
  Object.fromEntries(events.flatMap((event) => (event.type === 'check' ? [[event.id, event.status]] : [])));

describe('the whole run against in-memory stand-ins for the three services', () => {
  it('emits only ids that the manifest declares and every line parses', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.events).toHaveLength(run.lines.length);
    expect(run.events.flatMap((event) => eventReferenceErrors(manifest, event))).toEqual([]);
  });

  it('walks the nine phases in order', async () => {
    const run = await play({ autoRun: true, controls: [] });
    const phases = run.events.flatMap((event) => (event.type === 'phase' ? [event.phase] : []));
    expect([...new Set(phases)]).toEqual(manifest.phases.map((phase) => phase.id));
  });

  it('emits every metric, every edge and a status for every node', async () => {
    const run = await play({ autoRun: true, controls: [] });
    const metrics = new Set(run.events.flatMap((event) => (event.type === 'metric' ? [event.id] : [])));
    const edges = new Set(run.events.flatMap((event) => (event.type === 'flow' ? [event.edge] : [])));
    const nodes = new Set(run.events.flatMap((event) => (event.type === 'node' ? [event.node] : [])));
    expect(manifest.metrics.map((metric) => metric.id).filter((id) => !metrics.has(id))).toEqual([]);
    expect(manifest.edges.map((edge) => edge.id).filter((id) => !edges.has(id))).toEqual([]);
    expect(manifest.nodes.map((node) => node.id).filter((id) => !nodes.has(id))).toEqual([]);
  });

  it('passes every check', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(lastCheckStatuses(run.events)).toEqual({
      'layer-isolation': 'pass',
      'fork-branches-identical': 'pass',
      'journal-verified': 'pass',
      'replay-reproduces': 'pass',
      'lake-count-matches': 'pass',
      'lesson-recalled': 'pass',
    });
  });

  it('opens a pull request for attempt 1 and never commits a layer', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.pushedBranches).toEqual(['fix/KIT-8812-attempt-1', 'main']);
    expect(run.fs.calls).not.toContain('commitLayer');
  });

  it('writes one ledger row per step and one event per step plus finishes and a marker', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.org.ledger).toHaveLength(7 + 7 + 9);
    const live = run.sink.lines.filter((line) => line.includes('"source":"live"'));
    expect(live).toHaveLength(7 + 7 + 9 + 3 + 1);
    const lastEmitted = run.events.filter((event) => event.type === 'metric' && event.id === 'events-emitted').at(-1);
    expect(lastEmitted).toMatchObject({ value: 27 });
  });

  it('creates three attempt branches and a replay branch at the step timestamp', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.created).toHaveLength(4);
    const replay = run.created[3];
    expect(replay?.name).toBe('run-20261017-100000-replay');
    expect(replay?.parentId).toBe('br_2');
    expect(replay?.parentTimestamp).toBe(rfc3339Second('2026-10-17T10:00:08.250Z'));
  });

  it('forks the replay layer from the failed attempt step-07 checkpoint', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.fs.calls.filter((call) => call.startsWith('forkLayer'))).toEqual([
      'forkLayer lyr_1 seed',
      'forkLayer lyr_1 seed',
      'forkLayer lyr_1 seed',
      'forkLayer lyr_3 step-07',
    ]);
  });

  it('journals the run and writes a lesson that mentions the failed attempt', async () => {
    const run = await play({ autoRun: true, controls: [] });
    const types = run.fs.journal.map((entry) => entry.type);
    expect(types).toEqual(expect.arrayContaining(['run.started', 'memory.recalled', 'step.completed', 'pr.pushed', 'step.replayed', 'lesson.written']));
    const lesson = run.org.memories.find((memory) => memory.kind === 'lesson');
    expect(lesson?.content).toContain('attempt-2 failed at step 7 with ECONNRESET');
  });

  it('lets attempt 3 win when the flaky dependency takes attempt 1 down', async () => {
    const run = await play({ autoRun: false, controls: ['inject-flaky-dependency', 'fan-out'] });
    expect(run.pushedBranches).toEqual(['fix/KIT-8812-attempt-3', 'main']);
  });

  it('refuses a replay before the fan-out and says why', async () => {
    const run = await play({ autoRun: false, controls: ['replay-failed-step'] });
    expect(run.events.some((event) => event.type === 'log' && event.msg === 'replay-failed-step: press fan-out first')).toBe(true);
    expect(run.fs.calls.filter((call) => call.startsWith('forkLayer'))).toEqual([]);
  });

  it('records state after each resource is created', async () => {
    const run = await play({ autoRun: true, controls: [] });
    expect(run.saved.length).toBeGreaterThan(5);
  });
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/runner.test.ts
```

Expected FAIL: `Cannot find module '../src/runner'`.

Commit nothing yet: the test and stand-ins are committed together with the runner in Task 29, so no commit on the branch has a red suite.

### Task 25: The SQL wrapper and the run context

- [ ] Not started

Stages talk to Starter through a four-method `Sql` interface (`rows`, `insert`, `exec`, `end`) so the stand-ins in Task 24 can replace it; `fromMysql` adapts the pool that `createTidbPool` returns. `Deps` is everything a stage may touch, `Memory` is the mutable run state a run needs (layer ids, attempts, ledger entries, the winner, the replay branch). The module-level mutation is confined to `Memory` and the attempt records, the way any long-running orchestration shell must hold state; every value it points to (arrays, results, state) is replaced wholesale, never edited in place.

`demos/agent-coding/runner/src/sql.ts`:

```ts
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { createTidbPool } from '@lab/runner-kit';

export type Row = Readonly<Record<string, unknown>>;

export type Sql = {
  readonly rows: (sql: string, params?: readonly unknown[]) => Promise<readonly Row[]>;
  readonly insert: (sql: string, params: readonly (string | number)[]) => Promise<number>;
  readonly exec: (sql: string, params?: readonly unknown[]) => Promise<void>;
  readonly end: () => Promise<void>;
};

export const fromMysql = (pool: ReturnType<typeof createTidbPool>): Sql => ({
  rows: async (sql, params = []) => {
    const [rows] = await pool.query<RowDataPacket[]>(sql, [...params]);
    return rows;
  },
  insert: async (sql, params) => {
    const [result] = await pool.execute<ResultSetHeader>(sql, [...params]);
    return result.insertId;
  },
  exec: async (sql, params = []) => {
    await pool.query(sql, [...params]);
  },
  end: () => pool.end(),
});
```

`demos/agent-coding/runner/src/context.ts`:

```ts
import type { Emitter } from '@lab/runner-kit';
import type { Branches, BranchInfo, LakeClient, RunCli, S3EventSink, TiFs } from '@lab/agent-stack-kit';
import type { RunConfig } from './config';
import type { StepRecord } from './checks';
import type { StepOutcome } from './harness';
import type { AttemptResult } from './score';
import type { AttemptScript } from './scripts';
import type { RunState } from './state';
import type { Sql } from './sql';
import type { Tree } from './tree';

export type Deps = {
  readonly config: RunConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly emitter: Emitter;
  readonly orgPool: Sql;
  readonly tiFs: TiFs;
  readonly branches: Branches;
  readonly lake: LakeClient;
  readonly lakeBootstrap: LakeClient;
  readonly sink: S3EventSink;
  readonly run: RunCli;
  readonly scripts: readonly AttemptScript[];
  readonly sleep: (ms: number) => Promise<void>;
  readonly openBranchPool: (branch: BranchInfo) => Sql;
  readonly saveState: (state: RunState) => Promise<void>;
};

export type AttemptRuntime = {
  readonly script: AttemptScript;
  readonly mountPath: string;
  readonly repoDir: string;
  layerId: string;
  branchId: string;
  branchReady: Promise<BranchInfo> | undefined;
  pool: Sql | undefined;
  outcomes: readonly StepOutcome[];
  changedFiles: readonly string[];
};

export type StepEntry = StepRecord & { readonly dbTime: string };

export type Memory = {
  state: RunState;
  taskLayerId: string;
  journalId: string;
  baselineTree: Tree;
  attempts: readonly AttemptRuntime[];
  stepEntries: ReadonlyMap<string, StepEntry>;
  injectFault: boolean;
  done: readonly string[];
  results: readonly AttemptResult[];
  winner: AttemptResult | undefined;
  replayTarget: { readonly attemptId: string; readonly haltedAtStep: number } | undefined;
  replayBranch: Promise<BranchInfo> | undefined;
  eventsEmitted: number;
  firstEventWrittenAtMs: number | undefined;
  failureMessage: string | undefined;
  replayVerified: boolean | undefined;
  lessonId: number | undefined;
};

export const createMemory = (state: RunState): Memory => ({
  state,
  taskLayerId: '',
  journalId: '',
  baselineTree: {},
  attempts: [],
  stepEntries: new Map(),
  injectFault: false,
  done: [],
  results: [],
  winner: undefined,
  replayTarget: undefined,
  replayBranch: undefined,
  eventsEmitted: 0,
  firstEventWrittenAtMs: undefined,
  failureMessage: undefined,
  replayVerified: undefined,
  lessonId: undefined,
});

export type Stage = { readonly deps: Deps; readonly memory: Memory };

export const injectedFaultTarget = 'attempt-1';

export const isInjected = (memory: Memory, attemptId: string): boolean =>
  memory.injectFault && attemptId === injectedFaultTarget;

export const stepKey = (attemptId: string, step: number): string => `${attemptId}:${step}`;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding typecheck
```

Expected: `tsc` reports errors only in `runner/test/runner.test.ts` (the missing `../src/runner` module, and the implicit `any` that follows from it). No error in any file under `runner/src/` or in `runner/test/fakes.ts`.

### Task 26: Stages: setup, intake recall and the seed checkpoint

- [ ] Not started

`setup` is where the minutes of branch creation are hidden: it checks branch headroom with `assertBranchHeadroom`, starts three `branches.create` calls and moves on without waiting (each branch records its id in `state.json` the moment it exists), creates the Starter tables, seeds org memory once, creates the Lake objects (statement by statement, in order, ending with the `ALTER TASK ... RESUME` that starts the warehouse's billing clock), loads the synthetic history to S3 and Lake, then creates the task layer and the journal. `intakeMemoryRecall` times the hybrid statement. `seedCheckpoint` mounts the task layer, copies the fixture repo into it, drains and checkpoints as `seed`, and unmounts so the same writable layer is never mounted twice.

`demos/agent-coding/runner/src/stages/setup.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { timed } from '@lab/runner-kit';
import { errorMessage, type AttemptRuntime, type Stage } from '../context';
import { assertBranchHeadroom } from '../gates';
import { chunk } from '../fixtureData';
import { failureRows, generateHistory } from '../history';
import { buildFailureInsert, lakeBootstrapStatements, lakeSetupStatements } from '../lakeSql';
import { withBranch, withJournal, withLayer } from '../state';
import { createLedgerSql, createMemoriesSql, insertMemorySql, seedMemories } from '../starterSql';

const startAttemptBranch = (stage: Stage, attempt: AttemptRuntime): void => {
  const { deps, memory } = stage;
  const { config, emitter, branches } = deps;
  const startedAt = Date.now();
  const ready = (async () => {
    const created = await branches.create({
      clusterId: config.fixtureClusterId,
      name: `${config.runId}-${attempt.script.attemptId}`,
    });
    attempt.branchId = created.branchId;
    memory.state = withBranch(memory.state, { clusterId: config.fixtureClusterId, branchId: created.branchId });
    await deps.saveState(memory.state);
    emitter.log('info', `${attempt.script.attemptId}: branch ${created.branchId} requested (${created.state})`, 'fixture-db');
    const active = await branches.waitActive({
      clusterId: config.fixtureClusterId,
      branchId: created.branchId,
      timeoutMs: config.branchTimeoutMs,
      pollMs: config.branchPollMs,
    });
    emitter.metric('branch-create-s', (Date.now() - startedAt) / 1000);
    emitter.log('info', `${attempt.script.attemptId}: branch ${created.branchId} is ACTIVE`, 'fixture-db');
    return active;
  })();
  ready.catch((error: unknown) => emitter.log('error', `${attempt.script.attemptId}: branch failed: ${errorMessage(error)}`, 'fixture-db'));
  attempt.branchReady = ready;
};

const loadHistory = async (stage: Stage): Promise<void> => {
  const { config, emitter, sink, lake } = stage.deps;
  const events = generateHistory({ seed: config.historySeed, runs: config.historyRuns, endMs: Date.now() });
  await Promise.all(chunk(events, 500).map((batch) => sink.write(batch.map((event) => JSON.stringify(event)))));
  await Promise.all(chunk(failureRows(events), 40).map((batch) => lake.query(buildFailureInsert(batch))));
  emitter.flow('events-out', events.length);
  emitter.log('info', `loaded ${events.length} synthetic history rows (labelled synthetic-history)`, 's3-events');
};

export const setup = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, orgPool, tiFs, branches, lake, lakeBootstrap } = deps;
  emitter.phase('setup');
  ['harness', 'fixture-repo', 'filesystem', 'fixture-db', 'org-memory', 'ledger', 's3-events', 'lake', 'eval'].forEach((node) =>
    emitter.node(node, 'starting'),
  );
  await mkdir(config.workDir, { recursive: true });

  const existing = await branches.list({ clusterId: config.fixtureClusterId });
  assertBranchHeadroom({ existing: existing.length, needed: deps.scripts.length + 1, quota: config.branchQuota });

  const attempts: readonly AttemptRuntime[] = deps.scripts.map((script) => ({
    script,
    mountPath: join(config.workDir, script.attemptId),
    repoDir: join(config.workDir, script.attemptId, 'payments-api'),
    layerId: '',
    branchId: '',
    branchReady: undefined,
    pool: undefined,
    outcomes: [],
    changedFiles: [],
  }));
  memory.attempts = attempts;
  attempts.forEach((attempt) => startAttemptBranch(stage, attempt));
  emitter.node('fixture-db', 'busy', `creating ${attempts.length} attempt branches (takes minutes)`);

  await orgPool.exec(createMemoriesSql);
  await orgPool.exec(createLedgerSql);
  const [counted] = await orgPool.rows('SELECT COUNT(*) AS n FROM memories');
  if (Number(counted?.n ?? 0) === 0) {
    await Promise.all(seedMemories.map((text) => orgPool.insert(insertMemorySql, ['org', text])));
    emitter.log('info', `seeded ${seedMemories.length} org memories`, 'org-memory');
  }
  emitter.node('org-memory', 'healthy');
  emitter.node('ledger', 'healthy');

  await Promise.all(lakeBootstrapStatements({ database: config.lakeDatabase }).map((sql) => lakeBootstrap.query(sql)));
  const { ms: lakeMs } = await timed(async () => {
    const statements = lakeSetupStatements({
      warehouse: config.lakeWarehouse,
      database: config.lakeDatabase,
      bucket: config.bucket,
      prefix: `${config.prefix}/${config.runId}`,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    });
    await statements.reduce<Promise<void>>(async (previous, sql) => {
      await previous;
      await lake.query(sql);
    }, Promise.resolve());
  });
  emitter.log('info', `Lake objects ready in ${Math.round(lakeMs)} ms; task ingest_run_events resumed`, 'lake');
  await loadHistory(stage);
  emitter.node('lake', 'healthy');
  emitter.node('s3-events', 'healthy');
  emitter.node('eval', 'idle');

  const layer = await tiFs.createLayer({
    baseRootPath: '/workspace',
    layerName: `task-${config.ticket.id.toLowerCase()}-${config.runId}`,
    tags: { ticket: config.ticket.id, run: config.runId },
  });
  memory.taskLayerId = layer.layerId;
  memory.state = withLayer(memory.state, layer.layerId);
  memory.journalId = config.runId;
  memory.state = withJournal(memory.state, memory.journalId);
  await deps.saveState(memory.state);
  await tiFs.createJournal({ journalId: memory.journalId, journalKind: 'agent', title: `${config.ticket.id} ${config.ticket.title}` });
  await tiFs.appendJournal({
    journalId: memory.journalId,
    entry: { type: 'run.started', subjects: [`ticket:${config.ticket.id}`], summary: { runId: config.runId } },
    idempotencyKey: `${config.runId}-started`,
  });
  emitter.node('filesystem', 'healthy', `task layer ${layer.layerId}`);
  emitter.node('fixture-repo', 'healthy');
  emitter.node('harness', 'healthy');
  emitter.log('info', `task layer ${layer.layerId}, journal ${memory.journalId}`, 'filesystem');
};
```

`demos/agent-coding/runner/src/stages/intake.ts`:

```ts
import { timed } from '@lab/runner-kit';
import type { Stage } from '../context';
import { intakeQuery } from '../lesson';
import { buildHybridSearch, parseMemoryHits } from '../starterSql';

export const intakeMemoryRecall = async ({ deps, memory }: Stage): Promise<void> => {
  const { config, emitter, orgPool, tiFs } = deps;
  emitter.phase('intake-memory-recall');
  emitter.node('org-memory', 'busy', 'hybrid recall');
  const query = buildHybridSearch({ text: intakeQuery(config.ticket), limit: 3 });
  const { value, ms } = await timed(() => orgPool.rows(query.sql, query.params));
  const hits = parseMemoryHits(value);
  emitter.metric('hybrid-search-ms', ms);
  emitter.flow('recall', hits.length);
  hits.forEach((hit, index) => emitter.log('info', `recall ${index + 1} (${hit.kind}): ${hit.content}`, 'org-memory'));
  emitter.node('org-memory', 'healthy', `${hits.length} memories recalled`);
  await tiFs.appendJournal({
    journalId: memory.journalId,
    entry: { type: 'memory.recalled', subjects: [`ticket:${config.ticket.id}`], summary: { hits: hits.map((hit) => hit.id) } },
    idempotencyKey: `${config.runId}-recalled`,
  });
};
```

`demos/agent-coding/runner/src/stages/seed.ts`:

```ts
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stage } from '../context';
import { readTree } from '../harness';
import { withMount, withoutMount } from '../state';

export const seedCheckpoint = async ({ deps, memory }: Stage): Promise<void> => {
  const { config, emitter, tiFs } = deps;
  emitter.phase('seed-checkpoint');
  const mountPath = join(config.workDir, 'task');
  const baselineDir = join(config.fixturesDir, 'payments-api');
  await mkdir(mountPath, { recursive: true });
  await tiFs.mountLayer({ mountPath, layerRef: memory.taskLayerId, remotePath: '/workspace' });
  memory.state = withMount(memory.state, mountPath);
  await deps.saveState(memory.state);
  emitter.node('filesystem', 'busy', 'seeding the task layer');
  await cp(baselineDir, join(mountPath, 'payments-api'), { recursive: true });
  memory.baselineTree = await readTree(baselineDir);
  emitter.flow('seed-repo', Object.keys(memory.baselineTree).length);
  const checkpoint = await tiFs.checkpoint({
    layerId: memory.taskLayerId,
    mountPath,
    checkpointId: 'seed',
    label: `${config.ticket.id} seed`,
  });
  emitter.metric('checkpoint-ms', checkpoint.drainMs + checkpoint.checkpointMs);
  emitter.flow('layer-io', 2);
  emitter.log('info', `checkpoint ${checkpoint.checkpointId}: drain ${Math.round(checkpoint.drainMs)} ms, checkpoint ${Math.round(checkpoint.checkpointMs)} ms`, 'filesystem');
  await tiFs.unmount({ mountPath });
  memory.state = withoutMount(memory.state, mountPath);
  await deps.saveState(memory.state);
  emitter.node('filesystem', 'healthy', 'seed checkpoint recorded');
};
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding typecheck
```

Expected: the same two errors as Task 25 and no others.

### Task 27: Stages: fan-out, work loop and the winner

- [ ] Not started

`fanOut` forks and mounts three layers in parallel from `seed`, waits for the three branch promises, opens a pool per branch and takes the first snapshot of each, then emits the `fork-branches-identical` check. `workLoop` plays the three scripts in parallel; after every step it drains and checkpoints `step-NN`, reads the branch's clock and checksum, hashes the working tree, then writes the ledger row, the event and the journal entry together and waits `STEP_WAIT_MS` (one second by default, so consecutive steps never share a whole second). When the loop ends it scores the attempts, picks the winner, writes the `attempt.finished` events (with the merged flag), runs the layer-isolation check from `diffLayer`, and starts the replay branch right away if an attempt halted, so its creation overlaps with the rest of the run. `winnerPr` pushes the winner and verifies the journal; it never calls `commitLayer`.

`demos/agent-coding/runner/src/stages/fanout.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { timed } from '@lab/runner-kit';
import { injectedFaultTarget, type AttemptRuntime, type Stage } from '../context';
import { snapshotsVerdict } from '../checks';
import { buildSnapshotSql, parseSnapshotRow, type BranchSnapshot } from '../snapshot';
import { withLayer, withMount } from '../state';

const firstRow = <T>(rows: readonly T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error('query returned no rows');
  return row;
};

const forkAndMount = async ({ deps, memory }: Stage, attempt: AttemptRuntime): Promise<void> => {
  const { config, emitter, tiFs } = deps;
  const { value, ms } = await timed(() =>
    tiFs.forkLayer({
      parentLayerRef: memory.taskLayerId,
      layerName: `${attempt.script.attemptId}-${config.runId}`,
      checkpointId: 'seed',
      actorId: attempt.script.attemptId,
    }),
  );
  attempt.layerId = value.layerId;
  memory.state = withLayer(memory.state, value.layerId);
  emitter.metric('fork-layer-ms', ms);
  emitter.flow('layer-io', 1);
  await mkdir(attempt.mountPath, { recursive: true });
  await tiFs.mountLayer({ mountPath: attempt.mountPath, layerRef: value.layerId, remotePath: '/workspace' });
  memory.state = withMount(memory.state, attempt.mountPath);
  await deps.saveState(memory.state);
  emitter.log('info', `${attempt.script.attemptId}: layer ${value.layerId} forked from seed in ${Math.round(ms)} ms`, 'filesystem');
};

const snapshotOf = async (stage: Stage, attempt: AttemptRuntime): Promise<readonly [string, BranchSnapshot]> => {
  const { deps } = stage;
  const info = await attempt.branchReady;
  if (info === undefined) throw new Error(`${attempt.script.attemptId} has no branch`);
  attempt.pool = deps.openBranchPool(info);
  const snapshot = parseSnapshotRow(firstRow(await attempt.pool.rows(buildSnapshotSql(deps.config.fixtureDatabase))));
  deps.emitter.flow('branch-reads', 1);
  return [attempt.script.attemptId, snapshot];
};

export const fanOut = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { emitter } = deps;
  emitter.phase('fan-out');
  emitter.check('fork-branches-identical', 'pending');
  if (memory.injectFault) emitter.log('warn', `flaky dependency armed: ${injectedFaultTarget} will hit a gateway reset at its first verification`, 'harness');
  emitter.node('filesystem', 'busy', `forking ${memory.attempts.length} attempt layers`);
  await Promise.all(memory.attempts.map((attempt) => forkAndMount(stage, attempt)));
  emitter.node('filesystem', 'healthy', 'attempt layers mounted');
  emitter.node('fixture-db', 'busy', 'waiting for attempt branches');
  const snapshots = await Promise.all(memory.attempts.map((attempt) => snapshotOf(stage, attempt)));
  emitter.node('fixture-db', 'healthy', `${snapshots.length} branches ACTIVE`);
  const verdict = snapshotsVerdict(Object.fromEntries(snapshots));
  emitter.check('fork-branches-identical', verdict.pass ? 'pass' : 'fail', verdict.observed);
};
```

`demos/agent-coding/runner/src/stages/workloop.ts`:

```ts
import { rfc3339Second } from '@lab/agent-stack-kit';
import type { AttemptRuntime, Stage, StepEntry } from '../context';
import { isInjected, stepKey } from '../context';
import { isolationVerdict } from '../checks';
import { attemptFinishedEvent, stepEvent, type RunEvent } from '../events';
import { readTree, runAttempt, type StepOutcome } from '../harness';
import { pickReplayTarget, pickWinner, scoreAttempt, type AttemptResult } from '../score';
import { pathOwners } from '../scripts';
import { buildSnapshotSql, parseSnapshotRow } from '../snapshot';
import { insertLedgerSql } from '../starterSql';
import { changedPaths, treeHash } from '../tree';
import { withBranch } from '../state';

const pad = (step: number): string => String(step).padStart(2, '0');

const emitRunEvent = async ({ deps, memory }: Stage, event: RunEvent): Promise<void> => {
  await deps.sink.write([JSON.stringify(event)]);
  memory.eventsEmitted += 1;
  memory.firstEventWrittenAtMs ??= Date.now();
  deps.emitter.flow('events-out', 1);
  deps.emitter.metric('events-emitted', memory.eventsEmitted);
};

const afterStep = async (stage: Stage, attempt: AttemptRuntime, outcome: StepOutcome): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, tiFs, orgPool } = deps;
  const pool = attempt.pool;
  if (pool === undefined) throw new Error(`${attempt.script.attemptId} has no branch pool`);
  const checkpointId = `step-${pad(outcome.step)}`;
  const checkpoint = await tiFs.checkpoint({ layerId: attempt.layerId, mountPath: attempt.mountPath, checkpointId });
  emitter.metric('checkpoint-ms', checkpoint.drainMs + checkpoint.checkpointMs);
  emitter.flow('layer-io', 2);
  const snapshot = parseSnapshotRow((await pool.rows(buildSnapshotSql(config.fixtureDatabase)))[0] ?? {});
  emitter.flow('branch-reads', 1);
  const hash = treeHash(await readTree(attempt.repoDir));
  const entry: StepEntry = {
    failing: outcome.test?.failing ?? [],
    signature: outcome.test?.signature,
    treeHash: hash,
    checksum: snapshot.checksum,
    dbTime: snapshot.dbTime,
  };
  memory.stepEntries = new Map([...memory.stepEntries, [stepKey(attempt.script.attemptId, outcome.step), entry]]);
  await Promise.all([
    orgPool.insert(insertLedgerSql, [
      config.runId,
      attempt.script.attemptId,
      outcome.step,
      checkpointId,
      snapshot.dbTime,
      hash,
      snapshot.checksum,
      snapshot.rowCount,
    ]),
    emitRunEvent(stage, stepEvent({ runId: config.runId, script: attempt.script, outcome, nowMs: Date.now() })),
    tiFs.appendJournal({
      journalId: memory.journalId,
      entry: {
        type: 'step.completed',
        status: outcome.halted ? 'failed' : 'ok',
        subjects: [`attempt:${attempt.script.attemptId}`],
        summary: { step: outcome.step, kind: outcome.kind, checkpointId },
      },
      idempotencyKey: `${config.runId}-${attempt.script.attemptId}-${checkpointId}`,
    }),
  ]);
  emitter.flow('step-ledger', 1);
  emitter.log(
    'info',
    `${attempt.script.attemptId} step ${outcome.step} ${outcome.kind}: ${outcome.note}${outcome.test === undefined ? '' : outcome.test.passed ? ' (tests pass)' : ` (${outcome.test.failing.length} failing, ${outcome.test.signature ?? 'unknown'})`}`,
    'harness',
  );
  await deps.sleep(config.stepWaitMs);
};

const passedLastStep = (outcomes: readonly StepOutcome[]): boolean => {
  const last = outcomes.at(-1);
  return last !== undefined && !last.halted && last.test?.passed === true;
};

const playAttempt = async (stage: Stage, attempt: AttemptRuntime): Promise<void> => {
  const { deps, memory } = stage;
  attempt.outcomes = await runAttempt(
    attempt.script,
    { repoDir: attempt.repoDir, fixturesDir: deps.config.fixturesDir, run: deps.run, injectedFault: isInjected(memory, attempt.script.attemptId) },
    (outcome) => afterStep(stage, attempt, outcome),
  );
  attempt.changedFiles = changedPaths(memory.baselineTree, await readTree(attempt.repoDir));
};

const startReplayBranch = (stage: Stage, attempt: AttemptRuntime, entry: StepEntry): void => {
  const { deps, memory } = stage;
  const { config, emitter, branches } = deps;
  const startedAt = Date.now();
  const ready = (async () => {
    const created = await branches.create({
      clusterId: config.fixtureClusterId,
      name: `${config.runId}-replay`,
      parentId: attempt.branchId,
      parentTimestamp: rfc3339Second(entry.dbTime),
    });
    memory.state = withBranch(memory.state, { clusterId: config.fixtureClusterId, branchId: created.branchId });
    await deps.saveState(memory.state);
    const active = await branches.waitActive({
      clusterId: config.fixtureClusterId,
      branchId: created.branchId,
      timeoutMs: config.branchTimeoutMs,
      pollMs: config.branchPollMs,
    });
    emitter.metric('branch-create-s', (Date.now() - startedAt) / 1000);
    emitter.log('info', `replay branch ${created.branchId} ACTIVE (point in time ${rfc3339Second(entry.dbTime)})`, 'fixture-db');
    return active;
  })();
  ready.catch((error: unknown) => emitter.log('error', `replay branch failed: ${error instanceof Error ? error.message : String(error)}`, 'fixture-db'));
  memory.replayBranch = ready;
};

export const workLoop = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, tiFs } = deps;
  emitter.phase('work-loop');
  emitter.check('layer-isolation', 'pending');
  emitter.node('harness', 'busy', `${memory.attempts.length} attempts in parallel`);
  await Promise.all(memory.attempts.map((attempt) => playAttempt(stage, attempt)));

  memory.results = memory.attempts.map((attempt): AttemptResult => ({
    attemptId: attempt.script.attemptId,
    passed: passedLastStep(attempt.outcomes),
    changedFiles: attempt.changedFiles.length,
    steps: attempt.outcomes.length,
  }));
  memory.winner = pickWinner(memory.results);
  memory.results.forEach((result) =>
    emitter.log(
      result.passed ? 'info' : 'warn',
      `${result.attemptId}: ${result.passed ? 'tests pass' : 'failed'}, ${result.changedFiles} files changed, ${result.steps} steps, score ${scoreAttempt(result)} (formula, modeled)`,
      'harness',
    ),
  );
  await Promise.all(
    memory.attempts.map((attempt) =>
      emitRunEvent(
        stage,
        attemptFinishedEvent({
          runId: config.runId,
          script: attempt.script,
          outcomes: attempt.outcomes,
          merged: memory.winner?.attemptId === attempt.script.attemptId,
          nowMs: Date.now(),
        }),
      ),
    ),
  );

  const diffs = Object.fromEntries(
    await Promise.all(
      memory.attempts.map(async (attempt): Promise<readonly [string, readonly string[]]> => [
        attempt.script.attemptId,
        await tiFs.diffLayer({ layerId: attempt.layerId }),
      ]),
    ),
  );
  const isolation = isolationVerdict({ diffs, owners: pathOwners(deps.scripts) });
  emitter.check('layer-isolation', isolation.pass ? 'pass' : 'fail', isolation.observed);

  const halted = memory.attempts.flatMap((attempt) => {
    const last = attempt.outcomes.at(-1);
    return last?.halted === true ? [{ attemptId: attempt.script.attemptId, haltedAtStep: last.step }] : [];
  });
  memory.replayTarget = pickReplayTarget(halted);
  const target = memory.attempts.find((attempt) => attempt.script.attemptId === memory.replayTarget?.attemptId);
  const entry = target === undefined || memory.replayTarget === undefined
    ? undefined
    : memory.stepEntries.get(stepKey(target.script.attemptId, memory.replayTarget.haltedAtStep));
  if (target !== undefined && entry !== undefined) {
    memory.failureMessage = `${entry.signature ?? 'failure'} at step ${memory.replayTarget?.haltedAtStep ?? 0}`;
    startReplayBranch(stage, target, entry);
    emitter.log('info', `${target.script.attemptId} halted at step ${memory.replayTarget?.haltedAtStep}; replay branch requested now so it overlaps with the rest of the run`, 'fixture-db');
  }
  emitter.node('harness', 'healthy');
};
```

`demos/agent-coding/runner/src/stages/winner.ts`:

```ts
import { join } from 'node:path';
import type { Stage } from '../context';
import { pushWinnerBranch } from '../git';

export const verifyJournal = async ({ deps, memory }: Stage): Promise<void> => {
  const { emitter, tiFs } = deps;
  emitter.check('journal-verified', 'pending');
  const result = await tiFs.verifyJournal({ journalId: memory.journalId });
  emitter.check('journal-verified', result.ok ? 'pass' : 'fail', `hash chain of ${memory.journalId} ${result.ok ? 'verifies' : 'is broken'}`);
};

export const winnerPr = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, tiFs, run } = deps;
  emitter.phase('winner-pr');
  const winner = memory.winner;
  const attempt = memory.attempts.find((candidate) => candidate.script.attemptId === winner?.attemptId);
  if (winner === undefined || attempt === undefined) {
    emitter.log('warn', 'no attempt passed, so no pull request is opened', 'harness');
    await verifyJournal(stage);
    return;
  }
  const branch = `fix/${config.ticket.id}-${winner.attemptId}`;
  const pushed = await pushWinnerBranch({
    run,
    remoteDir: join(config.workDir, 'remote.git'),
    cloneDir: join(config.workDir, 'pr-clone'),
    baselineDir: join(config.fixturesDir, 'payments-api'),
    winnerDir: attempt.repoDir,
    branch,
    message: `${config.ticket.id}: ${config.ticket.title}`,
  });
  emitter.log(
    'info',
    `pushed ${branch} at ${pushed.commit.slice(0, 8)} touching ${pushed.files.join(', ')}; layer ${attempt.layerId} is left uncommitted`,
    'harness',
  );
  await tiFs.appendJournal({
    journalId: memory.journalId,
    entry: {
      type: 'pr.pushed',
      subjects: [`attempt:${winner.attemptId}`, `ticket:${config.ticket.id}`],
      summary: { branch, commit: pushed.commit, files: pushed.files },
    },
    idempotencyKey: `${config.runId}-pr`,
  });
  await verifyJournal(stage);
};
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding typecheck
```

Expected: the same two errors and no others.

### Task 28: Stages: replay, Lake eval and the lesson

- [ ] Not started

`replayFailedStep` forks a layer from the failed attempt's `step-NN` checkpoint, mounts it, waits for the replay branch (usually already ACTIVE by now), reads the branch's checksum and the tree hash, reruns the step with the real harness and emits `replay-reproduces` from `replayVerdict`. `lakeEval` exports the ledger (a failure here is logged and the rest continues), writes a marker event and polls Lake for it, waits for the event count to match, and runs the three eval queries, timing each. `writeLesson` inserts the lesson, polls hybrid recall for up to a minute (the new row may take a moment to appear in both indexes, U10) and emits `lesson-recalled`, then verifies the journal one last time.

`demos/agent-coding/runner/src/stages/replay.ts`:

```ts
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { timed } from '@lab/runner-kit';
import type { Stage } from '../context';
import { isInjected, stepKey } from '../context';
import { replayVerdict } from '../checks';
import { readTree, runStep } from '../harness';
import { buildSnapshotSql, parseSnapshotRow } from '../snapshot';
import { withLayer, withMount, withoutMount } from '../state';
import { treeHash } from '../tree';

export const replayFailedStep = async ({ deps, memory }: Stage): Promise<void> => {
  const { config, emitter, tiFs } = deps;
  emitter.phase('replay-failed-step');
  emitter.check('replay-reproduces', 'pending');
  const target = memory.replayTarget;
  const attempt = memory.attempts.find((candidate) => candidate.script.attemptId === target?.attemptId);
  const original = target === undefined ? undefined : memory.stepEntries.get(stepKey(target.attemptId, target.haltedAtStep));
  const step = attempt?.script.steps.find((candidate) => candidate.step === target?.haltedAtStep);
  if (target === undefined || attempt === undefined || original === undefined || step === undefined || memory.replayBranch === undefined) {
    emitter.log('warn', 'no attempt failed, so there is nothing to replay', 'harness');
    emitter.check('replay-reproduces', 'fail', 'no attempt failed');
    return;
  }
  const checkpointId = `step-${String(target.haltedAtStep).padStart(2, '0')}`;
  emitter.node('filesystem', 'busy', `forking ${target.attemptId} from ${checkpointId}`);
  const { value: fork, ms: forkMs } = await timed(() =>
    tiFs.forkLayer({
      parentLayerRef: attempt.layerId,
      layerName: `replay-${target.attemptId}-${checkpointId}-${config.runId}`,
      checkpointId,
      actorId: 'replay',
    }),
  );
  emitter.metric('fork-layer-ms', forkMs);
  emitter.flow('layer-io', 1);
  memory.state = withLayer(memory.state, fork.layerId);
  const mountPath = join(config.workDir, 'replay');
  await mkdir(mountPath, { recursive: true });
  await tiFs.mountLayer({ mountPath, layerRef: fork.layerId, remotePath: '/workspace' });
  memory.state = withMount(memory.state, mountPath);
  await deps.saveState(memory.state);
  emitter.log('info', `replay layer ${fork.layerId} forked from ${target.attemptId}@${checkpointId} in ${Math.round(forkMs)} ms`, 'filesystem');

  emitter.node('fixture-db', 'busy', 'waiting for the replay branch');
  const branchInfo = await memory.replayBranch;
  const pool = deps.openBranchPool(branchInfo);
  try {
    const snapshot = parseSnapshotRow((await pool.rows(buildSnapshotSql(config.fixtureDatabase)))[0] ?? {});
    emitter.flow('branch-reads', 1);
    const repoDir = join(mountPath, 'payments-api');
    const hash = treeHash(await readTree(repoDir));
    const rerun = await runStep(attempt.script, step, {
      repoDir,
      fixturesDir: config.fixturesDir,
      run: deps.run,
      injectedFault: isInjected(memory, target.attemptId),
    });
    const verdict = replayVerdict({
      original,
      replay: {
        failing: rerun.test?.failing ?? [],
        signature: rerun.test?.signature,
        treeHash: hash,
        checksum: snapshot.checksum,
      },
    });
    memory.replayVerified = verdict.pass;
    emitter.check('replay-reproduces', verdict.pass ? 'pass' : 'fail', verdict.observed);
    emitter.log('info', `replayed ${target.attemptId} step ${target.haltedAtStep}: ${rerun.test?.failing.length ?? 0} failing tests, ${rerun.test?.signature ?? 'no signature'}`, 'harness');
    await tiFs.appendJournal({
      journalId: memory.journalId,
      entry: {
        type: 'step.replayed',
        status: verdict.pass ? 'ok' : 'failed',
        subjects: [`attempt:${target.attemptId}`],
        summary: { checkpointId, layerId: fork.layerId, observed: verdict.observed },
      },
      idempotencyKey: `${config.runId}-replay`,
    });
  } finally {
    await pool.end();
    await tiFs.unmount({ mountPath });
    memory.state = withoutMount(memory.state, mountPath);
    await deps.saveState(memory.state);
    emitter.node('filesystem', 'healthy');
    emitter.node('fixture-db', 'healthy');
  }
};
```

`demos/agent-coding/runner/src/stages/eval.ts`:

```ts
import { timed } from '@lab/runner-kit';
import type { Stage } from '../context';
import { countVerdict } from '../checks';
import { markerEvent } from '../events';
import { hashEmbedding } from '../embedding';
import {
  copyLedgerSql,
  countLedgerSql,
  countMarkerSql,
  countRunEventsSql,
  executeEventsTaskSql,
  matchResetSql,
  mergedPerDollarSql,
  similarFailuresSql,
} from '../lakeSql';
import { buildExportArgs, buildExportDescribeArgs, parseExportId, parseExportState, type ExportState } from '../ticloudExport';

const count = (rows: readonly Readonly<Record<string, unknown>>[]): number => Number(rows[0]?.n ?? 0);

const pollUntil = async (options: {
  readonly deadlineMs: number;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly done: () => Promise<boolean>;
}): Promise<boolean> => {
  if (await options.done()) return true;
  if (Date.now() >= options.deadlineMs) return false;
  await options.sleep(options.intervalMs);
  return pollUntil(options);
};

const waitForExport = async (options: {
  readonly stage: Stage;
  readonly exportId: string;
  readonly deadlineMs: number;
}): Promise<ExportState> => {
  const { config, run, sleep } = options.stage.deps;
  const described = await run({
    bin: 'ticloud',
    args: buildExportDescribeArgs({ clusterId: config.orgClusterId, exportId: options.exportId }),
  });
  const state = parseExportState(described.stdout);
  if (state !== 'running' || Date.now() >= options.deadlineMs) return state;
  await sleep(5000);
  return waitForExport(options);
};

const exportLedger = async (stage: Stage): Promise<void> => {
  const { deps } = stage;
  const { config, emitter, run, lake, orgPool } = deps;
  const database = deps.env.TIDB_DATABASE ?? 'agent_coding';
  const sourceRows = count(await orgPool.rows('SELECT COUNT(*) AS n FROM ledger WHERE run_id = ?', [config.runId]));
  const created = await run({
    bin: 'ticloud',
    args: buildExportArgs({
      clusterId: config.orgClusterId,
      s3Uri: `s3://${config.bucket}/${config.prefix}/${config.runId}/ledger`,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
      filter: `${database}.ledger`,
    }),
  });
  if (created.code !== 0) throw new Error(`ticloud serverless export create failed: ${created.stderr.trim()}`);
  const exportId = parseExportId(created.stdout);
  emitter.flow('ledger-export', sourceRows);
  emitter.log('info', `ledger export ${exportId} started (${sourceRows} rows for this run, Parquet to S3)`, 'ledger');
  const finalState = await waitForExport({ stage, exportId, deadlineMs: Date.now() + config.exportTimeoutMs });
  if (finalState !== 'completed') {
    throw new Error(`ledger export ${exportId} ${finalState === 'failed' ? 'failed' : 'timed out'}`);
  }
  await lake.query(copyLedgerSql);
  const loaded = count(await lake.query(countLedgerSql(config.runId)));
  emitter.flow('lake-load', loaded);
  emitter.log('info', `Lake ledger rows for this run: ${loaded} of ${sourceRows} exported`, 'lake');
};

const awaitFreshness = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, sink, lake, sleep } = deps;
  const markerId = `mk-${config.runId}`;
  const startedAt = Date.now();
  await sink.write([JSON.stringify(markerEvent({ runId: config.runId, markerId, nowMs: startedAt }))]);
  memory.eventsEmitted += 1;
  emitter.metric('events-emitted', memory.eventsEmitted);
  emitter.flow('events-out', 1);
  if (config.executeLakeTask) await lake.query(executeEventsTaskSql);
  const seen = await pollUntil({
    deadlineMs: startedAt + config.freshnessTimeoutMs,
    intervalMs: 3000,
    sleep,
    done: async () => count(await lake.query(countMarkerSql({ runId: config.runId, markerId }))) > 0,
  });
  const lagSeconds = (Date.now() - startedAt) / 1000;
  if (seen) {
    emitter.metric('lake-freshness-s', lagSeconds);
    emitter.log('info', `marker visible in Lake ${lagSeconds.toFixed(1)} s after it was written to S3`, 'lake');
  }
  emitter.check('lake-count-matches', 'pending');
  let visible = 0;
  await pollUntil({
    deadlineMs: Date.now() + config.freshnessTimeoutMs,
    intervalMs: 3000,
    sleep,
    done: async () => {
      visible = count(await lake.query(countRunEventsSql(config.runId)));
      emitter.metric('lake-events-visible', visible);
      return visible >= memory.eventsEmitted;
    },
  });
  const verdict = countVerdict({ emitted: memory.eventsEmitted, visible });
  emitter.check('lake-count-matches', verdict.pass ? 'pass' : 'fail', verdict.observed);
  const first = memory.firstEventWrittenAtMs ?? startedAt;
  emitter.metric('lake-rows-per-min', visible / Math.max((Date.now() - first) / 60000, 1 / 60));
  emitter.flow('lake-load', visible);
};

const runEvalQueries = async ({ deps, memory }: Stage): Promise<void> => {
  const { config, emitter, lake } = deps;
  emitter.node('eval', 'busy', 'running eval queries');
  const reset = await timed(() => lake.query(matchResetSql));
  emitter.metric('eval-query-ms', reset.ms);
  emitter.log('info', `MATCH 'ECONNRESET': ${String(reset.value[0]?.matches)} events across ${String(reset.value[0]?.runs)} runs`, 'eval');
  const perDollar = await timed(() => lake.query(mergedPerDollarSql));
  emitter.metric('eval-query-ms', perDollar.ms);
  perDollar.value.forEach((row) =>
    emitter.log('info', `merged per dollar (modeled, fixture model labels): ${String(row.model)} ${Number(row.merged_per_dollar).toFixed(2)}`, 'eval'),
  );
  const message = memory.failureMessage ?? 'ECONNRESET at step 7';
  const similar = await timed(() =>
    lake.query(similarFailuresSql({ runId: config.runId, vector: hashEmbedding(message), limit: 3 })),
  );
  emitter.metric('eval-query-ms', similar.ms);
  similar.value.forEach((row) =>
    emitter.log('info', `similar past failure (cosine distance ${Number(row.distance).toFixed(3)}): ${String(row.message)}`, 'eval'),
  );
  emitter.flow('eval-queries', 3);
  emitter.node('eval', 'healthy', 'eval queries complete');
};

export const lakeEval = async (stage: Stage): Promise<void> => {
  const { deps } = stage;
  const { emitter } = deps;
  emitter.phase('lake-eval');
  emitter.node('lake', 'busy', 'loading events and ledger');
  emitter.node('s3-events', 'busy', 'events and ledger export');
  await exportLedger(stage).catch((error: unknown) =>
    emitter.log('error', `ledger export skipped: ${error instanceof Error ? error.message : String(error)}`, 'ledger'),
  );
  await awaitFreshness(stage);
  emitter.node('s3-events', 'healthy');
  emitter.node('lake', 'healthy');
  await runEvalQueries(stage);
};
```

`demos/agent-coding/runner/src/stages/lesson.ts`:

```ts
import { timed } from '@lab/runner-kit';
import type { Stage } from '../context';
import { stepKey } from '../context';
import { buildLesson, lessonRecalled } from '../lesson';
import { buildHybridSearch, insertMemorySql, parseMemoryHits } from '../starterSql';
import { verifyJournal } from './winner';

const recallQuery = 'gateway connection reset retry loop idempotency';

export const writeLesson = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, orgPool, tiFs, sleep } = deps;
  emitter.phase('write-lesson');
  emitter.check('lesson-recalled', 'pending');
  const target = memory.replayTarget;
  const entry = target === undefined ? undefined : memory.stepEntries.get(stepKey(target.attemptId, target.haltedAtStep));
  if (target === undefined || entry === undefined) {
    emitter.log('warn', 'no attempt failed, so there is no lesson to write', 'org-memory');
    emitter.check('lesson-recalled', 'fail', 'no failure to learn from');
    return;
  }
  const text = buildLesson({
    ticketId: config.ticket.id,
    attemptId: target.attemptId,
    step: target.haltedAtStep,
    signature: entry.signature ?? 'failure',
    reproduced: memory.replayVerified === true,
    winnerId: memory.winner?.attemptId,
  });
  emitter.node('org-memory', 'busy', 'writing the lesson');
  const lessonId = await orgPool.insert(insertMemorySql, ['lesson', text]);
  memory.lessonId = lessonId;
  emitter.flow('lesson-write', 1);
  emitter.log('info', `lesson ${lessonId} written: ${text}`, 'org-memory');

  const query = buildHybridSearch({ text: recallQuery, limit: 3 });
  const deadline = Date.now() + 60000;
  const attemptRecall = async (): Promise<boolean> => {
    const { value, ms } = await timed(() => orgPool.rows(query.sql, query.params));
    emitter.metric('hybrid-search-ms', ms);
    if (lessonRecalled(parseMemoryHits(value), lessonId)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(3000);
    return attemptRecall();
  };
  const recalled = await attemptRecall();
  emitter.check(
    'lesson-recalled',
    recalled ? 'pass' : 'fail',
    recalled ? `lesson ${lessonId} is in the top 3 hybrid results for a new retry-loop task` : `lesson ${lessonId} not in the top 3 after 60 s`,
  );
  await tiFs.appendJournal({
    journalId: memory.journalId,
    entry: { type: 'lesson.written', subjects: [`memory:${lessonId}`], summary: { recalled } },
    idempotencyKey: `${config.runId}-lesson`,
  });
  await verifyJournal(stage);
  emitter.node('org-memory', 'done', 'lesson recorded');
  emitter.log('info', 'run complete: stop the runner with Ctrl-C, then run the teardown script', 'harness');
};
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding typecheck
```

Expected: the same two errors and no others.

### Task 29: The runner (GREEN)

- [ ] Not started

`createRunner` runs setup, intake and the seed checkpoint on `start()` and then waits for controls. Every pressed control goes through `gateControl`; accepted controls are queued so two stages never run at once, and a failed stage becomes an `error` log and a degraded `harness` node rather than a crash. With `AUTO_RUN=true`, `start()` presses `fan-out`, `replay-failed-step`, `run-eval` and `write-lesson` itself, `STAGE_PAUSE_MS` apart. `shutdown()` waits for the queue, unmounts every mount still in `state.json` (an abrupt kill can lose write-back state) and ends the pools.

`demos/agent-coding/runner/src/runner.ts`:

```ts
import { createMemory, errorMessage, type Deps, type Stage } from './context';
import { gateControl } from './gates';
import { emptyState } from './state';
import { fanOut } from './stages/fanout';
import { intakeMemoryRecall } from './stages/intake';
import { lakeEval } from './stages/eval';
import { writeLesson } from './stages/lesson';
import { replayFailedStep } from './stages/replay';
import { seedCheckpoint } from './stages/seed';
import { setup } from './stages/setup';
import { winnerPr } from './stages/winner';
import { workLoop } from './stages/workloop';

export type Runner = {
  readonly start: () => Promise<void>;
  readonly onControl: (id: string) => void;
  readonly idle: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
};

const autoPlay: readonly string[] = ['fan-out', 'replay-failed-step', 'run-eval', 'write-lesson'];

export const createRunner = (deps: Deps): Runner => {
  const { emitter, config } = deps;
  const memory = createMemory(emptyState(config.runId));
  const stage: Stage = { deps, memory };
  let queue: Promise<void> = Promise.resolve();

  const execute = async (control: string): Promise<void> => {
    switch (control) {
      case 'inject-flaky-dependency':
        memory.injectFault = true;
        emitter.log('warn', 'flaky dependency armed for the next fan-out', 'harness');
        return;
      case 'fan-out':
        await fanOut(stage);
        await workLoop(stage);
        await winnerPr(stage);
        return;
      case 'replay-failed-step':
        return replayFailedStep(stage);
      case 'run-eval':
        return lakeEval(stage);
      case 'write-lesson':
        return writeLesson(stage);
      default:
        emitter.log('warn', `unknown control: ${control}`);
    }
  };

  const onControl = (control: string): void => {
    const gate = gateControl({ control, done: memory.done });
    if (!gate.run) {
      emitter.log('warn', `${control}: ${gate.reason}`);
      return;
    }
    if (control !== 'inject-flaky-dependency') memory.done = [...memory.done, control];
    queue = queue
      .then(() => execute(control))
      .catch((error: unknown) => {
        emitter.log('error', `${control} failed: ${errorMessage(error)}`);
        emitter.node('harness', 'degraded', errorMessage(error));
      });
  };

  const play = async (remaining: readonly string[]): Promise<void> => {
    const [next, ...rest] = remaining;
    if (next === undefined) return;
    await deps.sleep(config.stagePauseMs);
    onControl(next);
    await queue;
    return play(rest);
  };

  return {
    start: async () => {
      await setup(stage);
      await intakeMemoryRecall(stage);
      await seedCheckpoint(stage);
      emitter.log('info', 'ready: press fan-out (or inject-flaky-dependency first)', 'harness');
      if (config.autoRun) await play(autoPlay);
    },
    onControl,
    idle: () => queue,
    shutdown: async () => {
      await queue;
      await Promise.all(
        memory.state.mounts.map((mountPath) => deps.tiFs.unmount({ mountPath }).catch(() => undefined)),
      );
      await Promise.all(memory.attempts.map((attempt) => attempt.pool?.end().catch(() => undefined)));
      await deps.orgPool.end().catch(() => undefined);
    },
  };
};
```

Run the stand-in run and then the whole demo package:

```bash
pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/runner.test.ts
pnpm --filter @lab/demo-agent-coding test
pnpm --filter @lab/demo-agent-coding typecheck
```

Expected PASS: the first prints `Tests  12 passed (12)` in about eight seconds (it runs the real fixture tests ten times per run). The second prints `Test Files  23 passed (23)` and `Tests  160 passed (160)`. `tsc` exits 0.

Commit:

```bash
git add demos/agent-coding/runner/src/sql.ts demos/agent-coding/runner/src/context.ts demos/agent-coding/runner/src/runner.ts demos/agent-coding/runner/src/stages demos/agent-coding/runner/test/fakes.ts demos/agent-coding/runner/test/runner.test.ts
git commit -m "agent-coding demo: add the runner, its stages and the whole-run test"
```

### Task 30: Entry points: main, seed-fixture and teardown

- [ ] Not started

`main.ts` is the impure shell: it reads the environment once, builds every adapter and hands them to `createRunner`. The branch pool factory is where U3 and U4 matter: it needs the branch's public host from `branches.list` and builds the user name with `branchUser`. `seed-fixture.ts` seeds the fixture instance (the only place the demo writes to it; the runner afterwards connects with the read-only user). `teardown.ts` runs the plan from `state.json`, then the Lake statements, and exits 1 if any step failed.

`demos/agent-coding/runner/main.ts`:

```ts
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  branches,
  createLakeClient,
  createS3EventSink,
  lakeConfigFromEnv,
  runCli,
  tiFs,
  type BranchInfo,
} from '@lab/agent-stack-kit';
import { createEmitter, createTidbPool, onControl } from '@lab/runner-kit';
import { branchEnv, branchUser } from './src/branchEnv';
import { runConfigFromEnv } from './src/config';
import { errorMessage } from './src/context';
import { loadAttemptScripts } from './src/fixtureStore';
import { createRunner } from './src/runner';
import { fromMysql, type Sql } from './src/sql';
import { writeState } from './src/stateStore';

const env = process.env;
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const config = runConfigFromEnv(env, { fixturesDir, now: new Date(), homeDir: homedir() });
const emitter = createEmitter();

const openBranchPool = (branch: BranchInfo): Sql => {
  if (branch.host === undefined) throw new Error(`branch ${branch.branchId} has no public host in the CLI output`);
  return fromMysql(
    createTidbPool(
      branchEnv({
        base: env,
        host: branch.host,
        port: branch.port ?? 4000,
        user: branchUser({ userPrefix: branch.userPrefix, user: config.branchSqlUser }),
        password: config.branchSqlPassword,
        database: config.fixtureDatabase,
      }),
    ),
  );
};

const main = async (): Promise<void> => {
  const runner = createRunner({
    config,
    env,
    emitter,
    orgPool: fromMysql(createTidbPool(env)),
    tiFs,
    branches,
    lake: createLakeClient(lakeConfigFromEnv({ ...env, LAKE_DATABASE: config.lakeDatabase })),
    lakeBootstrap: createLakeClient(lakeConfigFromEnv({ ...env, LAKE_DATABASE: 'default' })),
    sink: createS3EventSink({
      bucket: config.bucket,
      prefix: `${config.prefix}/${config.runId}/events`,
      region: config.region,
    }),
    run: runCli,
    scripts: await loadAttemptScripts(fixturesDir),
    sleep: (ms) => delay(ms),
    openBranchPool,
    saveState: (state) => writeState(join(config.workDir, 'state.json'), state),
  });
  onControl((id) => runner.onControl(id));
  const stop = async (code: number): Promise<void> => {
    await runner.shutdown();
    process.exit(code);
  };
  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));
  try {
    await runner.start();
  } catch (error) {
    emitter.log('error', errorMessage(error));
    await stop(1);
  }
};

main().catch((error: unknown) => {
  emitter.log('error', errorMessage(error));
  process.exit(1);
});
```

`demos/agent-coding/runner/seed-fixture.ts`:

```ts
import { createTidbPool } from '@lab/runner-kit';
import { chunk, fixtureStatements, generateOrders, insertOrdersSql, orderRowsAsParams } from './src/fixtureData';
import { buildSnapshotSql, parseSnapshotRow } from './src/snapshot';
import { fromMysql } from './src/sql';

const env = process.env;

const need = (name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const main = async (): Promise<void> => {
  const database = env.FIXTURE_DATABASE === undefined || env.FIXTURE_DATABASE === '' ? 'fixture' : env.FIXTURE_DATABASE;
  const sql = fromMysql(
    createTidbPool({
      ...env,
      TIDB_HOST: need('FIXTURE_HOST'),
      TIDB_PORT: env.FIXTURE_PORT === undefined || env.FIXTURE_PORT === '' ? '4000' : env.FIXTURE_PORT,
      TIDB_USER: need('FIXTURE_ADMIN_USER'),
      TIDB_PASSWORD: need('FIXTURE_ADMIN_PASSWORD'),
      TIDB_DATABASE: 'test',
      TIDB_TLS: 'true',
    }),
  );
  try {
    await fixtureStatements(database).reduce<Promise<void>>(async (previous, statement) => {
      await previous;
      await sql.exec(statement);
    }, Promise.resolve());
    const rows = orderRowsAsParams(generateOrders({ seed: 20261017, count: 2000 }));
    await chunk(rows, 250).reduce<Promise<void>>(async (previous, batch) => {
      await previous;
      await sql.exec(insertOrdersSql(database, batch.length), batch.flat());
    }, Promise.resolve());
    const snapshot = parseSnapshotRow((await sql.rows(buildSnapshotSql(database)))[0] ?? {});
    console.log(`fixture.orders: ${snapshot.rowCount} rows, checksum ${snapshot.checksum}`);
  } finally {
    await sql.end();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

`demos/agent-coding/runner/teardown.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { branches, createLakeClient, lakeConfigFromEnv, runCli } from '@lab/agent-stack-kit';
import { emptyState } from './src/state';
import { readState } from './src/stateStore';
import { lakeTeardownStatements } from './src/lakeSql';
import { buildTeardownPlan } from './src/teardownPlan';

const env = process.env;

const need = (name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const main = async (): Promise<void> => {
  const destroyInstances = process.argv.includes('--destroy-instances');
  const workDir = env.WORK_DIR === undefined || env.WORK_DIR === '' ? join(homedir(), 'lab-agent-coding-work') : env.WORK_DIR;
  const state = (await readState(join(workDir, 'state.json'))) ?? emptyState('none');
  const fixtureClusterId = need('AGENT_FIXTURE_CLUSTER_ID');
  const listed = await branches.list({ clusterId: fixtureClusterId }).catch(() => []);
  const plan = buildTeardownPlan({
    state,
    fixtureClusterId,
    fixtureBranchIds: listed.map((branch) => branch.branchId),
    orgClusterId: need('AGENT_ORG_CLUSTER_ID'),
    fileSystemId: need('TI_FS_FILE_SYSTEM_ID'),
    bucket: need('S3_BUCKET'),
    prefix: env.S3_PREFIX === undefined || env.S3_PREFIX === '' ? 'agent-coding' : env.S3_PREFIX,
    destroyInstances,
  });
  const failures = await plan.reduce<Promise<number>>(async (previous, step) => {
    const failed = await previous;
    const result = await runCli({ bin: step.bin, args: step.args });
    console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${step.label}${result.code === 0 ? '' : `: ${result.stderr.trim()}`}`);
    return failed + (result.code === 0 ? 0 : 1);
  }, Promise.resolve(0));

  const lake = createLakeClient(lakeConfigFromEnv({ ...env, LAKE_DATABASE: 'default' }));
  const lakeFailures = await lakeTeardownStatements({
    warehouse: need('LAKE_WAREHOUSE'),
    database: env.LAKE_DATABASE === undefined || env.LAKE_DATABASE === '' ? 'agent_coding' : env.LAKE_DATABASE,
  }).reduce<Promise<number>>(async (previous, sql) => {
    const failed = await previous;
    try {
      await lake.query(sql);
      console.log(`ok   ${sql}`);
      return failed;
    } catch (error) {
      console.log(`FAIL ${sql}: ${message(error)}`);
      return failed + 1;
    }
  }, Promise.resolve(0));

  console.log(`teardown finished with ${failures + lakeFailures} failed steps`);
  if (failures + lakeFailures > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(message(error));
  process.exitCode = 1;
});
```

Run:

```bash
pnpm --filter @lab/demo-agent-coding typecheck
```

Expected: `tsc` exits 0 with no output.

Commit:

```bash
git add demos/agent-coding/runner/main.ts demos/agent-coding/runner/seed-fixture.ts demos/agent-coding/runner/teardown.ts
git commit -m "agent-coding demo: add entry points"
```

### Task 31: Seed the fixture and make the first live run (manual, live)

- [ ] Not started

Needs Task 1 done and 12-V1 to 12-V5 recorded. Cloud resources are billing from here until Task 34.

**Step 1: `.env`.** Copy `.env.example` to `.env` (it is gitignored) and fill every empty value from your Task 1 scratch note. The standard block becomes: `TIDB_HOST`, `TIDB_PORT`, `TIDB_USER`, `TIDB_PASSWORD` from the org instance's read-write connection string, `TIDB_DATABASE=agent_coding`, `TIDB_TLS=true`, `LAB_ENV_TIDB=TiDB Cloud Starter (aws-us-east-1)` plus the version string the console shows. Fill `LAB_ENV_COMPONENT_TI_CLI`, `_TICLOUD_CLI`, `_LAKE_DRIVER` (from `pnpm --filter @lab/agent-stack-kit ls tidbcloudlake-driver`), `_FUSE` and `_NODE` with the versions you recorded. Leave `AUTO_RUN=false`. Keep `BRANCH_QUOTA` equal to the quota your organization really has.

**Step 2: the org database and the fixture rows.**

```bash
pnpm lab db-init agent-coding
pnpm --filter @lab/demo-agent-coding run seed-fixture
pnpm lab validate agent-coding
```

Expected: `db-init` creates `agent_coding` if needed and prints the TiDB version; `seed-fixture` prints `fixture.orders: 2000 rows, checksum <digits>` (record the checksum: every branch must report the same one); `validate` prints `agent-coding: manifest ok` (it adds `featured trace ok (N events)` once a trace exists).

**Step 3: first run, driven by hand.**

```bash
pnpm lab run agent-coding --port 7070
```

In a second terminal:

```bash
curl http://localhost:7070/health
```

Expected: `{"ok":true,"demo":"agent-coding"}`. In the first terminal, JSON lines start flowing: `node` events for all nine nodes with status `starting`, `{"type":"phase","phase":"setup",...}`, a `log` per attempt branch requested (`attempt-1: branch <id> requested (CREATING)` or whatever state the CLI prints), `log` lines for the Lake objects and the synthetic history, then `phase` `intake-memory-recall` with a `hybrid-search-ms` metric and three `recall n (org): ...` logs, then `phase` `seed-checkpoint` with a `checkpoint-ms` metric, and finally `ready: press fan-out (or inject-flaky-dependency first)`.

Press the controls in order, waiting for each stage to finish:

```bash
curl -X POST http://localhost:7070/control/fan-out
curl -X POST http://localhost:7070/control/replay-failed-step
curl -X POST http://localhost:7070/control/run-eval
curl -X POST http://localhost:7070/control/write-lesson
```

Expected after `fan-out`: possibly a wait of minutes (`branch-create-s` metrics), three `fork-layer-ms` metrics, `check fork-branches-identical pass`, then per step `checkpoint-ms`, `branch-reads` flows and a log per step, `attempt-2` halting at step 7 with `ECONNRESET`, scores `attempt-1 ... score 73`, `attempt-2 ... score 0`, `attempt-3 ... score 51` (formula, modeled), `check layer-isolation pass`, `pushed fix/KIT-8812-attempt-1 ... layer ... is left uncommitted`, `check journal-verified pass`. After `replay-failed-step`: `check replay-reproduces pass` with an `observed` text naming four failing tests and `ECONNRESET`. After `run-eval`: `lake-freshness-s` (at least one task interval), `lake-events-visible` rising to the emitted count, `check lake-count-matches pass`, three `eval-query-ms` metrics and the eval log lines. After `write-lesson`: `check lesson-recalled pass` and a last `check journal-verified pass`.

Stop with Ctrl-C. Expected: the runner unmounts its mounts and exits. Confirm nothing is still mounted: `mount | grep lab-agent-coding-work` prints nothing.

**Step 4: arm the fault once.** Restart the runner, press `inject-flaky-dependency` and then `fan-out` and confirm attempt 3 wins (`pushed fix/KIT-8812-attempt-3`). This uses four more branches and several more minutes; skip it if your branch quota or patience is short, and note in the plan's section 4 that the control was not exercised live.

If anything fails, fix the code in the file that owns the behaviour, keep the stand-in test green, and note the deviation at the end of this plan.

No commit (no new files).

### Task 32: Public-content gate

- [ ] Not started

```bash
pnpm lab check-public
grep -rn $'\xe2\x80\x94' --exclude-dir=node_modules demos/agent-coding packages/agent-stack-kit docs/plans/12-agent-coding-platform.md
```

Expected: `check-public` passes with `0 findings` (no denylisted terms or internal URLs in `demos/agent-coding/` or `packages/agent-stack-kit/`); the `grep` prints nothing. If either flags something, fix the flagged file and rerun before moving to section 8. The fixture's attempt files, scripts, SQL and talk track name no customer, competitor or person; "Kiteline" is the fictional company.

### Task 33: README and TALK-TRACK

- [ ] Not started

`demos/agent-coding/README.md`:

````markdown
# TiDB Cloud agent stack: coding-agent platform (Filesystem + TiDB X + Lake)

## What this proves

One ticket (KIT-8812, "fix double charge on retried payments") fans out into
three scripted agent attempts. Each attempt gets its own copy-on-write
workspace (a TiDB Cloud Filesystem layer forked from a seed checkpoint) and its
own database (a TiDB Cloud Starter branch of a read-only fixture instance).
Every step is drained, checkpointed, stamped with the branch's own clock and
written to a ledger. The winning attempt pushes a git branch and never commits
its layer. A failed attempt is replayed from its step checkpoint with the
database branched at that step's timestamp, and the same tests fail again. Run
events and the ledger reach TiDB Cloud Lake through S3 for eval, and a lesson
is written back to Starter memory. The agent is a deterministic script, not an
LLM: the demo measures the data infrastructure, not model quality. See
`docs/plans/12-agent-coding-platform.md` for the design, verified facts and
sources.

## Prerequisites

- A TiDB Cloud organization with TiDB Cloud Filesystem (public preview), TiDB
  Cloud Starter and TiDB Cloud Lake (preview) available in aws-us-east-1, and
  branch quota for four branches.
- One S3 bucket in us-east-1 and an IAM user with an access key limited to it.
- macOS with macFUSE or Linux with fuse3 (layers and checkpoints need FUSE).
- Node 22, pnpm, git, and the `ti`, `ticloud` and `aws` command line tools.

## One-time setup

1. Create the resources listed in Task 1 of the plan: bucket, IAM user, file
   system, two Starter instances, the Lake warehouse and the Lake SQL user.
2. Copy `.env.example` to `.env` and fill in every empty value.
3. `pnpm install` at the `integrations/` workspace root.
4. `pnpm lab db-init agent-coding` to create the org memory database.
5. `pnpm --filter @lab/demo-agent-coding run seed-fixture` to seed the fixture
   instance with 2,000 deterministic order rows.

## Run

```bash
pnpm lab run agent-coding --port 7070
```

The runner finishes setup, intake recall and the seed checkpoint on its own,
then waits. Drive it from the UI buttons or headless:

```bash
curl http://localhost:7070/health
curl -X POST http://localhost:7070/control/inject-flaky-dependency
curl -X POST http://localhost:7070/control/fan-out
curl -X POST http://localhost:7070/control/replay-failed-step
curl -X POST http://localhost:7070/control/run-eval
curl -X POST http://localhost:7070/control/write-lesson
```

Set `AUTO_RUN=true` to let the runner press fan-out, replay, eval and lesson
itself, one after the other. Branch creation takes minutes, so expect the first
fan-out to wait for the attempt branches.

## Record

```bash
pnpm lab run agent-coding --record --port 7070
```

Stop with Ctrl-C when the lesson check has passed. The runner unmounts every
layer before it exits. Promote the newest file under
`demos/agent-coding/traces/` to `traces/featured.json`. Full choreography is
in `docs/plans/12-agent-coding-platform.md` section 8.

## Cost

Everything here bills per use and none of it is free forever. See the plan's
section 5 for the formula and the pricing pages: TiDB Cloud Filesystem, TiDB
Cloud Starter, TiDB Cloud Lake and Amazon S3. The Lake task runs every minute
while it is resumed, so the warehouse stays awake for the whole session. Run
the teardown as soon as you stop recording.

## Teardown

```bash
cd demos/agent-coding
node --import tsx runner/teardown.ts --destroy-instances
```

That unmounts leftover mounts, deletes every branch of the fixture instance,
deletes the task layer and every layer forked from it, empties the S3 prefix,
drops the Lake objects, suspends and drops the Lake warehouse, then deletes the
file system and both Starter instances. Delete the IAM user and the bucket with
the commands in the plan's section 5. Leave out `--destroy-instances` to keep
the file system and instances for another run.
````

`demos/agent-coding/TALK-TRACK.md`:

```markdown
# Talk track: TiDB Cloud agent stack, coding-agent platform

## Phase-by-phase script

**Setup.** "Kiteline sells a coding agent. Before we start: three branches of a
read-only fixture database are copying right now. Branches take minutes, so we
asked for them first and we overlap everything else with the wait. Nothing here
is a model. The agent is a script, so what you see measures the data layer."

**Intake memory recall.** "A ticket arrives: fix the double charge on retried
payments. Before it touches code the agent asks org memory one question. That
one SQL statement fuses a vector search for meaning with a full-text search for
exact words, and the embedding is generated by the database when the row is
inserted. Three memories come back."

**Seed checkpoint.** "The repo lands in a task layer and we checkpoint it as
seed. A checkpoint only holds what has reached the service, so the harness
drains the mount first. Remember the drain plus checkpoint number: we pay it
at every step."

**Fan out 3 attempts.** "Three attempts fan out. Each forks its own
copy-on-write layer from seed and gets its own database branch. Look at the
fork latency tile: that is a real measurement of the CLI call, not a claim.
Then the first check: all three branches report the same row count and the
same checksum before anyone has done anything."

**Work loop.** "Every step does the same four things: drain, checkpoint, read
the branch's own clock and write a ledger row. We wait one second between
steps on purpose, because the branch timestamp we will use later has one-second
granularity. Attempt 2 is going to hit a flaky gateway at step 7. That is
scripted and labeled, not luck."

**Winner PR.** "Attempt 1 passes with the smallest change, so it wins and
pushes a git branch to a local bare repo. Notice what did not happen: nobody
committed the layer. Attempt 3 also passed but changed four files, so it
lost on score. The score is a formula, not a model opinion. The isolation check
shows that a file only one attempt wrote appears only in that attempt's diff."

**Replay the failed step.** "Attempt 2 failed at step 7. We fork a new layer
from its step-07 checkpoint, branch its database at the timestamp we wrote to
the ledger at that step, and rerun the step. Same failing tests, same error,
same file tree, same row checksum. Creating that branch took minutes, and we
started it during the work loop for that reason."

**Lake eval.** "Run events went out to S3 as NDJSON and the ledger as Parquet.
A Lake task loads the events every minute, so freshness is bounded by that
schedule, not by anything slow. Now the questions a platform team asks: how
often does a gateway reset kill a run, which model label merges more per
dollar, which past failures look like this one. The history behind the merge
numbers is synthetic and labeled modeled."

**Write the lesson.** "The lesson goes back into org memory. Now a brand new
ticket that mentions a retry loop would recall it in the top three. That is
the loop: run, replay, evaluate, remember."

## Discovery questions

1. "When an agent attempt goes wrong at step 7 of 20, what can you replay
   today, and how close is the replay to the original state?"
2. "How many attempts do you run per task, and what does each one get that is
   isolated: files, a database, secrets?"
3. "Where does the knowledge from a failed run go? Who or what reads it before
   the next run starts?"
4. "How do you evaluate runs across thousands of attempts: what question do you
   ask first, and what does it cost to ask it?"
5. "What breaks when two attempts touch the same repo or the same test
   database?"

## Objections and honest answers

1. **"Branch creation took minutes. That is not interactive."** Correct, and
   the vendor documents it as a few minutes, not milliseconds. The pattern
   works because the runner asks for branches before it needs them and overlaps
   the wait with other work. If you need an isolated database in under a
   second, a branch per attempt is not that. A pool of pre-created branches is
   the design to discuss.
2. **"This is all preview."** Yes. TiDB Cloud Filesystem, branching and TiDB
   Cloud Lake are public preview, with no SLA. This demo is how to evaluate
   them, not a production commitment. The shapes of the commands and outputs
   can change, which is why the plan pins every parser to captured output.
3. **"Your agent is a script. A real model will not fail the same way twice."**
   Right. The replay proves the mechanism: the file state and the database
   state at a step can be reconstructed exactly. It does not prove a model
   would repeat its own mistake. An LLM mode is on the backlog and would be
   added behind a flag.
4. **"Why not git worktrees and a script that clones a database?"** You can,
   and for one machine it is fine. The difference this demo shows is that the
   workspace and the database both survive the sandbox, fork from a named
   checkpoint, and can be inspected and diffed by service, without copying the
   data first.
5. **"Lake freshness is a minute. We need seconds."** The lag you see is the
   task schedule, shown honestly in the metric. A shorter schedule means a
   busier warehouse and a bigger bill. For eval, minutes are usually enough;
   for alerting, you would use a different path.
6. **"Isn't the merged-per-dollar number made up?"** The history behind it is
   synthetic and the model names are fixture labels, and the metric says
   modeled. What is real is that the question runs in Lake against rows that
   arrived through the same pipeline as this run's events.
7. **"What does this cost to leave running?"** The Lake task keeps its
   warehouse awake while it is resumed, so suspend it when you stop. The
   teardown script does that and drops everything else the demo created.
```

Run: no automated test (both files are documentation). Read them back once to confirm the code blocks render, then:

```bash
grep -c $'\xe2\x80\x94' demos/agent-coding/README.md demos/agent-coding/TALK-TRACK.md
pnpm lab check-public
```

Expected: `0` for each file and `0 findings`.

Commit:

```bash
git add demos/agent-coding/README.md demos/agent-coding/TALK-TRACK.md
git commit -m "agent-coding demo: README and talk track"
```

### Task 34: Teardown run and confirmation (manual, live)

- [ ] Not started

Run after section 8's recording, or after any live run you do not intend to keep.

```bash
cd demos/agent-coding
node --import tsx runner/teardown.ts --destroy-instances
```

Expected output, one line per step: `ok   unmount <path>` for any mount left in `state.json`, one `ok   delete branch <id>` per branch, `ok   delete layer <id> and every layer forked from it`, `ok   empty s3://<bucket>/agent-coding`, `ok   delete file system <id>`, two `ok   delete Starter instance <id>` lines, then `ok   ALTER TASK ingest_run_events SUSPEND` through `ok   DROP WAREHOUSE IF EXISTS 'agent-coding-wh'`, and `teardown finished with 0 failed steps`. A `FAIL` line names the step and its error; fix it by hand with the manual equivalents in section 5 and rerun the script (every step is safe to repeat).

Then delete the bucket and the IAM user and run the four confirmation commands from section 5. Expected: nothing named `agent-coding-lab`, `agent-coding-org`, `agent-coding-fixture` or the lab bucket remains, and the Lake console shows no `agent-coding-wh` warehouse and no `ingest_run_events` task.

No commit.

## 8. Recording the featured trace

1. **Plan the time.** A full run takes roughly 12 to 25 minutes of wall clock: the attempt branches take minutes (the vendor documents a few minutes each), the replay branch overlaps with the winner and the eval, and the Lake freshness wait is at least one task interval. The replay UI's speed control (up to 8x) is the time-lapse; do not edit timestamps in the trace, and say on camera that branch creation took minutes. The platform's "3 to 6 minutes at 1x" definition of done cannot hold for this demo; the honest target is the whole story in under three minutes at 8x.
2. **Warm up, off camera.** At least ten minutes before recording: confirm macFUSE or fuse3 works (`ti fs mount-file-system` on a scratch layer and unmount it), run `SELECT 1` against Lake so the warehouse is Running, check `ticloud serverless branch list "$AGENT_FIXTURE_CLUSTER_ID" -o json` shows no leftover branches from earlier runs (each run needs four), and confirm the org instance accepts `SELECT 1` through `createTidbPool`. Delete stale branches first or the quota check will stop the run in setup.
3. **Set the trace environment values honestly** in `demos/agent-coding/.env` before starting:
   ```
   LAB_ENV_TIDB=TiDB Cloud Starter (aws-us-east-1), <TiDB version string shown in the console>
   LAB_ENV_NOTES=Filesystem, Starter branching and Lake are public preview. Lake warehouse XSmall, task every 1 minute. Synthetic history is modeled. Run length <minutes>, <n> branches, <n> CLI calls.
   LAB_ENV_COMPONENT_TI_CLI=<ti --version>
   LAB_ENV_COMPONENT_TICLOUD_CLI=<ticloud --version>
   LAB_ENV_COMPONENT_LAKE_DRIVER=<tidbcloudlake-driver version>
   LAB_ENV_COMPONENT_FUSE=<macFUSE or fuse3 version>
   LAB_ENV_COMPONENT_NODE=<node --version>
   ```
4. **Record:**
   ```bash
   cd integrations
   pnpm lab run agent-coding --record --port 7070
   ```
5. In the UI (`packages/ui`, pointed at `localhost:7070`), let the runner reach `ready: press fan-out`. Then: click **Inject flaky dependency** only if you want the second story (attempt 3 wins); for the featured trace leave it out. Click **Fan out** and narrate the branch wait with the `fan-out` and `work-loop` narration. When the winner PR is pushed, click **Replay failed step**. While the replay finishes, click **Run eval**. When the count check passes and the eval lines appear, click **Write lesson**. Narrate each phase with `phases[].narration` (also in `TALK-TRACK.md`).
6. A good run: nine phases in order; all six checks `pass`; `fork-layer-ms` samples for four forks; a `checkpoint-ms` sample per step (23 step checkpoints plus the seed); four `branch-create-s` samples in minutes; `lake-freshness-s` at least one task interval; `lake-events-visible` equal to `events-emitted` (27 in the default run); three `eval-query-ms` samples; attempt 1 the winner with a score of 73 and attempt 3 at 51.
7. Stop with **Ctrl-C** after the lesson check passes. The runner unmounts its mounts, and the relay writes `demos/agent-coding/traces/<ISO timestamp>.json`.
8. Promote the recording:
   ```bash
   cd demos/agent-coding/traces
   cp "$(ls -t *.json | head -1)" featured.json
   ```
9. Validate and gate:
   ```bash
   cd ../../..
   pnpm lab validate agent-coding
   pnpm lab check-public
   ```
   Expected: `agent-coding: manifest ok, featured trace ok (N events)` and `0 findings`.
10. Run the teardown (Task 34) before anything else, then commit only the featured trace:
    ```bash
    git add demos/agent-coding/traces/featured.json
    git commit -m "agent-coding demo: record featured trace"
    ```

## 9. Risks and gotchas

- **Branch creation takes minutes, and the quota is small.** The runner needs four branches per run (three attempts and one replay) and checks `assertBranchHeadroom` in setup. Leftover branches from a crashed run make the next run fail in setup; list and delete them first (section 8, step 2). Never describe creation as fast on camera; the manifest says seconds because minutes would not fit a tile label.
- **Connecting to a branch is not documented (U4).** If 12-V2 shows that the parent's SQL users do not authenticate against a branch endpoint, stop: the demo cannot read a branch's clock without a per-branch credential, and this plan does not invent an API for it. Record the finding in section 4 and ask the product team how branch credentials are meant to be provisioned.
- **A checkpoint without a drain is silently incomplete.** `tiFs.checkpoint` always drains first; never call `create-layer-checkpoint` directly in new code. The drain timeout defaults to 30 seconds in the CLI and raising it is a `drainTimeout` option.
- **Do not mount one writable layer twice.** The seed stage unmounts the task layer before any fork is mounted, and the replay layer is a new layer. If you add a stage that remounts a layer, unmount it first.
- **Killing the runner with `kill -9` can lose write-back state and leaves FUSE mounts behind.** Ctrl-C and SIGTERM run `shutdown()`. After any hard kill, run `node --import tsx runner/teardown.ts` (without `--destroy-instances`) before the next run; it unmounts with `--ignore-absent`.
- **Mount paths.** Default work directory is `~/lab-agent-coding-work`, under `$HOME` on purpose: on Ubuntu 26.04 `fusermount3` only allows mounts under `$HOME` or `/mnt`. Do not point `WORK_DIR` at `/workspace` or `/tmp` on Linux without checking the AppArmor note in the vendor's limitations page.
- **Layer names are not unique forever.** Deleted layers keep their names. The kit and the runner use returned layer ids everywhere; the names include the run id only for humans.
- **Journals cannot be deleted.** The public command surface has no journal delete command, so run journals disappear only when the file system is deleted at teardown. Do not put secrets or personal data in journal entries.
- **The Lake task bills while it runs.** A `SCHEDULE = 1 MINUTE` task keeps its warehouse running, so the warehouse never reaches its idle auto-suspend until the task is suspended. Teardown suspends the task first. If you pause for a day in the middle of work, run `ALTER TASK ingest_run_events SUSPEND` yourself.
- **Lake freshness has a floor.** `lake-freshness-s` includes the wait for the next task run, so it is bounded below by the schedule. `LAKE_EXECUTE_TASK=true` runs `EXECUTE TASK` right after the marker is written to shorten recordings; if you use it, say so in `LAB_ENV_NOTES` because the metric then measures an on-demand load, not the schedule.
- **Dropping the warehouse from a bound session may be refused (U8).** The teardown script tries; if the last two Lake statements fail, run them from the Lake console.
- **Auto-embedding and full-text indexes may lag.** A freshly inserted lesson may not appear in both indexes immediately (U10), which is why `write-lesson` polls for up to a minute. A `lesson-recalled` failure after 60 seconds is a real finding, not noise: record it and do not extend the poll to hide it.
- **The hybrid query needs both indexes and the TiFlash hint.** On a very small table the optimizer can otherwise skip the vector index; the statement carries the documented `READ_FROM_STORAGE(TIFLASH[memories])` hint on the vector side.
- **Secrets on the command line.** `ticloud serverless export create` takes the S3 access key and secret as flags, visible in the process list for a few seconds. Use a short-lived IAM user created for this demo (Task 1) and delete it at teardown. The runner never logs argument lists.
- **IAM user keys only.** The Lake `CREATE CONNECTION` takes an access key and secret and the Starter export takes the same pair; session tokens are not supported by either command as documented. Do not use `aws sso` or assumed-role credentials for `AWS_ACCESS_KEY_ID`.
- **Everything shares one region.** The bucket, both Starter instances, the file system and the Lake warehouse should all be in `us-east-1` (U9). A cross-region Lake warehouse adds latency that would be blamed on the wrong product.
- **The replay proves a mechanism, not a model.** The scripted step reproduces because the harness is deterministic. The check still has teeth: it compares the failing test names, the failure signature, the replay layer's tree hash against the hash recorded at that step, and the replay branch's row checksum against the checksum recorded at that step, so a checkpoint or point-in-time that did not restore the right state fails it.
- **Synthetic history is labelled.** Rows with `source = 'synthetic-history'` and `fixture-model-*` labels exist only so the eval has something to aggregate. Never remove "modeled" from the places that show merged per dollar.
- **The `tidbcloudlake-driver` import form (U7).** The kit imports `{ Client }` by name. If the real package is CommonJS-only and Node rejects the named import, switch `lake-client.ts` to a default import and destructure; change nothing else.
- **Parallel mounts on a laptop.** Four FUSE mounts at once is the design (U2). If 12-V1 shows a limit, lower the number of attempts in the scripts rather than serialising the fan-out, and update this plan.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed unless a packet's `Depends on` line allows an earlier start; a later packet may edit a file an earlier packet created. Plan 00 must be complete first. This section is hand-written, like Plan 04's: packets here group several tasks and the verify packets carry live commands, so do not regenerate it with `tools/packets.py`. Plan 13's packets depend on 12-P7 (the finished kit) and may start as soon as it is green.

### Packet 12-P0: Live resources
- Tasks: 1
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: M
- Gate:
  - every command in Task 1 produces the output the task quotes; the coordinator pastes that output into the packet report (never the secrets)
  - `ti fs list-file-systems --region aws-us-east-1 --output text` -> lists `agent-coding-lab`
- Done when: the scratch note holds every id and credential Task 31 needs.

### Packet 12-V1: Verify: Filesystem CLI output shapes and FUSE behaviour
- Tasks: none (docs only)
- Depends on: 12-P0   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/12-agent-coding-platform.md` (section 4 only)
- Model: sonnet   Effort: M
- Items to confirm (run each item's confirm step, paste the real output under section 4 in a block headed "Captured samples (12-V1)", set VERIFIED or record the workaround):
  - **U1 JSON field names and U2 limits, scope and timings.** Create a scratch work directory, a task layer and a checkpoint, then fork and mount:
    ```bash
    export TI_FS_FILE_SYSTEM_ID=<file-system-id>
    mkdir -p ~/lab-agent-coding-work/v1-task ~/lab-agent-coding-work/v1-a ~/lab-agent-coding-work/v1-b ~/lab-agent-coding-work/v1-c
    ti fs create-layer --base-root-path /workspace --layer-name v1-task --durability-mode restore-safe --tag task=v1 --output json
    ti fs mount-file-system --mount-path ~/lab-agent-coding-work/v1-task --remote-path /workspace --driver fuse --layer-ref <task-layer-id>
    mkdir -p ~/lab-agent-coding-work/v1-task/payments-api/src
    printf 'one\n' > ~/lab-agent-coding-work/v1-task/payments-api/src/a.txt
    ti fs drain-file-system --mount-path ~/lab-agent-coding-work/v1-task
    ti fs create-layer-checkpoint --layer-id <task-layer-id> --checkpoint-id seed --output json
    ti fs unmount-file-system --mount-path ~/lab-agent-coding-work/v1-task
    ti fs fork-layer --parent-layer-ref <task-layer-id> --layer-name v1-a --checkpoint-id seed --output json
    ti fs fork-layer --parent-layer-ref <task-layer-id> --layer-name v1-b --checkpoint-id seed --output json
    ti fs fork-layer --parent-layer-ref <task-layer-id> --layer-name v1-c --checkpoint-id seed --output json
    ```
    Paste the stdout of `create-layer`, `create-layer-checkpoint` and one `fork-layer`. Record which key holds the layer id and the checkpoint id.
  - **Concurrent mounts and checkpoint-id scope (U2).** Mount all three forks at once, edit a file in each, drain and checkpoint each with the same id `step-01`, then diff:
    ```bash
    ti fs mount-file-system --mount-path ~/lab-agent-coding-work/v1-a --remote-path /workspace --driver fuse --layer-ref <layer-a-id>
    ti fs mount-file-system --mount-path ~/lab-agent-coding-work/v1-b --remote-path /workspace --driver fuse --layer-ref <layer-b-id>
    ti fs mount-file-system --mount-path ~/lab-agent-coding-work/v1-c --remote-path /workspace --driver fuse --layer-ref <layer-c-id>
    printf 'a\n' > ~/lab-agent-coding-work/v1-a/payments-api/src/only-a.txt
    printf 'b\n' > ~/lab-agent-coding-work/v1-b/payments-api/src/only-b.txt
    ti fs drain-file-system --mount-path ~/lab-agent-coding-work/v1-a
    ti fs create-layer-checkpoint --layer-id <layer-a-id> --checkpoint-id step-01 --output json
    ti fs drain-file-system --mount-path ~/lab-agent-coding-work/v1-b
    ti fs create-layer-checkpoint --layer-id <layer-b-id> --checkpoint-id step-01 --output json
    ti fs diff-layer --layer-id <layer-a-id> --output json
    ti fs diff-layer --layer-id <layer-b-id> --output json
    ```
    Confirm: all three mounts work at the same time; the same checkpoint id succeeds in two different layers; `only-b.txt` is absent from layer a's diff and `only-a.txt` from layer b's; and record what a path looks like in the diff output (absolute, relative to the base, with or without `payments-api/`). If a limit stops a fourth mount or a repeated checkpoint id, record the error text.
  - **Journal output (U1).**
    ```bash
    ti fs-journal create-journal --journal-id v1-journal --journal-kind agent --title v1
    ti fs-journal append-journal-entries --journal-id v1-journal --entry-json '{"type":"v1.started"}' --idempotency-key v1-a
    ti fs-journal append-journal-entries --journal-id v1-journal --entry-json '{"type":"v1.started"}' --idempotency-key v1-a
    ti fs-journal verify-journal --journal-id v1-journal --output json
    ```
    Paste the `verify-journal` stdout and record whether the repeated idempotency key added a second entry (it must not).
  - **Timings (U2).** Repeat `fork-layer` and `drain-file-system` plus `create-layer-checkpoint` five times each with `time` and record the median of each. These are only a sanity range for the manifest narration; the demo measures its own.
  - **Cleanup.** Unmount the three mounts, then `ti fs delete-layer --layer-ref <task-layer-id> --cascade`, and note whether `ti fs list-layers` still lists the layers afterwards.
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/12-agent-coding-platform.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: U1 and U2 are VERIFIED or have a recorded workaround, and the real samples are in section 4 for Task 5.

### Packet 12-V2: Verify: Starter branches, branch authentication and point-in-time parents
- Tasks: none (docs only)
- Depends on: 12-P0   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/12-agent-coding-platform.md` (section 4 only)
- Model: sonnet   Effort: M
- Items to confirm (paste the real output under section 4 in a block headed "Captured samples (12-V2)"):
  - **Seed a tiny fixture first** (the full seed comes in Task 31):
    ```bash
    ti db execute-sql-statement --db-cluster-id <fixture-cluster-id> --admin --sql "CREATE DATABASE IF NOT EXISTS fixture"
    ti db execute-sql-statement --db-cluster-id <fixture-cluster-id> --admin --sql "CREATE TABLE IF NOT EXISTS fixture.orders (id INT PRIMARY KEY, customer VARCHAR(40) NOT NULL, amount_cents INT NOT NULL, status VARCHAR(16) NOT NULL)"
    ti db execute-sql-statement --db-cluster-id <fixture-cluster-id> --admin --sql "INSERT INTO fixture.orders VALUES (1, 'cust-0001', 1000, 'paid'), (2, 'cust-0002', 2000, 'paid')"
    ```
  - **U3 create, list and state names.**
    ```bash
    ticloud serverless branch create --cluster-id <fixture-cluster-id> --display-name v2-a --no-color
    ticloud serverless branch list <fixture-cluster-id> -o json --no-color
    ```
    Paste both outputs. Repeat `list` every 10 seconds until the branch is ACTIVE and record the elapsed seconds and every state name seen. Record the JSON keys for the branch id, the state, the public endpoint host and port, and the user-name prefix.
  - **U4 branch authentication.** With the host, port and prefix from the list output and the read-only fixture user from Task 1:
    ```bash
    mysql --host <branch-host> --port 4000 --user '<prefix>.<read-only-user>' --password --ssl-mode=VERIFY_IDENTITY --execute "SELECT COUNT(*) FROM fixture.orders"
    ```
    Record whether the parent's read-only user and password work on the branch endpoint and the exact user-name rule. If they do not, try one user created before the branch existed, and record the result. If no documented non-interactive method works, set U4 to a blocking finding (section 9) and stop this plan here.
  - **U5 point-in-time branch of a branch.** After the first branch has been ACTIVE for a few minutes, create a branch of it at a whole-second timestamp that is after the branch's creation and before now:
    ```bash
    ticloud serverless branch create --cluster-id <fixture-cluster-id> --display-name v2-replay --parent-id <v2-a-branch-id> --parent-timestamp <RFC3339 second, for example 2026-10-19T14:05:07Z> --no-color
    ticloud serverless branch create --cluster-id <fixture-cluster-id> --display-name v2-too-early --parent-id <v2-a-branch-id> --parent-timestamp <a second before v2-a was created> --no-color
    ```
    Record the first command's output and time to ACTIVE, and the exact error of the second. Also read `SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')` on the v2-a branch twice, one second apart, to confirm the clock format `normalizeDbTime` expects.
  - **Cleanup.** `ticloud serverless branch delete --cluster-id <fixture-cluster-id> --branch-id <id> --force --no-color` for each branch, then `ticloud serverless branch list <fixture-cluster-id> -o json --no-color` shows none.
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/12-agent-coding-platform.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: U3, U4 and U5 are VERIFIED or recorded as a blocking finding, and the real samples are in section 4 for Tasks 5, 7 and 21.

### Packet 12-V3: Verify: Lake driver, Lake SQL and region
- Tasks: none (docs only)
- Depends on: 12-P0   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/12-agent-coding-platform.md` (section 4 only)
- Model: sonnet   Effort: M
- Items to confirm (probe scripts live outside the repo, in a scratch directory; paste outputs under a block headed "Captured samples (12-V3)"):
  - **U7 driver API.** In a scratch directory (not in the repo) write `probe.js`:
    ```js
    const { Client } = require('tidbcloudlake-driver');

    const main = async () => {
      const conn = await new Client(process.env.LAKE_DSN).getConn();
      const rows = await conn.queryIter("SELECT 1 AS one, 'x' AS two");
      console.log('iterator methods', Object.getOwnPropertyNames(Object.getPrototypeOf(rows)));
      console.log('schema fields', rows.schema().fields().map((field) => field.name));
      for await (const row of rows) console.log('row values', row.values());
      console.log('exec result', await conn.exec('CREATE DATABASE IF NOT EXISTS probe'));
      conn.close();
    };

    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
    ```
    ```bash
    npm init -y
    npm install tidbcloudlake-driver
    LAKE_DSN='lake://<user>:<password>@<host>:443/default?warehouse=agent-coding-wh' node probe.js
    node --input-type=module -e "import { Client } from 'tidbcloudlake-driver'; console.log(typeof Client)"
    ```
    Expected: the iterator lists `schema`; the schema fields are `one` and `two`; the row values are `[ 1, 'x' ]`; `exec` returns a number; the last command prints `function`. Record any difference (for example a different schema accessor or a default-only ESM import) and the exact fix for `lake-client.ts`.
  - **U8 SQL behaviours.** With a second probe `probe-sql.js` that runs the statement in `process.argv[2]` (reads print one JSON line per row, anything else prints the `exec` result), run in order, pasting each output:
    ```sql
    CREATE OR REPLACE TABLE probe.v (id INT, vec VECTOR(4), VECTOR INDEX idx_v(vec) distance = 'cosine')
    INSERT INTO probe.v VALUES (1, [0.1,0.2,0.3,0.4]), (2, [0.4,0.3,0.2,0.1])
    SELECT id, COSINE_DISTANCE(vec, [0.1,0.2,0.3,0.4]) AS d FROM probe.v ORDER BY d LIMIT 2
    CREATE OR REPLACE TABLE probe.ev (run_id STRING, attempt_id STRING, step INT, kind STRING, status STRING, model STRING, cost_usd DOUBLE, merged BOOLEAN, message STRING, emitted_at TIMESTAMP, source STRING)
    CREATE INVERTED INDEX idx_ev_message ON probe.ev(message)
    ```
    Then write one NDJSON object to S3 and load it through a connection, a stage and `COPY INTO`:
    ```bash
    printf '{"run_id":"r1","attempt_id":"attempt-2","step":7,"kind":"step","status":"failed","model":"fixture-model-b","cost_usd":0.03,"merged":false,"message":"ECONNRESET: Run the suite","emitted_at":"2026-10-17 10:00:00.250","source":"live"}\n' | aws s3 cp - s3://<bucket>/probe/events/one.ndjson
    ```
    ```sql
    CREATE OR REPLACE CONNECTION probe_s3 STORAGE_TYPE = 's3' ACCESS_KEY_ID = '<key-id>' SECRET_ACCESS_KEY = '<secret>'
    CREATE OR REPLACE STAGE probe_stage URL = 's3://<bucket>/probe/events/' CONNECTION = (CONNECTION_NAME = 'probe_s3')
    COPY INTO probe.ev FROM @probe_stage PATTERN = '.*[.]ndjson' FILE_FORMAT = (TYPE = NDJSON)
    SELECT COUNT(*) AS n FROM probe.ev WHERE MATCH(message, 'ECONNRESET')
    SELECT emitted_at, merged FROM probe.ev
    ```
    Record whether the vector insert works, whether the string timestamp loads into `TIMESTAMP`, whether `MATCH` finds the row loaded after the index was created, and how `COPY INTO` reports the load. Then create a task and run it on demand:
    ```sql
    CREATE OR REPLACE TASK probe_task WAREHOUSE = 'agent-coding-wh' SCHEDULE = 1 MINUTE AS COPY INTO probe.ev FROM @probe_stage PATTERN = '.*[.]ndjson' FILE_FORMAT = (TYPE = NDJSON)
    EXECUTE TASK probe_task
    ALTER TASK probe_task SUSPEND
    ```
    Record whether `EXECUTE TASK` runs and how long until the new file's rows appear. Finally, from a session bound to `agent-coding-wh`, try `ALTER WAREHOUSE 'agent-coding-wh' SUSPEND` and `DROP WAREHOUSE IF EXISTS 'agent-coding-wh'` on a second throwaway warehouse (create one named `agent-coding-probe`) and record whether the drop is refused.
  - **U9 region and S3 access.** Record the region the Lake console shows for the warehouse and whether it matches `aws-us-east-1`; record that the connection above could read the bucket with the IAM user's key. If the regions differ, record the nearest option and its cost in latency; do not continue to Task 8 until the region question is decided.
  - **Cleanup.** `DROP DATABASE IF EXISTS probe`, `DROP CONNECTION IF EXISTS probe_s3`, `DROP TASK IF EXISTS probe_task`, `DROP WAREHOUSE IF EXISTS 'agent-coding-probe'`, and `aws s3 rm s3://<bucket>/probe --recursive`.
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/12-agent-coding-platform.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: U7, U8 and U9 are VERIFIED or have a recorded workaround, and the exact change (if any) to `lake-client.ts` and `lakeSql.ts` is written down.

### Packet 12-V4: Verify: Starter export to S3 and the Lake Parquet load
- Tasks: none (docs only)
- Depends on: 12-V3   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/12-agent-coding-platform.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (paste outputs under a block headed "Captured samples (12-V4)"):
  - **U6 export output, states and layout.** Create a small ledger table on the org instance and export it:
    ```bash
    ti db execute-sql-statement --db-cluster-id <org-cluster-id> --admin --sql "CREATE DATABASE IF NOT EXISTS agent_coding"
    ti db execute-sql-statement --db-cluster-id <org-cluster-id> --admin --sql "CREATE TABLE IF NOT EXISTS agent_coding.ledger (run_id VARCHAR(40) NOT NULL, attempt_id VARCHAR(16) NOT NULL, step INT NOT NULL, checkpoint_id VARCHAR(40) NOT NULL, db_time VARCHAR(30) NOT NULL, tree_hash CHAR(64) NOT NULL, db_checksum VARCHAR(24) NOT NULL, db_rows INT NOT NULL, PRIMARY KEY (run_id, attempt_id, step))"
    ti db execute-sql-statement --db-cluster-id <org-cluster-id> --admin --sql "INSERT INTO agent_coding.ledger VALUES ('r1', 'attempt-1', 1, 'step-01', '2026-10-17T10:00:00.250Z', REPEAT('a', 64), '123', 2000), ('r1', 'attempt-1', 2, 'step-02', '2026-10-17T10:00:01.250Z', REPEAT('b', 64), '123', 2000)"
    ticloud serverless export create --cluster-id <org-cluster-id> --target-type S3 --s3.uri s3://<bucket>/probe/ledger/r1 --s3.access-key-id <key-id> --s3.secret-access-key <secret> --file-type PARQUET --filter agent_coding.ledger --force --no-color
    ticloud serverless export describe --cluster-id <org-cluster-id> --export-id <export-id> --no-color
    aws s3 ls s3://<bucket>/probe/ledger/ --recursive
    ```
    Paste the `create` output (where the export id is), every distinct `describe` output until the export finishes (the state words), and the object listing (the key layout under the URI). Record how long the export took.
  - **Parquet load into Lake.** Create the table and stage from `lakeSql.ts`'s intended shapes and load:
    ```sql
    CREATE OR REPLACE TABLE probe.ledger_lake (run_id STRING, attempt_id STRING, step INT, checkpoint_id STRING, db_time STRING, tree_hash STRING, db_checksum STRING, db_rows INT)
    CREATE OR REPLACE STAGE probe_ledger URL = 's3://<bucket>/probe/ledger/' CONNECTION = (CONNECTION_NAME = 'probe_s3')
    COPY INTO probe.ledger_lake FROM @probe_ledger PATTERN = '.*[.]parquet' FILE_FORMAT = (TYPE = PARQUET)
    SELECT COUNT(*) AS n FROM probe.ledger_lake WHERE run_id = 'r1'
    ```
    Expected: two rows. Record any column type that did not map (strings, ints) and the exact `PATTERN` that matched the real object keys (the pattern is matched against the path after the stage URL).
  - **Cleanup.** Drop the probe objects and `aws s3 rm s3://<bucket>/probe --recursive`.
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/12-agent-coding-platform.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: U6 is VERIFIED or has a recorded workaround, and the real samples are in section 4 for Task 21.

### Packet 12-V5: Verify: Starter memory, hybrid search and index delay
- Tasks: none (docs only)
- Depends on: 12-P0   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/12-agent-coding-platform.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (paste outputs under a block headed "Captured samples (12-V5)"):
  - **U10 account support and index delay.** On the org instance, run the vendor's own documented example (Steps 1 to 5 of the hybrid search page in section 4) in a scratch database: the `docs` table with the auto-embedding column, the full-text index and the vector index; six inserts; the vector query, the full-text query and the fused query.
    ```bash
    ti db execute-sql-statement --db-cluster-id <org-cluster-id> --admin --sql "CREATE DATABASE IF NOT EXISTS probe5"
    ```
    Run the statements from that page against `probe5` through `ti db execute-sql-statement --admin --sql "..."`. Record: does the table create (full-text and Auto Embedding available), do the three queries return the page's expected top results, what `EXPLAIN` of the fused query shows for `annIndex:` and `textSearch:`.
  - **Index delay.** Insert one new row, then poll the full-text query and the vector query every 2 seconds until the new row appears in each; record the seconds. This sets the real expectation for the 60-second poll in `writeLesson`.
  - **Cleanup.** `DROP DATABASE probe5`.
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/12-agent-coding-platform.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: U10 is VERIFIED or has a recorded workaround (for example, a region or plan change).

### Packet 12-V6 (optional): Verify: Essential changefeed sink to Lake as the ledger path
- Tasks: none (docs only)
- Depends on: 12-V4   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/12-agent-coding-platform.md` (section 4 only)
- Model: sonnet   Effort: L
- Items to confirm: this is the optional path in which an Essential instance streams the ledger to Lake instead of the Starter export. Nothing else in this plan depends on it, and it needs an Essential instance. Follow the vendor page in section 4 (bucket, instance and warehouse in the same region, the API-only changefeed with CANAL_JSON, the Lake integration task with its poll interval), record the setup time, the commands that worked, and the freshness of a row written to the ledger. If it is not run, leave the row in section 4 as "Verified (optional path, 12-V6)" with a note that it was not exercised.
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/12-agent-coding-platform.md` -> not higher than before
- Done when: the optional path is either recorded or explicitly left unexercised.

### Packet 12-P1: Scaffold the kit, `rfc3339Second` and `runCli`
- Tasks: 2, 3, 4
- Depends on: 12-V3   Shared runtime: none
- Files owned: `integrations/packages/agent-stack-kit/package.json`, `integrations/packages/agent-stack-kit/tsconfig.json`, `integrations/packages/agent-stack-kit/src/time.ts`, `integrations/packages/agent-stack-kit/src/cli.ts`, `integrations/packages/agent-stack-kit/test/time.test.ts`, `integrations/packages/agent-stack-kit/test/cli.test.ts`, `integrations/pnpm-lock.yaml`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/agent-stack-kit exec vitest run test/time.test.ts test/cli.test.ts` -> `Tests  12 passed (12)`
  - `pnpm --filter @lab/agent-stack-kit typecheck` -> exit 0
- Done when: Tasks 2, 3 and 4 are checked off and the gate output matches.

### Packet 12-P2: Pure CLI output parsers
- Tasks: 5
- Depends on: 12-P1, 12-V1, 12-V2   Shared runtime: none
- Files owned: `integrations/packages/agent-stack-kit/src/parse.ts`, `integrations/packages/agent-stack-kit/test/parse.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/agent-stack-kit exec vitest run test/parse.test.ts` -> `Tests  22 passed (22)` plus one case per real sample 12-V1 and 12-V2 pasted into section 4
  - `pnpm --filter @lab/agent-stack-kit typecheck` -> exit 0
- Done when: every real captured sample parses and Task 5's steps are checked off.

### Packet 12-P3: `tiFs` adapter
- Tasks: 6
- Depends on: 12-P2   Shared runtime: none
- Files owned: `integrations/packages/agent-stack-kit/src/tifs.ts`, `integrations/packages/agent-stack-kit/test/tifs.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/agent-stack-kit exec vitest run test/tifs.test.ts` -> `Tests  11 passed (11)`
  - `pnpm --filter @lab/agent-stack-kit typecheck` -> exit 0
- Done when: Task 6's steps are all checked off and the gate output matches.

### Packet 12-P4: `branches` adapter
- Tasks: 7
- Depends on: 12-P3   Shared runtime: none
- Files owned: `integrations/packages/agent-stack-kit/src/branches.ts`, `integrations/packages/agent-stack-kit/test/branches.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/agent-stack-kit exec vitest run test/branches.test.ts` -> `Tests  11 passed (11)`
  - `pnpm --filter @lab/agent-stack-kit typecheck` -> exit 0
- Done when: Task 7's steps are all checked off and the gate output matches.

### Packet 12-P5: Lake configuration and client
- Tasks: 8
- Depends on: 12-P1, 12-V3   Shared runtime: none
- Files owned: `integrations/packages/agent-stack-kit/src/lake-config.ts`, `integrations/packages/agent-stack-kit/src/lake-client.ts`, `integrations/packages/agent-stack-kit/test/lake-config.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/agent-stack-kit exec vitest run test/lake-config.test.ts` -> `Tests  8 passed (8)`
  - `pnpm --filter @lab/agent-stack-kit typecheck` -> exit 0 (a failure means the real driver differs from the documented shape: fix `lake-client.ts` only, using 12-V3's captured output)
- Done when: Task 8's steps are all checked off and the gate output matches.

### Packet 12-P6: S3 event helpers and sink
- Tasks: 9
- Depends on: 12-P1   Shared runtime: none
- Files owned: `integrations/packages/agent-stack-kit/src/s3-events.ts`, `integrations/packages/agent-stack-kit/src/s3-sink.ts`, `integrations/packages/agent-stack-kit/test/s3-events.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/agent-stack-kit exec vitest run test/s3-events.test.ts` -> `Tests  5 passed (5)`
  - `pnpm --filter @lab/agent-stack-kit typecheck` -> exit 0
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 12-P7: The kit's public surface
- Tasks: 10
- Depends on: 12-P3, 12-P4, 12-P5, 12-P6   Shared runtime: none
- Files owned: `integrations/packages/agent-stack-kit/src/index.ts`, `integrations/packages/agent-stack-kit/test/index.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/agent-stack-kit test` -> `Test Files  8 passed (8)` and `Tests  72 passed (72)` (plus any real-sample cases added in 12-P2)
  - `pnpm --filter @lab/agent-stack-kit typecheck` -> exit 0
  - `grep -c $'\xe2\x80\x94' integrations/packages/agent-stack-kit/src/*.ts` -> 0 for every file
- Done when: the kit is green. Plan 13 may start.

### Packet 12-P8: Demo scaffold and manifest
- Tasks: 11, 12
- Depends on: 12-P7   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/package.json`, `integrations/demos/agent-coding/tsconfig.json`, `integrations/demos/agent-coding/vitest.config.ts`, `integrations/demos/agent-coding/.env.example`, `integrations/demos/agent-coding/manifest.json`, `integrations/demos/agent-coding/test/manifest.test.ts`, `integrations/demos/agent-coding/runner/src`, `integrations/demos/agent-coding/runner/test`, `integrations/demos/agent-coding/traces`, `integrations/pnpm-lock.yaml`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run test/manifest.test.ts` -> `Tests  9 passed (9)`
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/agent-coding/.env.example` -> 8
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Tasks 11 and 12 are checked off and the gate output matches.

### Packet 12-P9: Fixture repo, attempt scripts and the script schema
- Tasks: 13
- Depends on: 12-P8   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/fixtures`, `integrations/demos/agent-coding/runner/src/scripts.ts`, `integrations/demos/agent-coding/runner/src/fixtureStore.ts`, `integrations/demos/agent-coding/runner/test/scripts.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/scripts.test.ts` -> `Tests  6 passed (6)`
  - `cd integrations/demos/agent-coding/fixtures/payments-api && node --test --test-reporter=tap test/charge.test.js` -> exit 1 with `# pass 2` and `# fail 2`
- Done when: Task 13's steps are all checked off and the gate output matches.

### Packet 12-P10: TAP parsing, scoring and the tree hash
- Tasks: 14
- Depends on: 12-P9   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/tap.ts`, `integrations/demos/agent-coding/runner/src/score.ts`, `integrations/demos/agent-coding/runner/src/tree.ts`, `integrations/demos/agent-coding/runner/test/tap.test.ts`, `integrations/demos/agent-coding/runner/test/score.test.ts`, `integrations/demos/agent-coding/runner/test/tree.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/tap.test.ts runner/test/score.test.ts runner/test/tree.test.ts` -> `Tests  20 passed (20)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 14's steps are all checked off and the gate output matches.

### Packet 12-P11: The scripted harness
- Tasks: 15
- Depends on: 12-P10   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/harness.ts`, `integrations/demos/agent-coding/runner/test/harness.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/harness.test.ts` -> `Tests  8 passed (8)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 15's steps are all checked off and the gate output matches.

### Packet 12-P12: Fixture rows, branch snapshot and embedding
- Tasks: 16
- Depends on: 12-P8   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/random.ts`, `integrations/demos/agent-coding/runner/src/fixtureData.ts`, `integrations/demos/agent-coding/runner/src/snapshot.ts`, `integrations/demos/agent-coding/runner/src/embedding.ts`, `integrations/demos/agent-coding/runner/test/fixtureData.test.ts`, `integrations/demos/agent-coding/runner/test/snapshot.test.ts`, `integrations/demos/agent-coding/runner/test/embedding.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/fixtureData.test.ts runner/test/snapshot.test.ts runner/test/embedding.test.ts` -> `Tests  21 passed (21)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 16's steps are all checked off and the gate output matches.

### Packet 12-P13: Starter SQL
- Tasks: 17
- Depends on: 12-P8, 12-V5   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/starterSql.ts`, `integrations/demos/agent-coding/runner/test/starterSql.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/starterSql.test.ts` -> `Tests  8 passed (8)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 17's steps are all checked off and the gate output matches.

### Packet 12-P14: Lake SQL
- Tasks: 18
- Depends on: 12-P8, 12-V3, 12-V4   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/lakeSql.ts`, `integrations/demos/agent-coding/runner/test/lakeSql.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/lakeSql.test.ts` -> `Tests  17 passed (17)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 18's steps are all checked off and the gate output matches, with any change 12-V3 and 12-V4 required already applied.

### Packet 12-P15: Synthetic history and run events
- Tasks: 19
- Depends on: 12-P11, 12-P12   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/events.ts`, `integrations/demos/agent-coding/runner/src/history.ts`, `integrations/demos/agent-coding/runner/test/events.test.ts`, `integrations/demos/agent-coding/runner/test/history.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/events.test.ts runner/test/history.test.ts` -> `Tests  12 passed (12)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 19's steps are all checked off and the gate output matches.

### Packet 12-P16: Check verdicts, control gating and the lesson text
- Tasks: 20
- Depends on: 12-P12   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/checks.ts`, `integrations/demos/agent-coding/runner/src/gates.ts`, `integrations/demos/agent-coding/runner/src/lesson.ts`, `integrations/demos/agent-coding/runner/test/checks.test.ts`, `integrations/demos/agent-coding/runner/test/gates.test.ts`, `integrations/demos/agent-coding/runner/test/lesson.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/checks.test.ts runner/test/gates.test.ts runner/test/lesson.test.ts` -> `Tests  22 passed (22)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 20's steps are all checked off and the gate output matches.

### Packet 12-P17: Configuration, branch environment and export helpers
- Tasks: 21
- Depends on: 12-P8, 12-V2, 12-V4   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/config.ts`, `integrations/demos/agent-coding/runner/src/branchEnv.ts`, `integrations/demos/agent-coding/runner/src/ticloudExport.ts`, `integrations/demos/agent-coding/runner/test/config.test.ts`, `integrations/demos/agent-coding/runner/test/branchEnv.test.ts`, `integrations/demos/agent-coding/runner/test/ticloudExport.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/config.test.ts runner/test/branchEnv.test.ts runner/test/ticloudExport.test.ts` -> `Tests  17 passed (17)` plus one case per real sample from 12-V2 and 12-V4
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 21's steps are all checked off and every real captured sample parses.

### Packet 12-P18: Run state and the teardown plan
- Tasks: 22
- Depends on: 12-P8   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/state.ts`, `integrations/demos/agent-coding/runner/src/stateStore.ts`, `integrations/demos/agent-coding/runner/src/teardownPlan.ts`, `integrations/demos/agent-coding/runner/test/state.test.ts`, `integrations/demos/agent-coding/runner/test/teardownPlan.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/state.test.ts runner/test/teardownPlan.test.ts` -> `Tests  7 passed (7)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 22's steps are all checked off and the gate output matches.

### Packet 12-P19: Push the winner to a local bare repository
- Tasks: 23
- Depends on: 12-P11   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/git.ts`, `integrations/demos/agent-coding/runner/test/git.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/git.test.ts` -> `Tests  1 passed (1)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 23's steps are all checked off and the gate output matches.

### Packet 12-P20: The whole-run test (RED)
- Tasks: 24
- Depends on: 12-P13, 12-P14, 12-P15, 12-P16, 12-P17, 12-P18, 12-P19   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/test/fakes.ts`, `integrations/demos/agent-coding/runner/test/runner.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/runner.test.ts` -> FAIL with `Cannot find module '../src/runner'` (the expected RED; the coordinator does not commit this packet alone)
- Done when: the test fails for the stated reason and for no other.

### Packet 12-P21: SQL wrapper, run context and the setup, intake and seed stages
- Tasks: 25, 26
- Depends on: 12-P20   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/sql.ts`, `integrations/demos/agent-coding/runner/src/context.ts`, `integrations/demos/agent-coding/runner/src/stages/setup.ts`, `integrations/demos/agent-coding/runner/src/stages/intake.ts`, `integrations/demos/agent-coding/runner/src/stages/seed.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> errors only in `runner/test/runner.test.ts` (missing `../src/runner` and its implicit `any`); none under `runner/src/` or in `runner/test/fakes.ts`
- Done when: Tasks 25 and 26 are checked off and the gate output matches.

### Packet 12-P22: Fan-out, work loop and winner stages
- Tasks: 27
- Depends on: 12-P21   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/stages/fanout.ts`, `integrations/demos/agent-coding/runner/src/stages/workloop.ts`, `integrations/demos/agent-coding/runner/src/stages/winner.ts`
- Model: sonnet   Effort: L
- Gate:
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> the same errors as 12-P21 and no others
- Done when: Task 27's steps are all checked off and the gate output matches.

### Packet 12-P23: Replay, Lake eval and lesson stages
- Tasks: 28
- Depends on: 12-P22   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/stages/replay.ts`, `integrations/demos/agent-coding/runner/src/stages/eval.ts`, `integrations/demos/agent-coding/runner/src/stages/lesson.ts`
- Model: sonnet   Effort: L
- Gate:
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> the same errors as 12-P21 and no others
- Done when: Task 28's steps are all checked off and the gate output matches.

### Packet 12-P24: The runner (GREEN)
- Tasks: 29
- Depends on: 12-P23   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/src/runner.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding exec vitest run runner/test/runner.test.ts` -> `Tests  12 passed (12)`
  - `pnpm --filter @lab/demo-agent-coding test` -> `Test Files  23 passed (23)` and `Tests  160 passed (160)`
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
- Done when: Task 29's steps are all checked off and the gate output matches. The coordinator commits Tasks 24 to 29 together as Task 29's commit.

### Packet 12-P25: Entry points
- Tasks: 30
- Depends on: 12-P24   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/runner/main.ts`, `integrations/demos/agent-coding/runner/seed-fixture.ts`, `integrations/demos/agent-coding/runner/teardown.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-coding typecheck` -> exit 0
  - `pnpm --filter @lab/demo-agent-coding test` -> `Test Files  23 passed (23)`
- Done when: Task 30's steps are all checked off and the gate output matches.

### Packet 12-P26: Seed the fixture and make the first live run
- Tasks: 31
- Depends on: 12-P25, 12-V1, 12-V2, 12-V3, 12-V4, 12-V5   Shared runtime: cloud-account
- Files owned: none (manual or docs step; `.env` is gitignored)
- Model: coordinator   Effort: L
- Gate:
  - every command in Task 31 produces the output the task quotes; the coordinator pastes that output into the packet report (never the secrets)
  - `mount | grep lab-agent-coding-work` -> no output after the runner exits
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: a hand-driven run passes all six checks and the runner exits with nothing mounted.

### Packet 12-P27: Public-content gate
- Tasks: 32
- Depends on: 12-P26   Shared runtime: none
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - `pnpm lab check-public` -> `0 findings`
  - `grep -rn $'\xe2\x80\x94' --exclude-dir=node_modules integrations/demos/agent-coding integrations/packages/agent-stack-kit integrations/docs/plans/12-agent-coding-platform.md` -> no output
- Done when: both commands are clean.

### Packet 12-P28: README and TALK-TRACK
- Tasks: 33
- Depends on: 12-P27   Shared runtime: none
- Files owned: `integrations/demos/agent-coding/README.md`, `integrations/demos/agent-coding/TALK-TRACK.md`
- Model: sonnet   Effort: M
- Gate:
  - `grep -c $'\xe2\x80\x94' integrations/demos/agent-coding/README.md integrations/demos/agent-coding/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
- Done when: Task 33's steps are all checked off and the gate output matches.

### Packet 12-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 12-P28   Shared runtime: cloud-account
- Files owned: `integrations/demos/agent-coding/traces/featured.json`
- Model: coordinator   Effort: L
- Gate:
  - `pnpm lab validate agent-coding` -> `agent-coding: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - `pnpm typecheck && pnpm test` from `integrations/` -> exit 0
  - teardown (Task 34) run and confirmed with this plan's section 5 commands
- Done when: the replay tells the whole story in under three minutes at 8x, all six checks end `pass`, and nothing is left billing.

## Deviations and open questions for the plan owner

- **Replay length.** The platform's "3 to 6 minutes of playback at 1x" definition of done cannot hold: branch creation and the Lake task interval make a real run 12 to 25 minutes of wall clock. Section 8 states the 8x target. If the owner wants a shorter trace, the options are a pool of pre-created branches (changes the claim) or `LAKE_EXECUTE_TASK=true` (changes what the freshness metric measures).
- **Added ledger columns.** The ledger has `tree_hash`, `db_checksum` and `db_rows` beside `(run_id, attempt_id, step, checkpoint_id, db_time)`, so the replay check can prove state, not just the failing test names.
- **UTC clock read.** Steps read `UTC_TIMESTAMP(3)` (formatted as ISO text) from the branch instead of `NOW()`, so the session time zone cannot shift the point-in-time parent.
- **Extra check and metrics.** `lesson-recalled` (a sixth check) and the supporting metrics `events-emitted`, `lake-events-visible` and `eval-query-ms` are additions to the agreed list. The seven agreed metrics are all present; "rows loaded per minute" uses unit `count` because the contract has no per-minute unit.
- **Per-run S3 prefix.** Events and the ledger export go under `S3_PREFIX/<run id>/` and the Lake stages are per run, so repeated runs never reload old objects.
- **Fixture and org instances are separate.** A read-only fixture instance (branched three plus one times) and an org instance (memory and ledger) keep branches byte-identical at the start; the cost is a second Starter instance.
- **Optional LLM mode** (`LAB_AGENT=llm`) is backlog and not built.
