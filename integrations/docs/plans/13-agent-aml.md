# Plan 13: TiDB Cloud Agent Stack, Anti-Money-Laundering Agent (Filesystem + TiDB X + Lake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a financial-services audience how an investigation agent can use three TiDB Cloud products together on synthetic data: every alert gets its own Filesystem layer, journal and vault grant plus a copy-on-write Starter branch for testing a rule change; past cases are recalled with one hybrid SQL statement; Lake measures precision and recall per rule version from simulated verdicts; and a skill file is committed to the shared base only after a human promotes it. Every claim is a measured number or one of five checks.

**Architecture:** One TypeScript runner is the transaction generator, the rule engine, the scripted agent harness and the orchestrator. It writes seeded synthetic transactions with planted ground truth into a TiDB Cloud Starter instance `harbor-core` (the architecture behind Starter is TiDB X), evaluates versioned rules over windows it reads back, and for each case drives the `ti` and `ticloud` CLIs and the Lake SQL client through the shared `@lab/agent-stack-kit` (created by Plan 12). History reaches Lake as Parquet exported from Starter to one S3 bucket and loaded by a Lake task; flags, simulated verdicts, ground truth and run events reach Lake as NDJSON through an S3 event sink. All AML-specific logic is in pure, tested modules under `runner/src`; kit calls are confined to `runner/src/live`.

**Tech Stack:** Node 22 + TypeScript (strict) with `@lab/runner-kit`, `@lab/contract` and `@lab/agent-stack-kit`, `zod` for fixtures, rows and environment, `mysql2` (through `createTidbPool`) for Starter and for the branch, `tsx`, Vitest. External: TiDB Cloud Starter, TiDB Cloud Filesystem (`ti`), `ticloud`, TiDB Cloud Lake, one S3 bucket.

**Depends on:** Plan 00 (platform), Plan 12 (agent-coding), which creates `@lab/agent-stack-kit`. Plan 13 imports from that package and never redefines it; section 4 lists the exact surface this plan consumes.

---

## 1. Why this demo

- **The question customers ask:** "We want investigation agents working our alert queue, but compliance will not let an agent touch production data or rewrite shared guidance on its own. How do we give it a workspace per case, a safe place to test a rule change, memory of past cases, and proof that it is getting better?" (asked by teams in financial services evaluating agent workloads)
- **Pattern:** Financial services teams asking how an investigation agent can keep case evidence isolated, test rule changes safely, remember past cases and improve over time without touching production data.
- **What TiDB proves here** (each is measured or checked in the demo):
  - One SQL statement on TiDB Cloud Starter recalls similar past cases by fusing a vector search and a full-text search (`hybrid-recall-ms`).
  - Isolation per case holds in files (a Filesystem layer, uncommitted until a human decides) and in the database (a Starter branch), and the demo proves the branch is isolated from production rules and alerts (`investigation-branch-isolated`) while reporting the real branch creation time (`branch-create-seconds`).
  - A candidate rule can be tried on the branch and its effect on alert volume measured there (`rule-change-alert-delta`) without a single production write.
  - TiDB Cloud Lake closes the learning loop: history and every flag with its (simulated) verdict land in Lake and one query yields precision per rule version and recall on planted cases (`precision-v1-simulated`, `precision-v2-simulated`, `lake-lookback-ms`).
  - A skill update is staged in a layer and reaches the shared base file system only on a human promote, and the commit is verified by reading the base back (`skill-commit-lands-on-base`); the case journal's hash chain verifies (`journal-verifies`).
  - History moves Starter to S3 to Lake with equal row counts (`lake-history-matches-export`).
- **What this demo does not claim:**
  - It makes no compliance, legal, regulatory or certification claim for any product. All data is synthetic, the watchlist is invented, and the reporting threshold is a named, configurable constant (`REPORTING_THRESHOLD_CENTS` in `runner/src/domain.ts`, overridable with `AML_REPORTING_THRESHOLD_CENTS`) used only so the generator and the rules agree. It is not advice about any real obligation.
  - The agent is a deterministic scripted harness, not a language model. Investigation steps come from `fixtures/playbook.json` and skills from `fixtures/skills/`. The demo measures the data infrastructure, not model quality. An `LAB_AGENT=llm` mode is backlog and is not built here.
  - Analyst verdicts are simulated from planted ground truth and labeled simulated wherever they appear. Precision figures describe the synthetic generator, not any real alert population.
  - It is not a transaction monitoring product. Rules are simple and are evaluated in the runner over rows read back from Starter.
  - Branch creation is not instant. Starter documents it as usually completing within a few minutes, the demo reports the measured time, and the runner overlaps it with other work.
  - It makes no performance claim. Branches are not for performance testing, the clock is accelerated (one tick is one simulated day), and the Lake lookback runs over about ten thousand rows.
  - Filesystem, branching and Lake are preview products and the `ti` CLI is a public preview whose flags can change. TiDB X is the architecture behind TiDB Cloud Starter, Essential and Premium; this demo uses it through Starter only. The optional Essential changefeed sink to Lake is not built.

## 2. What the audience sees

### Flow diagram

```
 [txn-generator] --txn-writes--> [harbor-core] --window-scans--> [rule-engine] --alerts-to-agent--> [agent-harness]
    (source)                     (Starter) ^                         |                                  |
                                    |      +-----alerts-written------+                                  |
                                    |                                                                   |
                                    +--branch-create--> [investigation-branch] <--what-if-queries-------+
                                    |                                                                   |
                                    +--parquet-export--> [s3-bucket] <--run-events----------------------+
                                                            |                                           |
                                                            +--lake-load--> [lake] --lookback-queries--> [agent-harness]

 [agent-harness] --recall-queries-----> [episodic-memory]      [agent-harness] --evidence-writes--> [case-layers]
                 <--lesson-written----                                         --audit-entries----> [case-journal]
                                                                               --vault-grants-----> [vault]
                                                                               --skill-commits----> [skills-base]
```

Nodes and their `x`, `y` percent positions: `txn-generator` (6, 15), `harbor-core` (28, 15), `episodic-memory` (52, 15), `rule-engine` (28, 45), `agent-harness` (52, 45), `case-layers` (82, 22), `case-journal` (82, 42), `vault` (82, 60), `skills-base` (82, 80), `investigation-branch` (28, 72), `s3-bucket` (52, 76), `lake` (52, 94).

| Edge id | From | To | Label | Emitted by |
|---|---|---|---|---|
| `txn-writes` | txn-generator | harbor-core | transactions written | setup, every baseline tick, injections |
| `window-scans` | harbor-core | rule-engine | rule windows read | every evaluation |
| `alerts-written` | rule-engine | harbor-core | alerts stored | every evaluation |
| `alerts-to-agent` | rule-engine | agent-harness | alerts handed to the agent | every evaluation |
| `recall-queries` | agent-harness | episodic-memory | hybrid recall | recall step, lesson check |
| `lesson-written` | agent-harness | episodic-memory | lesson stored | promote |
| `evidence-writes` | agent-harness | case-layers | evidence written to a layer | evidence step, skill staging |
| `what-if-queries` | agent-harness | investigation-branch | rule what-if SQL | rule test |
| `audit-entries` | agent-harness | case-journal | audit entries appended | every journal append |
| `vault-grants` | agent-harness | vault | ten minute read grant | open investigation |
| `branch-create` | harbor-core | investigation-branch | copy-on-write branch | open investigation |
| `parquet-export` | harbor-core | s3-bucket | Parquet export | setup, Lake evaluation |
| `run-events` | agent-harness | s3-bucket | flags and run events (NDJSON) | analyst verdict |
| `lake-load` | s3-bucket | lake | COPY INTO task | setup, Lake evaluation |
| `lookback-queries` | lake | agent-harness | history lookback and eval | lookback step, Lake evaluation |
| `skill-commits` | agent-harness | skills-base | skill layer committed | promote |

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | `setup` | Setup | Schema, rules v1, synthetic watchlist, past cases, skills and the vault secret are seeded. Ninety days of seeded transactions with one planted rapid in-out chain are written, the v1 rules replay over them, history is exported to S3 as Parquet and the Lake load task catches up. | "Harbor Mutual is a fictional bank. We seed synthetic customers, a synthetic watchlist and months of transactions into a TiDB Cloud Starter instance, then export the history to Lake through S3." |
| 2 | `baseline-traffic` | Baseline Traffic | Each tick writes one simulated day of ordinary traffic; the engine reads the last fourteen days back and raises alerts; scores update. | "Ordinary traffic keeps flowing and the v1 rules keep raising alerts. Notice how many are false positives against the ground truth we planted." |
| 3 | `inject-pattern` | Inject a Pattern | A control plants a three-account structuring ring, or adds a watchlist entry close to an existing customer's name. Ground truth is recorded. | "Now we plant a structuring ring, or a name that is close to a new watchlist entry. We know the answer because we planted it." |
| 4 | `alert` | Alert | The rule engine evaluates and stores new alerts; the planted-coverage check runs. | "The rule engine flags it. Every planted case must be flagged, and the demo checks that." |
| 5 | `open-investigation` | Open an Investigation | Branch creation starts; a case layer, journal and vault grant are created; the delegated read is proven. | "Each alert gets its own file system layer, a journal, a ten minute vault grant and a copy-on-write database branch. Branch creation takes minutes, so the agent keeps working while it finishes." |
| 6 | `recall-similar-cases` | Recall Similar Cases | The playbook runs: working set, hybrid recall, Lake lookback, evidence files in the case layer. | "The agent recalls similar past cases with one hybrid query, vector plus full text, and looks back through months of history in Lake. Then it writes evidence and a draft into the case layer. Nothing is filed; a human decides." |
| 7 | `test-rule-on-branch` | Test a Rule on the Branch | Candidate rule v2 and its replayed alerts are written to the branch only; alert volume is counted by SQL on the branch; isolation is probed on both sides. | "The agent tries a tighter candidate rule on the branch. Production rules and alerts are untouched, and the demo proves it." |
| 8 | `analyst-verdict` | Analyst Verdict (simulated) | Verdicts for production v1 flags and branch-shadow v2 flags are derived from ground truth and written as NDJSON to S3. | "Verdicts here are simulated from the planted ground truth and labeled that way. They stand in for a human analyst." |
| 9 | `lake-eval` | Lake Evaluation | A second Parquet export carries the new transactions; Lake loads exports and events; one query yields precision per rule version; one yields recall on planted cases. | "Flags, verdicts and history land in Lake. One query gives precision per rule version, and recall on planted cases." |
| 10 | `distill-commit-skill` | Distill and Commit a Skill | The distiller writes the updated skill into a skills layer and waits. Promote commits the layer and reads the base back. | "The agent writes what it learned into a skill file inside a layer. A human presses promote, and only then does the layer commit to the shared skills folder." |
| 11 | `lesson-to-memory` | Lesson to Memory | A lesson row is inserted into episodic memory and recalled; the journal hash chain is verified. | "The lesson goes into episodic memory, so the next similar case recalls it. The journal hash chain then verifies the whole investigation." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `inject-structuring-ring` | Inject structuring ring | `injectStructuringRing`: plants three accounts with near-threshold cash deposits across at least two branches and a sweep to one shared counterparty, writes ground truth to Starter and Lake, then evaluates. |
| `inject-watchlist-near-match` | Inject watchlist near-match | `injectWatchlistNearMatch`: inserts a synthetic list entry close to an existing customer's name, waits until full-text search sees it, rescreens accounts that share a name token, then evaluates. |
| `open-investigation` | Open investigation | `openInvestigation`: picks the top open alert (structuring first, then highest score), starts branch creation, opens the layer, journal and grant, and runs the playbook steps from `fixtures/playbook.json`. |
| `test-rule-on-branch` | Test rule on branch | `testRuleOnBranch` then `recordVerdicts`, `evaluateInLake` and `stageSkillUpdate` in order. |
| `promote-skill` | Promote skill | `promoteSkill`: the human approval step. Commits the staged skills layer, verifies the base, writes the lesson and verifies the journal. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `every-planted-case-flagged` | Every Planted Case Flagged | `plantedCoverage` over production alerts and `ground_truth`: no planted account lacks an alert from its own pattern's rule. `observed` carries `flagged of planted`. Pending after each injection, evaluated on every tick. |
| `investigation-branch-isolated` | Branch Isolated from Production | `evaluateIsolation`: the branch holds the v2 rule and v2 alerts (both counts above 0) while production holds none. `observed` carries both sides' counts. |
| `journal-verifies` | Case Journal Verifies | The kit's `verifyJournal` for the case journal returns ok after the last appended entry. Pending when the case opens. |
| `skill-commit-lands-on-base` | Skill Commit Lands on the Base | After `commitLayer`, `ti fs read-file` on the base skill path returns exactly the staged text. `observed` carries the commit time. |
| `lake-history-matches-export` | Lake History Matches the Export | `SELECT COUNT(*) FROM harbor.txn_history WHERE txn_id <= cutoff` reaches the Starter count for the same cutoff. Evaluated after the first export in setup and after the second in the Lake evaluation. |

## 3. Metrics

Targets are demo design goals, not vendor claims. Only `planted-recall` carries one (100). Units come from the contract's `MetricUnitSchema`; counts per minute and per thousand use `count` with the rate in the label.

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `alerts-per-minute` | Alerts per Minute (accelerated clock) | count | both | neutral | `affectedRows` of the `INSERT IGNORE INTO alerts` in one tick (new alerts only), passed through `alertsPerMinute({ newAlerts, tickWallMs: AML_TICK_MS })` = `newAlerts * 60000 / tickWallMs`. One tick simulates one day of transactions. |
| `planted-recall` | Planted-Pattern Recall | % | both | higher (target 100) | `plantedCoverage({ alerts, groundTruth })`: planted accounts with an alert from their own pattern's rule over all planted accounts, times 100, from `SELECT ... FROM alerts` and `ground_truth`. |
| `false-positives-per-1000` | False Positives per 1,000 Non-Planted Transactions | count | both | lower | `scoreRules` over active production rules: false-positive alerts (alert account not planted for that rule's pattern) times 1000 over `SELECT COUNT(*) FROM transactions WHERE account_id NOT IN (SELECT account_id FROM ground_truth)`, summed over rules. |
| `layer-open-seconds` | Case Layer and Journal Open Time | s | tile | lower | `Date.now()` delta from the open-investigation control to `openCaseWorkspace` returning (directory, layer, journal, grant). |
| `branch-create-seconds` | Investigation Branch Create Time | s | tile | lower | `Date.now()` delta from just before `branches.create` to `branches.waitActive` resolving. |
| `investigation-open-time` | Investigation Open Time (layer plus branch) | s | tile | lower | `Date.now()` delta from the control until layer, journal, grant, recall, evidence files and the active branch all exist. |
| `hybrid-recall-ms` | Hybrid Recall Latency | ms | both | lower | `timed()` around `buildHybridRecallSql` executed through the pool: vector CTE plus `fts_match_word` CTE fused by RRF (constant 60), top 3, over `episodic_memory`. Emitted at recall and again at the lesson check. |
| `lake-lookback-ms` | Lake Lookback Latency (months of history) | ms | both | lower | `timed()` around the band-peers (or account lookback) query over `AML_LOOKBACK_MONTHS` months of `harbor.txn_history`, including network time. |
| `lake-load-seconds` | Starter Export to Lake Visible | s | tile | lower | Seconds from `EXECUTE TASK harbor_load` until `SELECT COUNT(*) FROM harbor.txn_history WHERE txn_id <= cutoff` reaches the Starter count, polled every 5 seconds. Excludes export job time, which is logged. |
| `rule-change-alert-delta` | Rule Change Alert Volume Delta (measured on the branch) | count | tile | neutral | On the branch: `COUNT` of v2 minus `COUNT` of v1 structuring alerts from `SELECT rule_version, COUNT(*) FROM alerts WHERE rule_id = ? GROUP BY rule_version`. Negative means quieter. |
| `precision-v1-simulated` | Rule v1 Precision (simulated analyst verdicts) | % | tile | higher | Lake `ruleEvalSql`, scope `production`, structuring v1: confirmed over flags, times 100. Simulated verdicts. |
| `precision-v2-simulated` | Rule v2 Precision (simulated analyst verdicts) | % | tile | higher | Same query, scope `branch-shadow`, structuring v2. Simulated verdicts. |

With the default seed the pure scenario test (Task 8) pins the story the live run should reproduce: a 90 day history of about ten thousand transactions, four cash-intensive look-alike businesses producing roughly fifty v1 structuring false positives, three planted ring accounts flagged by both v1 and v2, and v2 raising only the three planted alerts. Live numbers will differ slightly because the runner replays the same engine over rows read back from Starter.

## 4. Verified facts and sources

Every product capability this demo relies on, with the doc URL checked on 2026-10-19 (CLI reference pages are `https://docs.pingcap.com/ai/ti-fs-<command>.md`). Rows marked **UNVERIFIED** each have a verify packet in section 10 that runs before any packet depending on them.

**Kit surface this plan consumes from Plan 12** (`@lab/agent-stack-kit`, final API per Plan 12's "Kit API reference", never redefined here):

- `runCli({ bin, args, env? })` returns `{ code, stdout, stderr }` and never rejects, so `runner/src/live/cli.ts` wraps it as `runOrThrow`.
- `tiFs` methods take no file system id (it comes from `TI_FS_FILE_SYSTEM_ID` in the environment): `createLayer({ baseRootPath, layerName, tags? }) -> { layerId }`, `diffLayer({ layerId }) -> string[]`, `commitLayer`, `deleteLayer({ layerRef, cascade? })`, `createJournal({ journalId, journalKind?, title? })`, `appendJournal({ journalId, entry, idempotencyKey })`, `verifyJournal({ journalId }) -> { ok }`, `createGrant({ agentId, scope, permission, ttl }) -> token string` (the secret must already exist, so setup creates `watchlist-api` first).
- `branches.create({ clusterId, name, parentId?, parentTimestamp? }) -> { branchId, state }`, `waitActive({ clusterId, branchId, timeoutMs?, pollMs? }) -> BranchInfo { branchId, state, host?, port?, userPrefix? }`, `remove`, `list -> BranchInfo[]`. Plan 12 uses the database clock `UTC_TIMESTAMP(3)` for branch timing; this plan does the same for the point in time (`serverNowMs`).
- `lakeConfigFromEnv(env)` reads `LAKE_HOST`, `LAKE_USER`, `LAKE_PASSWORD`, `LAKE_WAREHOUSE`, optionally `LAKE_DATABASE` and `LAKE_PORT`; `createLakeClient(config).query(sql)` returns rows (non-read statements return `[]`).
- `createS3EventSink({ bucket, prefix, region }).write(lines) -> { key }` writes one NDJSON object per call from the default AWS credential chain; `runner/src/live/sinks.ts` buffers rows and flushes them as one call. `rfc3339Second(Date | string)` rounds up to the next second.

`mountLayer`, `unmount`, `checkpoint`, `forkLayer`, `grep`, `toNdjson` and the parsers exist in the kit but this plan does not need them: layer files are written with `ti fs copy-file --layer-id`, so no FUSE mount is required. The kit's test seams `createTiFs(run, clock?)` and `createBranches(run, { clock?, sleep? })` are Plan 12's concern; this plan's pure modules never import the kit.

| Fact | Source | Status |
|---|---|---|
| TiDB Cloud Filesystem is a public preview with no SLA: a persistent file namespace for agents; small files and metadata live in TiDB and large files in object storage. | [Filesystem intro](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-intro/) | Verified |
| The `ti` CLI is a public preview whose flags can change. Install with `curl -fsSL https://github.com/tidbcloud/ti-cli/releases/latest/download/install.sh \| sh -s -- --yes`, then `ti configure`. `TI_FS_FILE_SYSTEM_ID` and `TI_FS_TOKEN` select the file system and token for every `ti fs` command. | [Quick start](https://docs.pingcap.com/tidbcloud-filesystem/filesystem-quick-start/), [copy-file](https://docs.pingcap.com/ai/ti-fs-copy-file.md) | Verified |
| Layer commands and flags: `create-layer --base-root-path --layer-name --durability-mode restore-safe [--tag k=v]` (returns `layer_id`; `restore-safe` is the only mode), `describe-layer`, `diff-layer --layer-id`, `list-layers --output text`, `commit-layer --layer-id`, `rollback-layer --layer-id`, `delete-layer --layer-ref [--cascade]`. A commit applies to the base file system (not the parent, for a fork) and can fail on conflict; rollback does not return to a checkpoint. | [Manage layers](https://docs.pingcap.com/tidbcloud-filesystem/manage-filesystem-layers/) | Verified |
| Only `copy-file`, `find-files` and `search-file-content` take `--layer-id`; `read-file`, `list-files`, `describe-file`, `delete-file`, `move-file` and `create-directory` act on the base. `copy-file` supports `--from-local`, `--to-remote`, `--layer-id` and `--overwrite`, and `--layer-id` copy is not recursive. Mounts, checkpoints and `drain` need FUSE; this plan uses none of them. | [Manage layers](https://docs.pingcap.com/tidbcloud-filesystem/manage-filesystem-layers/), [copy-file](https://docs.pingcap.com/ai/ti-fs-copy-file.md), [mount](https://docs.pingcap.com/ai/ti-fs-mount-file-system.md) | Verified |
| Journals are append-only and hash-chained. `create-journal [--journal-id] [--journal-kind] [--title]`; `append-journal-entries --journal-id` with an entry whose `type` matches lowercase letters, digits, `_`, `.`, `-` and starts with a letter, plus `subjects`, `summary` and a retry-safe `--idempotency-key`; `verify-journal --journal-id` verifies the chain. | [append](https://docs.pingcap.com/ai/ti-fs-journal-append-journal-entries.md), [create](https://docs.pingcap.com/ai/ti-fs-journal-create-journal.md), [verify](https://docs.pingcap.com/ai/ti-fs-journal-verify-journal.md) | Verified |
| Vault: `ti fs-vault create-secret --secret-name <s> --field KEY=@file`; `create-grant --agent-id --permission read --scope <secret>/<field> --ttl 10m [--token-only]`; a delegated token reads with `read-secret --secret-name --field --format raw` and `TI_VAULT_TOKEN`. | [create-secret](https://docs.pingcap.com/ai/ti-fs-vault-create-secret.md), [create-grant](https://docs.pingcap.com/ai/ti-fs-vault-create-grant.md), [read-secret](https://docs.pingcap.com/ai/ti-fs-vault-read-secret.md) | Verified |
| Regions: aws-us-east-1, aws-us-west-2, aws-ap-southeast-1, alicloud-ap-southeast-1, gcp-us-east1, azure-centralus. Pricing is pay as you go on storage, read and write requests, and egress. `ti fs delete-file-system --file-system-id` starts an asynchronous delete and needs TiDB Cloud API credentials. | [Regions and limitations](https://docs.pingcap.com/tidbcloud-filesystem/regions-and-limitations/), [pricing](https://www.pingcap.com/tidb-cloud-filesystem-pricing-details/), [delete-file-system](https://docs.pingcap.com/ai/ti-fs-delete-file-system.md) | Verified |
| The `ti fs` output the kit parses (layer id, diff paths, journal verify, branch state) is covered by Plan 12's parser tests; this plan adds no parsing of `ti` output. | Plan 12 kit tests | Verified by Plan 12 |
| Limits on layers and checkpoints (counts, sizes) and the latency of `create-layer` and `commit-layer`. The demo creates one case layer and one skills layer per case. | none public | **UNVERIFIED**: 13-V1 creates and commits layers and records timings and any limit error. |
| `ti fs copy-file --from-local --to-remote <existing base path> --layer-id <id> --overwrite` records a modification of an existing base file inside the layer, `diff-layer` lists it, and `commit-layer` applies it so the base shows the new text. | none public for the overwrite case | **UNVERIFIED**: 13-V1. Workaround if refused: delete then copy inside the layer. |
| The built kit barrel matches Plan 12's API reference above (names, argument objects, returns). | `integrations/packages/agent-stack-kit/src/index.ts` | VERIFIED offline 2026-10-19 (13-V0): every call site in Tasks 20 to 24 typechecks against the built kit with no changes. |
| Starter branching is a public preview, not available on Dedicated; copy-on-write, usually a few minutes; point in time within the last 24 hours (free) or 14 days (spending limit above 0); five branches per organization by default; source at most 100 GiB and not throttled; 10 GiB branch storage (free) or 100 GiB; not for performance testing. A branch is a separate instance, and TiFlash replicas are temporarily unavailable in a new branch while they rebuild. | [Branch overview](https://docs.pingcap.com/tidbcloud/branch-overview/), [manage](https://docs.pingcap.com/tidbcloud/branch-manage/) | Verified |
| `ticloud serverless branch create --cluster-id <id> --display-name <name> [--parent-id <branch id>] [--parent-timestamp <RFC3339>]`; `branch delete` and `branch list` exist. `ti db create-db-cluster-branch` has no parent-timestamp option, so the timestamped branch uses `ticloud` through the kit. | [ticloud branch create](https://docs.pingcap.com/tidbcloud/ticloud-branch-create/), [ti db branch](https://docs.pingcap.com/ai/ti-db-create-db-cluster-branch/) | Verified |
| The branch's host and port come back from `waitActive`, its SQL user is `<userPrefix>.<name>` (`runner/src/branchEnv.ts`), and the password equals the instance password or `AML_BRANCH_PASSWORD`. | none public | **UNVERIFIED**: 13-V2. `AML_BRANCH_PASSWORD` is the fallback. |
| A branch created with `--parent-timestamp` two seconds before now already contains rows committed about a second after the alert write. | none public | **UNVERIFIED**: 13-V2 measures it. `pointInTimeMs` leaves a safety margin. |
| How branch usage is billed on Starter. | [Starter pricing](https://www.pingcap.com/tidb-cloud-starter/) | **UNVERIFIED**: 13-V2 reads the page and records the formula before any recording. |
| Starter SQL: `EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", col)` generated vector column, `FULLTEXT INDEX ... WITH PARSER STANDARD`, `VECTOR INDEX ((VEC_COSINE_DISTANCE(col)))`, `VEC_EMBED_COSINE_DISTANCE(col, 'text')`, `fts_match_word('terms', col)` with OR semantics over tokens and BM25 relevance; the documented hybrid query fuses a vector CTE and an `fts_match_word` CTE with reciprocal rank fusion, constant 60, with a `READ_FROM_STORAGE(TIFLASH[...])` hint on the vector side. Full-text search on Starter runs only in some AWS regions including N. Virginia; auto embedding is AWS only. | [Quickstart via SQL](https://docs.pingcap.com/ai/quickstart-via-sql/), [full-text](https://docs.pingcap.com/ai/vector-search-full-text-search-sql/), [hybrid](https://docs.pingcap.com/ai/vector-search-hybrid-search-sql/) | Verified |
| A newly inserted watchlist or memory row becomes visible to `fts_match_word` and to the vector index quickly enough to rescreen or recall immediately. | The hybrid page says scores can change after TiFlash reorganizes new rows | **UNVERIFIED**: 13-V4 measures the delay. The runner polls up to 60 seconds before rescreening and about 30 seconds before the lesson rank log. |
| Starter export to S3: `ticloud serverless export create -c <id> --file-type parquet --target-type S3 --s3.uri <uri> --s3.access-key-id <id> --s3.secret-access-key <secret> --filter <db.table> [--where <cond>] [--force]`; `export describe -c <id> -e <export id>`. Exports are one-shot jobs. Starter has no changefeed; Essential has a preview changefeed "Sink to TiDB Cloud Lake" (AWS only, API only, CSV snapshot plus CANAL_JSON, Lake polls every 60 seconds). Starter is GA, Essential is public preview. | [export create](https://docs.pingcap.com/tidbcloud/ticloud-serverless-export-create/), [describe](https://docs.pingcap.com/tidbcloud/ticloud-serverless-export-describe/), [serverless export](https://docs.pingcap.com/tidbcloud/serverless-export/), [Essential sink to Lake](https://docs.pingcap.com/tidbcloud/data-pipeline-essential-sink-to-lake/) | Verified |
| The folder layout an export writes under `--s3.uri`, the Parquet type written for `DATETIME(3)` and `BIGINT`, the text `export create` prints (for the export id) and the states `export describe` prints. `parseExportId` and `exportState` in `runner/src/exportParse.ts` are written against guesses. | none public | **UNVERIFIED**: 13-V3 records real output and corrects the parsers and the stage pattern. |
| TiDB Cloud Lake is a preview cloud data warehouse with compute (warehouses) separate from storage. Warehouses bill per second while running and auto-suspend after five minutes idle by default; cost is warehouse, storage, cloud service (API requests) and service hosting. | [Lake overview](https://docs.pingcap.com/tidbcloudlake/lake-overview/), [pricing](https://docs.pingcap.com/tidbcloudlake/pricing-billing/) | Verified |
| Lake SQL: `CREATE CONNECTION [IF NOT EXISTS] c STORAGE_TYPE = 's3' ACCESS_KEY_ID = ... SECRET_ACCESS_KEY = ... REGION = ...`; `CREATE STAGE [IF NOT EXISTS] s URL = 's3://bucket/prefix/' CONNECTION = (CONNECTION_NAME = 'c')`; `COPY INTO t FROM @s/path PATTERN = '<regex>' FILE_FORMAT = (TYPE = PARQUET \| NDJSON)` maps keys and columns by name and skips already loaded files unless `FORCE = true`; `CREATE TASK [IF NOT EXISTS] t WAREHOUSE = 'w' SCHEDULE = 1 MINUTE AS BEGIN ...; END;` runs several statements in order and needs `ALTER TASK t RESUME`; `EXECUTE TASK t` runs it now. | [COPY INTO](https://docs.pingcap.com/tidbcloudlake/copy-into-table.md), [CREATE CONNECTION](https://docs.pingcap.com/tidbcloudlake/create-connection.md), [CREATE STAGE](https://docs.pingcap.com/tidbcloudlake/create-stage.md), [CREATE TASK](https://docs.pingcap.com/tidbcloudlake/create-task.md), [EXECUTE TASK](https://docs.pingcap.com/tidbcloudlake/execute-task.md) | Verified |
| The Node.js driver is the npm package `tidbcloudlake-driver` (`Client`, `getConn`, `exec`, `queryIter`), read from the docs page on 2026-10-19; the Lake MCP server and `lakesql` also exist. | [Connect using Node.js](https://docs.pingcap.com/tidbcloudlake/connect-using-node-js.md) | Package, exports and import form VERIFIED offline 2026-10-19 against installed `tidbcloudlake-driver` 0.34 (see Plan 12 U7; its row iterator is not async-iterable, so the kit loops on `next`). **UNVERIFIED** only for `query` against a real warehouse (13-V3). |
| Which Lake regions pair with an aws-us-east-1 bucket, and that the bucket, Starter instance and warehouse can all sit in aws-us-east-1. | none public | **UNVERIFIED**: 13-V3. |
| Lake loads Parquet columns written from Starter `DATETIME(3)` and NDJSON strings shaped `YYYY-MM-DD HH:MM:SS` into `TIMESTAMP` columns; `PATTERN` regexes match files in folders below the stage path; `EXECUTE TASK` is allowed while the minute schedule is also running. | none public | **UNVERIFIED**: 13-V3. Workarounds: declare the column `STRING` and cast in queries, or load with a `COPY INTO` transform. |
| Teardown commands: `ti fs delete-file --path <p> --recursive` (documented); `ticloud serverless branch delete` flags; the command that deletes a Starter instance; suspending a Lake warehouse from SQL. | [Manage layers](https://docs.pingcap.com/tidbcloud-filesystem/manage-filesystem-layers/) for the first only | **UNVERIFIED**: 13-V5. The console is the fallback for each. |

## 5. Prerequisites, cost, and teardown

- **Accounts and access:**
  - A TiDB Cloud organization with a **Starter** instance in aws-us-east-1 (full-text search on Starter runs only in some AWS regions, including N. Virginia). A spending limit above zero lets the point-in-time branch reach further back than 24 hours; the demo needs only seconds. Note the instance id as `AML_CLUSTER_ID`, and create a SQL user for the demo.
  - A TiDB Cloud Filesystem file system in aws-us-east-1 and its owner token, selected by `TI_FS_FILE_SYSTEM_ID` (no kit method takes a file system id; it comes from the environment). Plan 12 Task 1 creates the same kind of resource and is the model for the steps below.
  - TiDB Cloud API credentials configured for `ti` and `ticloud` (`ti configure`, `ticloud config create --profile-name <name> --public-key <key> --private-key <key>`).
  - A TiDB Cloud Lake organization with a warehouse and a database user; the host, user and password go in `LAKE_HOST`, `LAKE_USER`, `LAKE_PASSWORD` and `LAKE_WAREHOUSE` (optionally `LAKE_PORT`, `LAKE_DATABASE`), exactly what the kit's `lakeConfigFromEnv` reads.
  - One S3 bucket in aws-us-east-1 and a dedicated IAM user that can list the bucket and put, get and delete objects in it only. The keys go in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (the kit's S3 sink reads the default AWS credential chain) and are also used by `ticloud serverless export create` and by the Lake `CREATE CONNECTION`, and are never written to a trace or log (the runner prints only redacted arguments).
- **Local tools:** macOS or Linux, Node 22, pnpm, the `ti` and `ticloud` CLIs, the `aws` CLI (the runner uses it to clear the Lake prefix when `AML_RESET=true`), optionally `lakesql`. No FUSE or macFUSE is needed because the plan never mounts a layer. `tiup` and Docker are not used.
- **Cost model** (no prices are stated here; read each page when you record):
  - Starter bills Request Units and storage with a free monthly quota: `cost = max(0, RU used - free RU) x RU rate + max(0, GiB-month - free GiB) x storage rate`. [Starter pricing](https://www.pingcap.com/tidb-cloud-starter/) and [pricing details](https://www.pingcap.com/tidb-cloud-starter-pricing-details/). Auto embedding usage is described at [Auto Embedding Overview](https://docs.pingcap.com/ai/integrations/vector-search-auto-embedding-overview/). Branch billing is UNVERIFIED (13-V2).
  - Filesystem bills storage, requests and egress: `cost = GB-month x tier rate + reads x read rate + writes x write rate + GB egress x egress rate`. [Filesystem pricing](https://www.pingcap.com/tidb-cloud-filesystem-pricing-details/). A recording writes a few dozen small files.
  - Lake bills `sum over warehouses of (hourly rate for size and edition / 3600 x seconds running) + TB-month x storage rate + API requests / 10,000 x request rate`. [Lake pricing](https://docs.pingcap.com/tidbcloudlake/pricing-billing/). The one minute load task keeps the warehouse awake and every poll is an API request, so suspend the task and the warehouse the moment you stop.
  - S3 bills storage and requests: [S3 pricing](https://aws.amazon.com/s3/pricing/). The bucket holds a few megabytes.
- **Teardown (exact commands, in order):**
  1. From `integrations/`: `pnpm --filter @lab/demo-agent-aml teardown`. It deletes every case branch and layer recorded in the `cases` table, any leftover branch named `aml-case-*`, `/harbor` in the file system, and the Lake task, stage, connection and database. Expected: one `ok` or `skipped` line per object, ending with the reminder to remove the bucket, IAM user, warehouse, instance and file system.
  2. S3: `aws s3 rm "s3://$S3_BUCKET" --recursive` then `aws s3 rb "s3://$S3_BUCKET"`. Revoke the IAM user: `aws iam list-access-keys --user-name aml-lab`, then `aws iam delete-access-key --user-name aml-lab --access-key-id <id>` for each key, then delete the user.
  3. Lake warehouse: Lake console, Warehouses, the demo warehouse, Suspend, then Delete if it was created for this demo.
  4. Filesystem: `ti fs delete-file-system --file-system-id "$TI_FS_FILE_SYSTEM_ID"`; then `ti fs list-file-systems` no longer shows it (deletion is asynchronous).
  5. Starter: `ticloud serverless branch list -c "$AML_CLUSTER_ID"` shows no branches; delete the instance in the console (or with the command 13-V5 confirms) if it was created for this demo.
  6. Confirm nothing is left billing: TiDB Cloud billing shows no Starter instance, no file system and no Lake warehouse running; `aws s3 ls "s3://$S3_BUCKET"` returns `NoSuchBucket`; Lake usage stops accruing after step 3.

## 6. File structure

```
demos/agent-aml/
  manifest.json                    12 nodes, 16 edges, 12 metrics, 11 phases, 5 checks, 5 controls (validated by DemoManifestSchema)
  package.json                     "@lab/demo-agent-aml"; scripts test, typecheck, smoke, teardown
  tsconfig.json                    extends ../../tsconfig.base.json
  README.md, TALK-TRACK.md         what it proves, run, record, cost, teardown; phase script, discovery questions, objections
  .env.example                     the standard TIDB_* block, LAB_ENV_COMPONENT_*, then AML_*, TI_FS_FILE_SYSTEM_ID, S3_*, AWS_* and LAKE_* variables
  fixtures/
    watchlist.json                 24 invented names (never real list entries) plus the list tag
    past-cases.json                12 synthetic past case summaries that seed episodic memory
    playbook.json                  the scripted investigation steps per pattern
    skills/structuring-triage.md, rapid-movement-review.md, watchlist-review.md    seed skill files for /harbor/skills
  runner/
    main.ts                        entry: config, fixtures, queues, controls, setup then the baseline tick loop
    smoke.ts                       live subcommands fs, branch, lake, recall used by the verify packets
    teardown.ts                    deletes branches, layers, /harbor and Lake objects
    src/
      domain.ts                    types, REPORTING_THRESHOLD_CENTS, alertKey
      time.ts, prng.ts, store.ts   UTC time helpers, seeded random source, a replace-only state box
      names.ts                     token cleaning, name similarity, FTS query text, shared-token test
      generator.ts                 seeded population, daily traffic, look-alike businesses, planted ring, rapid in-out and name variant
      rules.ts                     zod rule schemas, v1 and candidate v2 rules, evaluateRules, replayHistory
      scorer.ts                    simulated verdicts, per-rule precision, recall, false positives per 1,000, planted coverage
      whatIf.ts                    rule version comparator and the branch isolation evaluator
      recallSql.ts, sqlLiteral.ts  hybrid recall SQL (vector CTE + fts_match_word CTE fused by RRF 60), safe literals
      schema.ts, starterSql.ts, rowMappers.ts    Starter DDL, statement builders, zod row mappers
      workingSet.ts, format.ts     case working set, linking, case selection, notes and draft report renderers
      skills.ts                    skill lint and the distiller (idempotent, versioned)
      lesson.ts, journal.ts        lesson composer, case path, layer, journal and branch names, journal entries
      lakeSql.ts                   Lake DDL, load task, lookback and evaluation SQL builders and parsers
      exportPlan.ts, exportParse.ts, sinkRows.ts, branchPlan.ts, branchEnv.ts, tickMath.ts, retry.ts, queue.ts, config.ts, fixtures.ts
      starter.ts                   pool-level Starter helpers: schema, reads, inserts, screening, recall (no kit import)
      live/context.ts              Context, World and CaseRecord types
      live/cli.ts, sinks.ts          runOrThrow (the kit's runCli never rejects) and a buffering row sink over the kit's S3 sink
      live/filesystem.ts, lake.ts, exports.ts    the modules that call the kit for CLI, Lake and S3 work
      live/setup.ts, traffic.ts, investigate.ts, learn.ts    phase flows
    test/*.test.ts                 pure-module tests (no network)
  test/manifest.test.ts, emitted-ids.test.ts    manifest parses; every emitted id exists and every manifest id is emitted
  traces/featured.json             the recording the website plays (committed after section 8)
```

The kit is imported only by `runner/src/live/*`, `runner/main.ts`, `runner/smoke.ts` and `runner/teardown.ts`. No `infra/` folder is created: there is nothing to run locally.

`package.json` lists `mysql2` as a devDependency only so TypeScript can resolve the `Pool` type; runner code reaches TiDB through `createTidbPool` and `tidbConfigFromEnv`, never `mysql2` directly.

## 7. Tasks

Conventions for every pure task: write the failing test first, run it and see the quoted failure, write the minimal module, run again and see the quoted pass count, then commit. Commands run from `integrations/` unless a task says `cd demos/agent-aml`. The tests import only pure modules, so none of them needs credentials or a network.

### Task 1: Scaffold the demo package

- [ ] Not started

`demos/agent-aml/package.json`:

```json
{
  "name": "@lab/demo-agent-aml",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "smoke": "node --env-file=.env --import tsx runner/smoke.ts",
    "teardown": "node --env-file=.env --import tsx runner/teardown.ts"
  },
  "dependencies": {
    "@lab/agent-stack-kit": "workspace:*",
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "mysql2": "^3.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`demos/agent-aml/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "resolveJsonModule": true
  },
  "include": ["runner/**/*.ts", "test/**/*.ts"]
}
```

Run:

```bash
mkdir -p demos/agent-aml/runner/src/live demos/agent-aml/runner/test demos/agent-aml/test demos/agent-aml/fixtures/skills demos/agent-aml/traces
pnpm install
```

Expected: `pnpm install` completes and links `@lab/contract`, `@lab/runner-kit` and `@lab/agent-stack-kit` from the workspace. It fails with a missing workspace package until Plan 12 has created `packages/agent-stack-kit`; run this task after Plan 12's kit packets.

Commit:

```bash
git add demos/agent-aml/package.json demos/agent-aml/tsconfig.json
git commit -m "agent-aml demo: scaffold package"
```

### Task 2: Domain types, seeded random source, time helpers and a state box

- [ ] Not started

`demos/agent-aml/runner/test/foundations.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { alertKey } from '../src/domain';
import { createRng, deriveSeed } from '../src/prng';
import { createStore } from '../src/store';
import {
  DAY_MS,
  formatDateTime,
  formatDateTimeMs,
  parseDateTime,
  startOfDay,
  weekBucket,
} from '../src/time';

describe('createRng', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it('differs for different seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('keeps int inside its inclusive range and pick inside its list', () => {
    const rng = createRng(9);
    Array.from({ length: 200 }, () => rng.int(3, 5)).forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
    });
    expect(['a', 'b']).toContain(rng.pick(['a', 'b']));
  });

  it('refuses to pick from an empty list', () => {
    expect(() => createRng(1).pick([])).toThrow('pick from empty list');
  });
});

describe('deriveSeed', () => {
  it('is stable per label and different across labels', () => {
    expect(deriveSeed(7, 'history')).toBe(deriveSeed(7, 'history'));
    expect(deriveSeed(7, 'history')).not.toBe(deriveSeed(7, 'population'));
  });
});

describe('time helpers', () => {
  it('formats and parses UTC timestamps round trip, with or without fractions', () => {
    const ms = Date.UTC(2026, 3, 1, 12, 30, 15, 123);
    expect(formatDateTime(ms)).toBe('2026-04-01 12:30:15');
    expect(formatDateTimeMs(ms)).toBe('2026-04-01 12:30:15.123');
    expect(parseDateTime('2026-04-01 12:30:15.123')).toBe(ms);
    expect(parseDateTime('2026-04-01T12:30:15.123Z')).toBe(ms);
  });

  it('rejects text that is not a timestamp', () => {
    expect(() => parseDateTime('yesterday')).toThrow('unparseable timestamp');
  });

  it('buckets by week and day', () => {
    expect(weekBucket(7 * DAY_MS)).toBe(1);
    expect(weekBucket(7 * DAY_MS - 1)).toBe(0);
    expect(startOfDay(DAY_MS + 5)).toBe(DAY_MS);
  });
});

describe('alertKey', () => {
  it('identifies an alert by rule, version, account and bucket', () => {
    expect(alertKey({ ruleId: 'structuring', ruleVersion: 'v1', accountId: 'ACC-0001', bucket: 4 })).toBe(
      'structuring|v1|ACC-0001|4',
    );
  });
});

describe('createStore', () => {
  it('replaces its value wholesale and returns the new one', () => {
    const store = createStore({ count: 1 });
    const next = store.update((current) => ({ count: current.count + 1 }));
    expect(next).toEqual({ count: 2 });
    expect(store.get()).toEqual({ count: 2 });
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/foundations.test.ts
```

Expected FAIL: `Cannot find module '../src/domain'`.

`demos/agent-aml/runner/src/domain.ts` (the reporting threshold is a named constant for illustration only; it is overridable through `AML_REPORTING_THRESHOLD_CENTS`):

```typescript
export const REPORTING_THRESHOLD_CENTS = 1_000_000;

export type PatternKind = 'structuring' | 'rapid-in-out' | 'watchlist-near-match';

export const patternKinds: readonly PatternKind[] = ['structuring', 'rapid-in-out', 'watchlist-near-match'];

export type TxnType = 'cash_deposit' | 'wire_in' | 'wire_out' | 'card_purchase';

export type AccountKind = 'retail' | 'business';

export type Account = {
  readonly accountId: string;
  readonly holderName: string;
  readonly kind: AccountKind;
  readonly homeBranch: string;
};

export type Transaction = {
  readonly txnId: number;
  readonly accountId: string;
  readonly counterpartyId: string;
  readonly txnType: TxnType;
  readonly amountCents: number;
  readonly txnTsMs: number;
  readonly branchCode: string;
  readonly memo: string;
};

export type GroundTruthEntry = {
  readonly accountId: string;
  readonly pattern: PatternKind;
  readonly injectedAtMs: number;
};

export type WatchlistEntry = {
  readonly entryId: number;
  readonly fullName: string;
  readonly listTag: string;
};

export type Alert = {
  readonly ruleId: PatternKind;
  readonly ruleVersion: string;
  readonly accountId: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly raisedAtMs: number;
  readonly bucket: number;
  readonly txnIds: readonly number[];
  readonly score: number;
};

export const alertKey = (alert: Pick<Alert, 'ruleId' | 'ruleVersion' | 'accountId' | 'bucket'>): string =>
  `${alert.ruleId}|${alert.ruleVersion}|${alert.accountId}|${alert.bucket}`;
```

`demos/agent-aml/runner/src/time.ts`:

```typescript
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const formatDateTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export const formatDateTimeMs = (ms: number): string => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');

export const parseDateTime = (text: string): number => {
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  if (Number.isNaN(parsed)) throw new Error(`unparseable timestamp: ${text}`);
  return parsed;
};

export const weekBucket = (ms: number): number => Math.floor(ms / (7 * DAY_MS));

export const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
```

`demos/agent-aml/runner/src/prng.ts`:

```typescript
export type Rng = {
  readonly next: () => number;
  readonly int: (minInclusive: number, maxInclusive: number) => number;
  readonly pick: <T>(items: readonly T[]) => T;
  readonly chance: (probability: number) => boolean;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const createRng = (seed: number): Rng => {
  const next = mulberry32(seed);
  const int = (minInclusive: number, maxInclusive: number): number =>
    minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  };
  const chance = (probability: number): boolean => next() < probability;
  return { next, int, pick, chance };
};

export const deriveSeed = (seed: number, label: string): number =>
  [...label].reduce((acc, char) => (Math.imul(acc, 31) + char.charCodeAt(0)) >>> 0, seed >>> 0);
```

`demos/agent-aml/runner/src/store.ts`:

```typescript
export type Store<T> = {
  readonly get: () => T;
  readonly update: (change: (current: T) => T) => T;
};

export const createStore = <T>(initial: T): Store<T> => {
  let value = initial;
  return {
    get: () => value,
    update: (change) => {
      value = change(value);
      return value;
    },
  };
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/foundations.test.ts
```

Expected PASS: 10 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/domain.ts demos/agent-aml/runner/src/time.ts demos/agent-aml/runner/src/prng.ts demos/agent-aml/runner/src/store.ts demos/agent-aml/runner/test/foundations.test.ts
git commit -m "agent-aml demo: domain types, seeded rng, time helpers, state box"
```

### Task 3: Name cleaning and fuzzy similarity

- [ ] Not started

The watchlist rule filters candidates with `fts_match_word` in SQL and then scores them here, so the match is explainable token by token.

`demos/agent-aml/runner/test/names.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ftsQueryFromName, nameSimilarity, sharesToken, tokenizeName } from '../src/names';

describe('tokenizeName', () => {
  it('lowercases, strips accents and punctuation, and drops initials', () => {
    expect(tokenizeName("Orsolya Q. Fenwick-Dray")).toEqual(['orsolya', 'fenwick', 'dray']);
    expect(tokenizeName('Zoé Marlow')).toEqual(['zoe', 'marlow']);
  });
});

describe('nameSimilarity', () => {
  it('is 1 for the same tokens in a different order', () => {
    expect(nameSimilarity('Quenby Marlow Tarn', 'Marlow Quenby Tarn')).toBe(1);
  });

  it('is high for a one-letter variation', () => {
    expect(nameSimilarity('Marlaw Quenby Tarn', 'Marlow Quenby Tarn')).toBeGreaterThan(0.9);
  });

  it('is low when only one token is shared', () => {
    expect(nameSimilarity('Marlow Davies', 'Marlow Quenby Tarn')).toBeLessThan(0.7);
  });

  it('is 0 when either name has no usable tokens', () => {
    expect(nameSimilarity('', 'Marlow Quenby')).toBe(0);
  });
});

describe('ftsQueryFromName', () => {
  it('joins the cleaned tokens with spaces for fts_match_word', () => {
    expect(ftsQueryFromName("Brisa O'Hallworth")).toBe('brisa hallworth');
  });
});

describe('sharesToken', () => {
  it('is true when any cleaned token is shared and false otherwise', () => {
    expect(sharesToken('Marlow Quenby', 'Queaby Marlow')).toBe(true);
    expect(sharesToken('Marlow Quenby', 'Veskar Tolmund')).toBe(false);
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/names.test.ts
```

Expected FAIL: `Cannot find module '../src/names'`.

`demos/agent-aml/runner/src/names.ts`:

```typescript
export const tokenizeName = (name: string): readonly string[] =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 1);

const levenshtein = (a: string, b: string): number => {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const final = [...a].reduce<readonly number[]>(
    (row, charA, i) =>
      [...b].reduce<readonly number[]>(
        (next, charB, j) => {
          const left = next[j] ?? 0;
          const diagonal = row[j] ?? 0;
          const above = row[j + 1] ?? 0;
          return [...next, Math.min(left + 1, above + 1, diagonal + (charA === charB ? 0 : 1))];
        },
        [i + 1],
      ),
    previous,
  );
  return final[b.length] ?? 0;
};

const tokenSimilarity = (a: string, b: string): number => {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
};

const bestMatch = (token: string, candidates: readonly string[]): number =>
  candidates.reduce((best, candidate) => Math.max(best, tokenSimilarity(token, candidate)), 0);

export const nameSimilarity = (a: string, b: string): number => {
  const tokensA = tokenizeName(a);
  const tokensB = tokenizeName(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const total = shorter.reduce((sum, token) => sum + bestMatch(token, longer), 0);
  return total / shorter.length;
};

export const ftsQueryFromName = (name: string): string => tokenizeName(name).join(' ');

export const sharesToken = (a: string, b: string): boolean => {
  const tokensB = new Set(tokenizeName(b));
  return tokenizeName(a).some((token) => tokensB.has(token));
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/names.test.ts
```

Expected PASS: 7 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/names.ts demos/agent-aml/runner/test/names.test.ts
git commit -m "agent-aml demo: name tokenizing and similarity"
```

### Task 4: Seeded transaction generator with planted patterns

- [ ] Not started

Customers and names come from fixed pools; the planted ring, the rapid in-out chain and the watchlist name variant are the ground truth. Four cash-intensive look-alike businesses deposit just under the threshold at their home branch only, so a naive structuring rule raises false positives that a branch-spread rule removes.

`demos/agent-aml/runner/test/generator.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { REPORTING_THRESHOLD_CENTS } from '../src/domain';
import {
  buildPopulation,
  generateDay,
  generateHistory,
  nameVariant,
  plantRapidInOut,
  plantStructuringRing,
  plantWatchlistNearMatch,
} from '../src/generator';
import { nameSimilarity } from '../src/names';
import { createRng } from '../src/prng';
import { DAY_MS } from '../src/time';

const day0 = Date.UTC(2026, 0, 5);
const populationOptions = { retailCount: 40, businessCount: 10, lookAlikeCount: 4, branchCount: 6 };

const aPopulation = (seed: number) => buildPopulation({ rng: createRng(seed), ...populationOptions });

describe('buildPopulation', () => {
  it('is deterministic for a seed', () => {
    expect(aPopulation(7)).toEqual(aPopulation(7));
  });

  it('marks the first business accounts as look-alikes', () => {
    const population = aPopulation(7);
    expect(population.accounts).toHaveLength(50);
    expect(population.lookAlikeIds).toHaveLength(4);
    population.lookAlikeIds.forEach((id) =>
      expect(population.accounts.find((account) => account.accountId === id)?.kind).toBe('business'),
    );
  });
});

describe('generateHistory', () => {
  const population = aPopulation(7);
  const history = generateHistory({
    rng: createRng(11),
    population,
    days: 30,
    firstDayStartMs: day0,
    firstTxnId: 1,
    thresholdCents: REPORTING_THRESHOLD_CENTS,
  });

  it('numbers transactions sequentially from firstTxnId', () => {
    expect(history.transactions[0]?.txnId).toBe(1);
    expect(history.nextTxnId).toBe(history.transactions.length + 1);
  });

  it('keeps ordinary cash deposits well under the near-threshold band', () => {
    const lookAlike = new Set(population.lookAlikeIds);
    const ordinaryCash = history.transactions.filter(
      (txn) => txn.txnType === 'cash_deposit' && !lookAlike.has(txn.accountId),
    );
    ordinaryCash.forEach((txn) => expect(txn.amountCents).toBeLessThan(REPORTING_THRESHOLD_CENTS * 0.5));
  });

  it('makes look-alike accounts deposit just under the threshold at their home branch only', () => {
    const lookAlikeId = population.lookAlikeIds[0] ?? '';
    const home = population.accounts.find((account) => account.accountId === lookAlikeId)?.homeBranch;
    const deposits = history.transactions.filter(
      (txn) => txn.accountId === lookAlikeId && txn.memo === 'till sweep',
    );
    expect(deposits.length).toBeGreaterThan(5);
    deposits.forEach((txn) => {
      expect(txn.amountCents).toBeGreaterThanOrEqual(REPORTING_THRESHOLD_CENTS * 0.91);
      expect(txn.amountCents).toBeLessThan(REPORTING_THRESHOLD_CENTS);
      expect(txn.branchCode).toBe(home);
    });
  });

  it('generates the same history for the same seeds', () => {
    const again = generateHistory({
      rng: createRng(11),
      population: aPopulation(7),
      days: 30,
      firstDayStartMs: day0,
      firstTxnId: 1,
      thresholdCents: REPORTING_THRESHOLD_CENTS,
    });
    expect(again).toEqual(history);
  });
});

describe('generateDay', () => {
  it('stamps every transaction inside the requested day', () => {
    const day = generateDay({
      rng: createRng(3),
      dayStartMs: day0,
      dayIndex: 0,
      population: aPopulation(7),
      firstTxnId: 100,
      thresholdCents: REPORTING_THRESHOLD_CENTS,
    });
    day.transactions.forEach((txn) => {
      expect(txn.txnTsMs).toBeGreaterThanOrEqual(day0);
      expect(txn.txnTsMs).toBeLessThan(day0 + DAY_MS);
    });
  });
});

describe('plantStructuringRing', () => {
  const ring = plantStructuringRing({
    rng: createRng(5),
    lastDayStartMs: day0 + 40 * DAY_MS,
    firstTxnId: 5000,
    firstAccountNumber: 1,
    ringSize: 3,
    thresholdCents: REPORTING_THRESHOLD_CENTS,
    branchCount: 6,
  });

  it('creates ring accounts with ground truth for each', () => {
    expect(ring.accounts).toHaveLength(3);
    expect(ring.truth.map((entry) => entry.pattern)).toEqual(['structuring', 'structuring', 'structuring']);
  });

  it('keeps every deposit under the threshold and inside the band', () => {
    const deposits = ring.transactions.filter((txn) => txn.txnType === 'cash_deposit');
    expect(deposits).toHaveLength(18);
    deposits.forEach((txn) => {
      expect(txn.amountCents).toBeLessThan(REPORTING_THRESHOLD_CENTS);
      expect(txn.amountCents).toBeGreaterThanOrEqual(REPORTING_THRESHOLD_CENTS * 0.9);
    });
  });

  it('spreads each account across at least two branches', () => {
    ring.accounts.forEach((account) => {
      const branches = new Set(
        ring.transactions
          .filter((txn) => txn.accountId === account.accountId && txn.txnType === 'cash_deposit')
          .map((txn) => txn.branchCode),
      );
      expect(branches.size).toBeGreaterThanOrEqual(2);
    });
  });

  it('sweeps most of the deposits to one shared counterparty', () => {
    const sweeps = ring.transactions.filter((txn) => txn.txnType === 'wire_out');
    expect(new Set(sweeps.map((txn) => txn.counterpartyId))).toEqual(new Set(['CP-MULE-01']));
  });
});

describe('plantRapidInOut', () => {
  it('creates three in and out wire pairs that retain about three percent', () => {
    const planted = plantRapidInOut({
      rng: createRng(9),
      dayStartMs: day0 + 30 * DAY_MS,
      firstTxnId: 9000,
      accountNumber: 1,
      branchCount: 6,
    });
    const incoming = planted.transactions.filter((txn) => txn.txnType === 'wire_in');
    const outgoing = planted.transactions.filter((txn) => txn.txnType === 'wire_out');
    expect(incoming).toHaveLength(3);
    expect(outgoing).toHaveLength(3);
    incoming.forEach((txn, index) => {
      const out = outgoing[index];
      expect(out?.amountCents).toBe(Math.round(txn.amountCents * 0.97));
    });
    expect(planted.truth[0]?.pattern).toBe('rapid-in-out');
  });
});

describe('plantWatchlistNearMatch', () => {
  it('builds a list entry that is similar to an existing retail holder but not identical', () => {
    const population = aPopulation(7);
    const planted = plantWatchlistNearMatch({
      rng: createRng(13),
      accounts: population.accounts,
      firstEntryId: 100,
      injectedAtMs: day0,
      listTag: 'SYNTH-LIVE',
    });
    const holder = population.accounts.find((account) => account.accountId === planted.truth.accountId);
    expect(holder?.kind).toBe('retail');
    const similarity = nameSimilarity(holder?.holderName ?? '', planted.entry.fullName);
    expect(similarity).toBeGreaterThan(0.85);
    expect(similarity).toBeLessThan(1);
    expect(planted.truth.pattern).toBe('watchlist-near-match');
  });
});

describe('nameVariant', () => {
  it('swaps the order and alters one letter of the family name', () => {
    expect(nameVariant('Marlow Quenby')).toBe('Queaby Marlow');
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/generator.test.ts
```

Expected FAIL: `Cannot find module '../src/generator'`.

`demos/agent-aml/runner/src/generator.ts`:

```typescript
import type { Account, GroundTruthEntry, Transaction, TxnType, WatchlistEntry } from './domain';
import type { Rng } from './prng';
import { DAY_MS, HOUR_MS } from './time';

export const firstNames: readonly string[] = [
  'Alder', 'Briar', 'Calder', 'Dorian', 'Elspeth', 'Fenner', 'Garrick', 'Hollis', 'Isolde', 'Jarvis',
  'Kestrel', 'Lowen', 'Marlow', 'Nerys', 'Orrin', 'Pelham', 'Quillon', 'Rowan', 'Sabine', 'Tamsin',
];

export const lastNames: readonly string[] = [
  'Ashdown', 'Birchall', 'Copeland', 'Dunmore', 'Eastwick', 'Fairlie', 'Gladwin', 'Harcourt', 'Ingleby', 'Jessop',
  'Kingsley', 'Lovelace', 'Merrow', 'Netherby', 'Oakhurst', 'Penhallow', 'Quenby', 'Redfern', 'Stanhope', 'Thornley',
];

export type Population = {
  readonly accounts: readonly Account[];
  readonly lookAlikeIds: readonly string[];
};

export type Generated = {
  readonly transactions: readonly Transaction[];
  readonly nextTxnId: number;
};

export type Planted = Generated & {
  readonly accounts: readonly Account[];
  readonly truth: readonly GroundTruthEntry[];
};

export type PlantedWatchlist = {
  readonly entry: WatchlistEntry;
  readonly truth: GroundTruthEntry;
};

const branchCode = (index: number): string => `B${String(index).padStart(2, '0')}`;

const accountId = (prefix: string, index: number): string => `${prefix}-${String(index).padStart(4, '0')}`;

const holderName = (rng: Rng): string => `${rng.pick(firstNames)} ${rng.pick(lastNames)}`;

export const buildPopulation = (options: {
  readonly rng: Rng;
  readonly retailCount: number;
  readonly businessCount: number;
  readonly lookAlikeCount: number;
  readonly branchCount: number;
}): Population => {
  const { rng, retailCount, businessCount, lookAlikeCount, branchCount } = options;
  const make = (index: number, kind: Account['kind']): Account => ({
    accountId: accountId('ACC', index + 1),
    holderName: kind === 'business' ? `${holderName(rng)} Trading` : holderName(rng),
    kind,
    homeBranch: branchCode(rng.int(1, branchCount)),
  });
  const retail = Array.from({ length: retailCount }, (_, index) => make(index, 'retail'));
  const business = Array.from({ length: businessCount }, (_, index) => make(retailCount + index, 'business'));
  return {
    accounts: [...retail, ...business],
    lookAlikeIds: business.slice(0, lookAlikeCount).map((account) => account.accountId),
  };
};

const memosByType: Readonly<Record<TxnType, readonly string[]>> = {
  cash_deposit: ['cash gift', 'savings top-up', 'cash deposit'],
  wire_in: ['invoice payment', 'transfer in', 'refund received'],
  wire_out: ['supplier payment', 'rent', 'transfer out'],
  card_purchase: ['groceries', 'fuel', 'dining', 'online shop'],
};

const weightedType = (rng: Rng, kind: Account['kind']): TxnType => {
  const roll = rng.next();
  const [card, cash, wireIn] = kind === 'retail' ? [0.7, 0.8, 0.9] : [0.3, 0.5, 0.75];
  if (roll < card) return 'card_purchase';
  if (roll < cash) return 'cash_deposit';
  if (roll < wireIn) return 'wire_in';
  return 'wire_out';
};

const amountFor = (rng: Rng, txnType: TxnType): number => {
  if (txnType === 'card_purchase') return rng.int(500, 25_000);
  if (txnType === 'cash_deposit') return rng.int(2_000, 200_000);
  return rng.int(5_000, 300_000);
};

const ordinaryTransaction = (options: {
  readonly rng: Rng;
  readonly account: Account;
  readonly dayStartMs: number;
}): Omit<Transaction, 'txnId'> => {
  const { rng, account, dayStartMs } = options;
  const txnType = weightedType(rng, account.kind);
  return {
    accountId: account.accountId,
    counterpartyId: `CP-${String(rng.int(1, 60)).padStart(3, '0')}`,
    txnType,
    amountCents: amountFor(rng, txnType),
    txnTsMs: dayStartMs + rng.int(8 * HOUR_MS, 20 * HOUR_MS - 1),
    branchCode: account.homeBranch,
    memo: rng.pick(memosByType[txnType]),
  };
};

const lookAlikeDeposit = (options: {
  readonly rng: Rng;
  readonly account: Account;
  readonly dayStartMs: number;
  readonly thresholdCents: number;
}): Omit<Transaction, 'txnId'> => ({
  accountId: options.account.accountId,
  counterpartyId: 'CP-TILL',
  txnType: 'cash_deposit',
  amountCents: Math.round(options.thresholdCents * (0.91 + options.rng.next() * 0.075)),
  txnTsMs: options.dayStartMs + options.rng.int(9 * HOUR_MS, 17 * HOUR_MS),
  branchCode: options.account.homeBranch,
  memo: 'till sweep',
});

const numbered = (drafts: readonly Omit<Transaction, 'txnId'>[], firstTxnId: number): Generated => {
  const ordered = [...drafts].sort((a, b) => a.txnTsMs - b.txnTsMs);
  return {
    transactions: ordered.map((draft, index) => ({ ...draft, txnId: firstTxnId + index })),
    nextTxnId: firstTxnId + ordered.length,
  };
};

export const generateDay = (options: {
  readonly rng: Rng;
  readonly dayStartMs: number;
  readonly dayIndex: number;
  readonly population: Population;
  readonly firstTxnId: number;
  readonly thresholdCents: number;
}): Generated => {
  const { rng, dayStartMs, dayIndex, population, firstTxnId, thresholdCents } = options;
  const lookAlike = new Set(population.lookAlikeIds);
  const drafts = population.accounts.flatMap((account, index) => {
    const ordinaryRate = account.kind === 'retail' ? 0.35 : 0.6;
    const ordinary = rng.chance(ordinaryRate) ? [ordinaryTransaction({ rng, account, dayStartMs })] : [];
    const deposits =
      lookAlike.has(account.accountId) && (dayIndex + index) % 2 === 0
        ? [lookAlikeDeposit({ rng, account, dayStartMs, thresholdCents })]
        : [];
    return [...ordinary, ...deposits];
  });
  return numbered(drafts, firstTxnId);
};

export const generateHistory = (options: {
  readonly rng: Rng;
  readonly population: Population;
  readonly days: number;
  readonly firstDayStartMs: number;
  readonly firstTxnId: number;
  readonly thresholdCents: number;
}): Generated => {
  const { rng, population, days, firstDayStartMs, firstTxnId, thresholdCents } = options;
  return Array.from({ length: days }, (_, dayIndex) => dayIndex).reduce<Generated>(
    (acc, dayIndex) => {
      const day = generateDay({
        rng,
        dayStartMs: firstDayStartMs + dayIndex * DAY_MS,
        dayIndex,
        population,
        firstTxnId: acc.nextTxnId,
        thresholdCents,
      });
      return { transactions: [...acc.transactions, ...day.transactions], nextTxnId: day.nextTxnId };
    },
    { transactions: [], nextTxnId: firstTxnId },
  );
};

export const plantStructuringRing = (options: {
  readonly rng: Rng;
  readonly lastDayStartMs: number;
  readonly firstTxnId: number;
  readonly firstAccountNumber: number;
  readonly ringSize: number;
  readonly thresholdCents: number;
  readonly branchCount: number;
}): Planted => {
  const { rng, lastDayStartMs, firstTxnId, firstAccountNumber, ringSize, thresholdCents, branchCount } = options;
  const accounts: readonly Account[] = Array.from({ length: ringSize }, (_, index) => ({
    accountId: accountId('RNG', firstAccountNumber + index),
    holderName: holderName(rng),
    kind: 'retail',
    homeBranch: branchCode(rng.int(1, branchCount)),
  }));
  const dayOffsets: readonly number[] = [4, 3, 2, 1, 0, 0];
  const drafts = accounts.flatMap((account, accountIndex) => {
    const deposits = dayOffsets.map((offset, depositIndex): Omit<Transaction, 'txnId'> => ({
      accountId: account.accountId,
      counterpartyId: 'CP-TILL',
      txnType: 'cash_deposit',
      amountCents: Math.round(thresholdCents * (0.905 + rng.next() * 0.09)),
      txnTsMs: lastDayStartMs - offset * DAY_MS + rng.int(9 * HOUR_MS, 17 * HOUR_MS),
      branchCode: branchCode(((accountIndex + depositIndex) % Math.min(3, branchCount)) + 1),
      memo: 'cash deposit',
    }));
    const swept = deposits.reduce((sum, deposit) => sum + deposit.amountCents, 0);
    const sweep: Omit<Transaction, 'txnId'> = {
      accountId: account.accountId,
      counterpartyId: 'CP-MULE-01',
      txnType: 'wire_out',
      amountCents: Math.round(swept * 0.95),
      txnTsMs: lastDayStartMs + 18 * HOUR_MS,
      branchCode: account.homeBranch,
      memo: 'transfer out',
    };
    return [...deposits, sweep];
  });
  const numberedDrafts = numbered(drafts, firstTxnId);
  return {
    ...numberedDrafts,
    accounts,
    truth: accounts.map((account) => ({
      accountId: account.accountId,
      pattern: 'structuring',
      injectedAtMs: lastDayStartMs,
    })),
  };
};

export const plantRapidInOut = (options: {
  readonly rng: Rng;
  readonly dayStartMs: number;
  readonly firstTxnId: number;
  readonly accountNumber: number;
  readonly branchCount: number;
}): Planted => {
  const { rng, dayStartMs, firstTxnId, accountNumber, branchCount } = options;
  const account: Account = {
    accountId: accountId('PAS', accountNumber),
    holderName: `${holderName(rng)} Holdings`,
    kind: 'business',
    homeBranch: branchCode(rng.int(1, branchCount)),
  };
  const drafts = [0, 1, 2].flatMap((pair): readonly Omit<Transaction, 'txnId'>[] => {
    const incoming = rng.int(2_000_000, 8_000_000);
    const start = dayStartMs + (9 + pair * 4) * HOUR_MS;
    return [
      {
        accountId: account.accountId,
        counterpartyId: `CP-IN-${pair + 1}`,
        txnType: 'wire_in',
        amountCents: incoming,
        txnTsMs: start,
        branchCode: account.homeBranch,
        memo: 'invoice payment',
      },
      {
        accountId: account.accountId,
        counterpartyId: `CP-OUT-${pair + 1}`,
        txnType: 'wire_out',
        amountCents: Math.round(incoming * 0.97),
        txnTsMs: start + 2 * HOUR_MS,
        branchCode: account.homeBranch,
        memo: 'supplier payment',
      },
    ];
  });
  return {
    ...numbered(drafts, firstTxnId),
    accounts: [account],
    truth: [{ accountId: account.accountId, pattern: 'rapid-in-out', injectedAtMs: dayStartMs }],
  };
};

const mutateInterior = (token: string): string => {
  const index = Math.max(1, Math.floor(token.length / 2));
  const original = token[index] ?? 'a';
  const replacement = original === 'a' ? 'e' : 'a';
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
};

const capitalize = (token: string): string => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`;

export const nameVariant = (holder: string): string => {
  const [first, last] = holder.split(' ');
  if (first === undefined || last === undefined) throw new Error(`holder needs two names: ${holder}`);
  return `${capitalize(mutateInterior(last.toLowerCase()))} ${first}`;
};

export const plantWatchlistNearMatch = (options: {
  readonly rng: Rng;
  readonly accounts: readonly Account[];
  readonly firstEntryId: number;
  readonly injectedAtMs: number;
  readonly listTag: string;
}): PlantedWatchlist => {
  const { rng, accounts, firstEntryId, injectedAtMs, listTag } = options;
  const retail = accounts.filter((account) => account.kind === 'retail');
  const target = rng.pick(retail);
  return {
    entry: { entryId: firstEntryId, fullName: nameVariant(target.holderName), listTag },
    truth: { accountId: target.accountId, pattern: 'watchlist-near-match', injectedAtMs },
  };
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/generator.test.ts
```

Expected PASS: 14 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/generator.ts demos/agent-aml/runner/test/generator.test.ts
git commit -m "agent-aml demo: seeded generator with planted patterns"
```

### Task 5: Versioned rule engine

- [ ] Not started

Rules are zod-validated rows of the Starter `rules` table. v1 structuring needs three near-threshold cash deposits in five days; the candidate v2 also needs two distinct branches. `replayHistory` replays the engine day by day and keeps the first alert per rule version, account and week, which is how the live tick behaves.

`demos/agent-aml/runner/test/rules.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { Account, Transaction, WatchlistEntry } from '../src/domain';
import { baselineRules, candidateStructuring, evaluateRules, parseRuleRow, replayHistory } from '../src/rules';
import { DAY_MS, HOUR_MS } from '../src/time';

const THRESHOLD = 1_000_000;
const day0 = Date.UTC(2026, 2, 2);

const anAccount = (overrides: Partial<Account> = {}): Account => ({
  accountId: 'ACC-1',
  holderName: 'Marlow Quenby',
  kind: 'retail',
  homeBranch: 'B01',
  ...overrides,
});

const aTxn = (overrides: Partial<Transaction> = {}): Transaction => ({
  txnId: 1,
  accountId: 'ACC-1',
  counterpartyId: 'CP-001',
  txnType: 'cash_deposit',
  amountCents: 950_000,
  txnTsMs: day0 + 10 * HOUR_MS,
  branchCode: 'B01',
  memo: 'cash deposit',
  ...overrides,
});

const deposits = (branches: readonly string[]): readonly Transaction[] =>
  branches.map((branchCode, index) => aTxn({ txnId: index + 1, txnTsMs: day0 + index * DAY_MS + 10 * HOUR_MS, branchCode }));

const noWatchlist = new Map<string, readonly WatchlistEntry[]>();

const evaluate = (rules: ReturnType<typeof baselineRules>, transactions: readonly Transaction[], accounts = [anAccount()]) =>
  evaluateRules({ rules, accounts, transactions, asOfMs: day0 + 10 * DAY_MS, watchlistCandidates: noWatchlist });

describe('structuring rule', () => {
  it('flags three near-threshold deposits at one branch under v1', () => {
    const alerts = evaluate(baselineRules(THRESHOLD), deposits(['B01', 'B01', 'B01']));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ ruleId: 'structuring', ruleVersion: 'v1', accountId: 'ACC-1', score: 3 });
  });

  it('does not flag the same single-branch pattern under the v2 candidate', () => {
    const alerts = evaluate([candidateStructuring(THRESHOLD)], deposits(['B01', 'B01', 'B01']));
    expect(alerts).toHaveLength(0);
  });

  it('flags a multi-branch pattern under both versions', () => {
    const spread = deposits(['B01', 'B02', 'B03']);
    expect(evaluate(baselineRules(THRESHOLD), spread)).toHaveLength(1);
    expect(evaluate([candidateStructuring(THRESHOLD)], spread)).toHaveLength(1);
  });

  it('ignores deposits outside the band and at or above the threshold', () => {
    const outside = [
      aTxn({ txnId: 1, amountCents: 500_000 }),
      aTxn({ txnId: 2, amountCents: THRESHOLD, txnTsMs: day0 + DAY_MS }),
      aTxn({ txnId: 3, amountCents: 950_000, txnTsMs: day0 + 2 * DAY_MS }),
    ];
    expect(evaluate(baselineRules(THRESHOLD), outside)).toHaveLength(0);
  });

  it('requires the deposits to fall inside the window', () => {
    const slow = [0, 3, 6].map((offset, index) =>
      aTxn({ txnId: index + 1, txnTsMs: day0 + offset * DAY_MS + 10 * HOUR_MS }),
    );
    expect(evaluate(baselineRules(THRESHOLD), slow)).toHaveLength(0);
  });
});

describe('rapid in-out rule', () => {
  const pair = (index: number, incoming: number): readonly Transaction[] => [
    aTxn({ txnId: index * 2 + 1, txnType: 'wire_in', amountCents: incoming, txnTsMs: day0 + index * 4 * HOUR_MS }),
    aTxn({
      txnId: index * 2 + 2,
      txnType: 'wire_out',
      amountCents: Math.round(incoming * 0.97),
      txnTsMs: day0 + index * 4 * HOUR_MS + 2 * HOUR_MS,
    }),
  ];

  it('flags two or more near-full pass-through pairs inside the window', () => {
    const alerts = evaluate(baselineRules(THRESHOLD), [...pair(0, 3_000_000), ...pair(1, 4_000_000)]);
    expect(alerts.filter((alert) => alert.ruleId === 'rapid-in-out')).toHaveLength(1);
  });

  it('does not flag a single pair', () => {
    const alerts = evaluate(baselineRules(THRESHOLD), pair(0, 3_000_000));
    expect(alerts).toHaveLength(0);
  });

  it('does not flag when the outgoing wire keeps more than the retention limit', () => {
    const keeps = [
      aTxn({ txnId: 1, txnType: 'wire_in', amountCents: 3_000_000 }),
      aTxn({ txnId: 2, txnType: 'wire_out', amountCents: 1_000_000, txnTsMs: day0 + 11 * HOUR_MS }),
      aTxn({ txnId: 3, txnType: 'wire_in', amountCents: 3_000_000, txnTsMs: day0 + 12 * HOUR_MS }),
      aTxn({ txnId: 4, txnType: 'wire_out', amountCents: 1_000_000, txnTsMs: day0 + 13 * HOUR_MS }),
    ];
    expect(evaluate(baselineRules(THRESHOLD), keeps)).toHaveLength(0);
  });
});

describe('watchlist near-match rule', () => {
  const candidates = new Map<string, readonly WatchlistEntry[]>([
    ['ACC-1', [{ entryId: 1, fullName: 'Queaby Marlow', listTag: 'SYNTH' }]],
    ['ACC-2', [{ entryId: 2, fullName: 'Veskar Tolmund', listTag: 'SYNTH' }]],
  ]);
  const accounts = [anAccount(), anAccount({ accountId: 'ACC-2', holderName: 'Rowan Thornley' })];

  it('flags accounts whose name is close to a candidate and leaves weak matches alone', () => {
    const alerts = evaluateRules({
      rules: baselineRules(THRESHOLD),
      accounts,
      transactions: [],
      asOfMs: day0,
      watchlistCandidates: candidates,
    });
    expect(alerts.map((alert) => alert.accountId)).toEqual(['ACC-1']);
    expect(alerts[0]?.bucket).toBe(0);
  });
});

describe('replayHistory', () => {
  it('raises at most one alert per rule version, account and week', () => {
    const alwaysDepositing = Array.from({ length: 14 }, (_, index) =>
      aTxn({ txnId: index + 1, txnTsMs: day0 + index * DAY_MS + 10 * HOUR_MS }),
    );
    const alerts = replayHistory({
      rules: baselineRules(THRESHOLD),
      accounts: [anAccount()],
      transactions: alwaysDepositing,
      watchlistCandidates: noWatchlist,
      firstDayStartMs: day0,
      lastDayStartMs: day0 + 13 * DAY_MS,
      lookbackDays: 14,
    });
    const keys = alerts.map((alert) => `${alert.ruleVersion}|${alert.bucket}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
  });

  it('stamps raisedAtMs with the end of the day the pattern first qualified', () => {
    const alerts = replayHistory({
      rules: baselineRules(THRESHOLD),
      accounts: [anAccount()],
      transactions: deposits(['B01', 'B01', 'B01']),
      watchlistCandidates: noWatchlist,
      firstDayStartMs: day0,
      lastDayStartMs: day0 + 5 * DAY_MS,
      lookbackDays: 14,
    });
    expect(alerts[0]?.raisedAtMs).toBe(day0 + 2 * DAY_MS + DAY_MS - 1);
  });
});

describe('parseRuleRow', () => {
  it('parses a JSON string params column into a typed rule', () => {
    const rule = parseRuleRow({
      rule_id: 'structuring',
      version: 'v2',
      params: JSON.stringify({ thresholdCents: THRESHOLD, bandPct: 10, windowDays: 5, minDeposits: 3, minDistinctBranches: 2 }),
    });
    expect(rule).toMatchObject({ ruleId: 'structuring', version: 'v2' });
  });

  it('rejects params that do not match the rule type', () => {
    expect(() => parseRuleRow({ rule_id: 'rapid-in-out', version: 'v1', params: { windowHours: -1 } })).toThrow();
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/rules.test.ts
```

Expected FAIL: `Cannot find module '../src/rules'`.

`demos/agent-aml/runner/src/rules.ts`:

```typescript
import { z } from 'zod';
import { alertKey, type Account, type Alert, type Transaction, type WatchlistEntry } from './domain';
import { nameSimilarity } from './names';
import { DAY_MS, HOUR_MS, weekBucket } from './time';

export const StructuringParamsSchema = z.object({
  thresholdCents: z.number().int().positive(),
  bandPct: z.number().positive().max(50),
  windowDays: z.number().int().positive(),
  minDeposits: z.number().int().min(2),
  minDistinctBranches: z.number().int().min(1),
});

export const RapidInOutParamsSchema = z.object({
  windowHours: z.number().int().positive(),
  retainMaxPct: z.number().min(0).max(50),
  minPairs: z.number().int().min(1),
  minAmountCents: z.number().int().positive(),
});

export const WatchlistParamsSchema = z.object({ minSimilarity: z.number().min(0).max(1) });

export const RuleDefinitionSchema = z.discriminatedUnion('ruleId', [
  z.object({ ruleId: z.literal('structuring'), version: z.string().min(1), params: StructuringParamsSchema }),
  z.object({ ruleId: z.literal('rapid-in-out'), version: z.string().min(1), params: RapidInOutParamsSchema }),
  z.object({ ruleId: z.literal('watchlist-near-match'), version: z.string().min(1), params: WatchlistParamsSchema }),
]);

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
export type StructuringParams = z.infer<typeof StructuringParamsSchema>;

const parseParams = (params: unknown): unknown => {
  if (typeof params !== 'string') return params;
  try {
    return JSON.parse(params);
  } catch {
    return undefined;
  }
};

export const parseRuleRow = (row: Readonly<Record<string, unknown>>): RuleDefinition =>
  RuleDefinitionSchema.parse({ ruleId: row.rule_id, version: row.version, params: parseParams(row.params) });

export const baselineRules = (thresholdCents: number): readonly RuleDefinition[] => [
  {
    ruleId: 'structuring',
    version: 'v1',
    params: { thresholdCents, bandPct: 10, windowDays: 5, minDeposits: 3, minDistinctBranches: 1 },
  },
  {
    ruleId: 'rapid-in-out',
    version: 'v1',
    params: { windowHours: 24, retainMaxPct: 10, minPairs: 2, minAmountCents: 1_000_000 },
  },
  { ruleId: 'watchlist-near-match', version: 'v1', params: { minSimilarity: 0.85 } },
];

export const candidateStructuring = (thresholdCents: number): RuleDefinition => ({
  ruleId: 'structuring',
  version: 'v2',
  params: { thresholdCents, bandPct: 10, windowDays: 5, minDeposits: 3, minDistinctBranches: 2 },
});

export type EvaluationInput = {
  readonly rules: readonly RuleDefinition[];
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly asOfMs: number;
  readonly watchlistCandidates: ReadonlyMap<string, readonly WatchlistEntry[]>;
};

const byAccount = (transactions: readonly Transaction[]): ReadonlyMap<string, readonly Transaction[]> =>
  transactions.reduce((map, txn) => {
    const existing = map.get(txn.accountId) ?? [];
    return new Map([...map, [txn.accountId, [...existing, txn]]]);
  }, new Map<string, readonly Transaction[]>());

const byTime = (a: Transaction, b: Transaction): number => a.txnTsMs - b.txnTsMs;

const distinctBranches = (window: readonly Transaction[]): number =>
  new Set(window.map((txn) => txn.branchCode)).size;

const evaluateStructuring = (
  rule: Extract<RuleDefinition, { ruleId: 'structuring' }>,
  grouped: ReadonlyMap<string, readonly Transaction[]>,
  asOfMs: number,
): readonly Alert[] => {
  const { thresholdCents, bandPct, windowDays, minDeposits, minDistinctBranches } = rule.params;
  const lower = Math.floor((thresholdCents * (100 - bandPct)) / 100);
  const windowMs = windowDays * DAY_MS;
  return [...grouped.entries()].flatMap(([accountId, txns]) => {
    const deposits = txns
      .filter((txn) => txn.txnType === 'cash_deposit' && txn.amountCents >= lower && txn.amountCents < thresholdCents)
      .sort(byTime);
    const windows = deposits.map((end, endIndex) =>
      deposits.filter((txn, index) => index <= endIndex && end.txnTsMs - txn.txnTsMs <= windowMs),
    );
    const latest = windows
      .filter((window) => window.length >= minDeposits && distinctBranches(window) >= minDistinctBranches)
      .at(-1);
    const first = latest?.[0];
    const last = latest?.at(-1);
    if (latest === undefined || first === undefined || last === undefined) return [];
    return [
      {
        ruleId: 'structuring',
        ruleVersion: rule.version,
        accountId,
        windowStartMs: first.txnTsMs,
        windowEndMs: last.txnTsMs,
        raisedAtMs: asOfMs,
        bucket: weekBucket(last.txnTsMs),
        txnIds: latest.map((txn) => txn.txnId),
        score: latest.length,
      },
    ];
  });
};

type Pairing = {
  readonly used: ReadonlySet<number>;
  readonly pairs: readonly (readonly [Transaction, Transaction])[];
};

const pairWires = (
  incoming: readonly Transaction[],
  outgoing: readonly Transaction[],
  params: Extract<RuleDefinition, { ruleId: 'rapid-in-out' }>['params'],
): Pairing =>
  incoming.reduce<Pairing>(
    (state, wireIn) => {
      const floor = (wireIn.amountCents * (100 - params.retainMaxPct)) / 100;
      const match = outgoing.find(
        (wireOut) =>
          !state.used.has(wireOut.txnId) &&
          wireOut.txnTsMs >= wireIn.txnTsMs &&
          wireOut.txnTsMs - wireIn.txnTsMs <= params.windowHours * HOUR_MS &&
          wireOut.amountCents >= floor &&
          wireOut.amountCents <= wireIn.amountCents,
      );
      if (match === undefined) return state;
      return { used: new Set([...state.used, match.txnId]), pairs: [...state.pairs, [wireIn, match]] };
    },
    { used: new Set<number>(), pairs: [] },
  );

const evaluateRapidInOut = (
  rule: Extract<RuleDefinition, { ruleId: 'rapid-in-out' }>,
  grouped: ReadonlyMap<string, readonly Transaction[]>,
  asOfMs: number,
): readonly Alert[] =>
  [...grouped.entries()].flatMap(([accountId, txns]) => {
    const incoming = txns
      .filter((txn) => txn.txnType === 'wire_in' && txn.amountCents >= rule.params.minAmountCents)
      .sort(byTime);
    const outgoing = txns.filter((txn) => txn.txnType === 'wire_out').sort(byTime);
    const { pairs } = pairWires(incoming, outgoing, rule.params);
    const last = pairs.at(-1)?.[1];
    const first = pairs[0]?.[0];
    if (pairs.length < rule.params.minPairs || first === undefined || last === undefined) return [];
    return [
      {
        ruleId: 'rapid-in-out',
        ruleVersion: rule.version,
        accountId,
        windowStartMs: first.txnTsMs,
        windowEndMs: last.txnTsMs,
        raisedAtMs: asOfMs,
        bucket: weekBucket(last.txnTsMs),
        txnIds: pairs.flatMap(([wireIn, wireOut]) => [wireIn.txnId, wireOut.txnId]),
        score: pairs.length,
      },
    ];
  });

const evaluateWatchlist = (
  rule: Extract<RuleDefinition, { ruleId: 'watchlist-near-match' }>,
  accounts: readonly Account[],
  candidates: ReadonlyMap<string, readonly WatchlistEntry[]>,
  asOfMs: number,
): readonly Alert[] =>
  accounts.flatMap((account) => {
    const best = (candidates.get(account.accountId) ?? []).reduce(
      (top, entry) => Math.max(top, nameSimilarity(account.holderName, entry.fullName)),
      0,
    );
    if (best < rule.params.minSimilarity) return [];
    return [
      {
        ruleId: 'watchlist-near-match',
        ruleVersion: rule.version,
        accountId: account.accountId,
        windowStartMs: asOfMs,
        windowEndMs: asOfMs,
        raisedAtMs: asOfMs,
        bucket: 0,
        txnIds: [],
        score: Math.round(best * 100) / 100,
      },
    ];
  });

export const evaluateRules = (input: EvaluationInput): readonly Alert[] => {
  const visible = input.transactions.filter((txn) => txn.txnTsMs <= input.asOfMs);
  const grouped = byAccount(visible);
  return input.rules.flatMap((rule) => {
    if (rule.ruleId === 'structuring') return evaluateStructuring(rule, grouped, input.asOfMs);
    if (rule.ruleId === 'rapid-in-out') return evaluateRapidInOut(rule, grouped, input.asOfMs);
    return evaluateWatchlist(rule, input.accounts, input.watchlistCandidates, input.asOfMs);
  });
};

export const replayHistory = (options: {
  readonly rules: readonly RuleDefinition[];
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly watchlistCandidates: ReadonlyMap<string, readonly WatchlistEntry[]>;
  readonly firstDayStartMs: number;
  readonly lastDayStartMs: number;
  readonly lookbackDays: number;
}): readonly Alert[] => {
  const dayCount = Math.floor((options.lastDayStartMs - options.firstDayStartMs) / DAY_MS) + 1;
  const days = Array.from({ length: dayCount }, (_, index) => options.firstDayStartMs + index * DAY_MS);
  const seen = new Set<string>();
  return days.flatMap((dayStartMs) => {
    const asOfMs = dayStartMs + DAY_MS - 1;
    const windowStartMs = asOfMs - options.lookbackDays * DAY_MS;
    const fresh = evaluateRules({
      rules: options.rules,
      accounts: options.accounts,
      transactions: options.transactions.filter((txn) => txn.txnTsMs > windowStartMs),
      asOfMs,
      watchlistCandidates: options.watchlistCandidates,
    }).filter((alert) => !seen.has(alertKey(alert)));
    fresh.forEach((alert) => seen.add(alertKey(alert)));
    return fresh;
  });
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/rules.test.ts
```

Expected PASS: 13 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/rules.ts demos/agent-aml/runner/test/rules.test.ts
git commit -m "agent-aml demo: versioned rule engine"
```

### Task 6: Ground-truth scorer and simulated verdicts

- [ ] Not started

`demos/agent-aml/runner/test/scorer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { Alert, GroundTruthEntry } from '../src/domain';
import { plantedCoverage, scoreRules, simulateVerdict } from '../src/scorer';

const anAlert = (overrides: Partial<Alert> = {}): Alert => ({
  ruleId: 'structuring',
  ruleVersion: 'v1',
  accountId: 'ACC-1',
  windowStartMs: 0,
  windowEndMs: 0,
  raisedAtMs: 0,
  bucket: 0,
  txnIds: [],
  score: 3,
  ...overrides,
});

const truth: readonly GroundTruthEntry[] = [
  { accountId: 'RNG-1', pattern: 'structuring', injectedAtMs: 0 },
  { accountId: 'RNG-2', pattern: 'structuring', injectedAtMs: 0 },
  { accountId: 'PAS-1', pattern: 'rapid-in-out', injectedAtMs: 0 },
];

describe('simulateVerdict', () => {
  it('confirms an alert on a planted account for the same pattern', () => {
    expect(simulateVerdict(anAlert({ accountId: 'RNG-1' }), truth)).toBe('confirmed');
  });

  it('marks an alert on an unplanted account as a false positive', () => {
    expect(simulateVerdict(anAlert({ accountId: 'ACC-9' }), truth)).toBe('false-positive');
  });

  it('marks an alert on a planted account but for another pattern as a false positive', () => {
    expect(simulateVerdict(anAlert({ accountId: 'PAS-1' }), truth)).toBe('false-positive');
  });
});

describe('scoreRules', () => {
  const alerts = [
    anAlert({ accountId: 'RNG-1' }),
    anAlert({ accountId: 'RNG-2' }),
    anAlert({ accountId: 'ACC-8' }),
    anAlert({ accountId: 'ACC-9' }),
    anAlert({ accountId: 'RNG-1', ruleVersion: 'v2' }),
    anAlert({ accountId: 'RNG-2', ruleVersion: 'v2' }),
  ];
  const scores = scoreRules({
    rules: [
      { ruleId: 'structuring', version: 'v1' },
      { ruleId: 'structuring', version: 'v2' },
      { ruleId: 'rapid-in-out', version: 'v1' },
    ],
    alerts,
    groundTruth: truth,
    nonPlantedTransactionCount: 2000,
  });

  it('computes precision, recall and false positives per 1,000 for v1', () => {
    expect(scores[0]).toMatchObject({
      alerts: 4,
      truePositives: 2,
      falsePositives: 2,
      precision: 0.5,
      recall: 1,
      falsePositivesPer1000: 1,
    });
  });

  it('shows the v2 candidate keeping recall while dropping false positives', () => {
    expect(scores[1]).toMatchObject({ alerts: 2, falsePositives: 0, precision: 1, recall: 1, falsePositivesPer1000: 0 });
  });

  it('reports recall 0 and no precision for a rule that raised nothing', () => {
    expect(scores[2]).toMatchObject({ alerts: 0, recall: 0, precision: undefined });
  });
});

describe('plantedCoverage', () => {
  it('lists planted accounts with no alert from their own rule', () => {
    const coverage = plantedCoverage({
      alerts: [anAlert({ accountId: 'RNG-1' }), anAlert({ accountId: 'PAS-1' })],
      groundTruth: truth,
    });
    expect(coverage).toEqual({ planted: 3, flagged: 1, missing: ['RNG-2', 'PAS-1'], recall: 1 / 3 });
  });

  it('has no recall when nothing is planted', () => {
    expect(plantedCoverage({ alerts: [], groundTruth: [] }).recall).toBeUndefined();
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/scorer.test.ts
```

Expected FAIL: `Cannot find module '../src/scorer'`.

`demos/agent-aml/runner/src/scorer.ts`:

```typescript
import type { Alert, GroundTruthEntry, PatternKind } from './domain';

export type Verdict = 'confirmed' | 'false-positive';

export type RuleVersion = { readonly ruleId: PatternKind; readonly version: string };

export type RuleScore = {
  readonly ruleId: PatternKind;
  readonly ruleVersion: string;
  readonly alerts: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly plantedAccounts: number;
  readonly flaggedPlanted: number;
  readonly precision: number | undefined;
  readonly recall: number | undefined;
  readonly falsePositivesPer1000: number | undefined;
};

export type PlantedCoverage = {
  readonly planted: number;
  readonly flagged: number;
  readonly missing: readonly string[];
  readonly recall: number | undefined;
};

const isPlantedFor = (truth: readonly GroundTruthEntry[], alert: Pick<Alert, 'ruleId' | 'accountId'>): boolean =>
  truth.some((entry) => entry.accountId === alert.accountId && entry.pattern === alert.ruleId);

export const simulateVerdict = (alert: Pick<Alert, 'ruleId' | 'accountId'>, truth: readonly GroundTruthEntry[]): Verdict =>
  isPlantedFor(truth, alert) ? 'confirmed' : 'false-positive';

const ratio = (numerator: number, denominator: number): number | undefined =>
  denominator === 0 ? undefined : numerator / denominator;

export const scoreRules = (options: {
  readonly rules: readonly RuleVersion[];
  readonly alerts: readonly Alert[];
  readonly groundTruth: readonly GroundTruthEntry[];
  readonly nonPlantedTransactionCount: number;
}): readonly RuleScore[] =>
  options.rules.map(({ ruleId, version }) => {
    const mine = options.alerts.filter((alert) => alert.ruleId === ruleId && alert.ruleVersion === version);
    const planted = options.groundTruth.filter((entry) => entry.pattern === ruleId);
    const flaggedAccounts = new Set(mine.map((alert) => alert.accountId));
    const flaggedPlanted = planted.filter((entry) => flaggedAccounts.has(entry.accountId)).length;
    const truePositives = mine.filter((alert) => isPlantedFor(options.groundTruth, alert)).length;
    const falsePositives = mine.length - truePositives;
    return {
      ruleId,
      ruleVersion: version,
      alerts: mine.length,
      truePositives,
      falsePositives,
      plantedAccounts: planted.length,
      flaggedPlanted,
      precision: ratio(truePositives, mine.length),
      recall: ratio(flaggedPlanted, planted.length),
      falsePositivesPer1000: ratio(falsePositives * 1000, options.nonPlantedTransactionCount),
    };
  });

export const plantedCoverage = (options: {
  readonly alerts: readonly Alert[];
  readonly groundTruth: readonly GroundTruthEntry[];
}): PlantedCoverage => {
  const missing = options.groundTruth
    .filter(
      (entry) =>
        !options.alerts.some((alert) => alert.accountId === entry.accountId && alert.ruleId === entry.pattern),
    )
    .map((entry) => entry.accountId);
  const planted = options.groundTruth.length;
  return { planted, flagged: planted - missing.length, missing, recall: ratio(planted - missing.length, planted) };
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/scorer.test.ts
```

Expected PASS: 8 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/scorer.ts demos/agent-aml/runner/test/scorer.test.ts
git commit -m "agent-aml demo: ground-truth scorer and simulated verdicts"
```

### Task 7: Rule what-if comparator and branch isolation evaluator

- [ ] Not started

`demos/agent-aml/runner/test/whatIf.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { Alert, GroundTruthEntry } from '../src/domain';
import { compareRuleVersions, evaluateIsolation } from '../src/whatIf';

const anAlert = (accountId: string, ruleVersion: string): Alert => ({
  ruleId: 'structuring',
  ruleVersion,
  accountId,
  windowStartMs: 0,
  windowEndMs: 0,
  raisedAtMs: 0,
  bucket: 0,
  txnIds: [],
  score: 3,
});

const truth: readonly GroundTruthEntry[] = [
  { accountId: 'RNG-1', pattern: 'structuring', injectedAtMs: 0 },
  { accountId: 'RNG-2', pattern: 'structuring', injectedAtMs: 0 },
];

const compare = (alerts: readonly Alert[]) =>
  compareRuleVersions({
    ruleId: 'structuring',
    baselineVersion: 'v1',
    candidateVersion: 'v2',
    alerts,
    groundTruth: truth,
    nonPlantedTransactionCount: 4000,
  });

describe('compareRuleVersions', () => {
  it('adopts a candidate that keeps recall and cuts alert volume', () => {
    const result = compare([
      anAlert('RNG-1', 'v1'),
      anAlert('RNG-2', 'v1'),
      anAlert('ACC-5', 'v1'),
      anAlert('ACC-6', 'v1'),
      anAlert('RNG-1', 'v2'),
      anAlert('RNG-2', 'v2'),
    ]);
    expect(result).toMatchObject({
      baselineAlerts: 4,
      candidateAlerts: 2,
      alertDelta: -2,
      removedAccounts: ['ACC-5', 'ACC-6'],
      addedAccounts: [],
      decision: 'adopt',
    });
    expect(result.baseline.falsePositivesPer1000).toBe(0.5);
    expect(result.candidate.falsePositivesPer1000).toBe(0);
  });

  it('rejects a candidate that loses a planted account', () => {
    const result = compare([anAlert('RNG-1', 'v1'), anAlert('RNG-2', 'v1'), anAlert('RNG-1', 'v2')]);
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('candidate loses planted recall');
  });

  it('rejects a candidate that does not reduce volume', () => {
    const result = compare([anAlert('RNG-1', 'v1'), anAlert('RNG-2', 'v1'), anAlert('RNG-1', 'v2'), anAlert('RNG-2', 'v2')]);
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('candidate does not reduce alert volume');
  });
});

describe('evaluateIsolation', () => {
  it('passes when only the branch holds the candidate rule and its alerts', () => {
    const result = evaluateIsolation({
      production: { v2Rules: 0, v2Alerts: 0 },
      branch: { v2Rules: 1, v2Alerts: 5 },
    });
    expect(result.isolated).toBe(true);
    expect(result.observed).toBe('branch has 1 v2 rule and 5 v2 alerts; production has 0 and 0');
  });

  it('fails when production shows any candidate rows', () => {
    expect(
      evaluateIsolation({ production: { v2Rules: 1, v2Alerts: 0 }, branch: { v2Rules: 1, v2Alerts: 5 } }).isolated,
    ).toBe(false);
  });

  it('fails when the branch write never happened, so the probe proves nothing', () => {
    expect(
      evaluateIsolation({ production: { v2Rules: 0, v2Alerts: 0 }, branch: { v2Rules: 0, v2Alerts: 0 } }).isolated,
    ).toBe(false);
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/whatIf.test.ts
```

Expected FAIL: `Cannot find module '../src/whatIf'`.

`demos/agent-aml/runner/src/whatIf.ts`:

```typescript
import type { Alert, GroundTruthEntry, PatternKind } from './domain';
import { scoreRules, type RuleScore } from './scorer';

export type WhatIfDecision = 'adopt' | 'reject';

export type WhatIfResult = {
  readonly ruleId: PatternKind;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly baselineAlerts: number;
  readonly candidateAlerts: number;
  readonly alertDelta: number;
  readonly removedAccounts: readonly string[];
  readonly addedAccounts: readonly string[];
  readonly baseline: RuleScore;
  readonly candidate: RuleScore;
  readonly decision: WhatIfDecision;
  readonly reason: string;
};

const accountsOf = (alerts: readonly Alert[]): ReadonlySet<string> => new Set(alerts.map((alert) => alert.accountId));

export const compareRuleVersions = (options: {
  readonly ruleId: PatternKind;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly alerts: readonly Alert[];
  readonly groundTruth: readonly GroundTruthEntry[];
  readonly nonPlantedTransactionCount: number;
}): WhatIfResult => {
  const { ruleId, baselineVersion, candidateVersion, alerts, groundTruth, nonPlantedTransactionCount } = options;
  const [baseline, candidate] = scoreRules({
    rules: [
      { ruleId, version: baselineVersion },
      { ruleId, version: candidateVersion },
    ],
    alerts,
    groundTruth,
    nonPlantedTransactionCount,
  });
  if (baseline === undefined || candidate === undefined) throw new Error('scoreRules returned fewer scores than rules');
  const baselineAccounts = accountsOf(alerts.filter((a) => a.ruleId === ruleId && a.ruleVersion === baselineVersion));
  const candidateAccounts = accountsOf(alerts.filter((a) => a.ruleId === ruleId && a.ruleVersion === candidateVersion));
  const recallHeld = (candidate.recall ?? 0) >= (baseline.recall ?? 0);
  const quieter = candidate.alerts < baseline.alerts;
  const decision: WhatIfDecision = recallHeld && quieter ? 'adopt' : 'reject';
  const reason = !recallHeld
    ? 'candidate loses planted recall'
    : quieter
      ? 'candidate keeps planted recall and raises fewer alerts'
      : 'candidate does not reduce alert volume';
  return {
    ruleId,
    baselineVersion,
    candidateVersion,
    baselineAlerts: baseline.alerts,
    candidateAlerts: candidate.alerts,
    alertDelta: candidate.alerts - baseline.alerts,
    removedAccounts: [...baselineAccounts].filter((id) => !candidateAccounts.has(id)),
    addedAccounts: [...candidateAccounts].filter((id) => !baselineAccounts.has(id)),
    baseline,
    candidate,
    decision,
    reason,
  };
};

export type IsolationProbe = { readonly v2Rules: number; readonly v2Alerts: number };

export const evaluateIsolation = (options: {
  readonly production: IsolationProbe;
  readonly branch: IsolationProbe;
}): { readonly isolated: boolean; readonly observed: string } => {
  const { production, branch } = options;
  const productionClean = production.v2Rules === 0 && production.v2Alerts === 0;
  const branchWritten = branch.v2Rules > 0 && branch.v2Alerts > 0;
  return {
    isolated: productionClean && branchWritten,
    observed: `branch has ${branch.v2Rules} v2 rule and ${branch.v2Alerts} v2 alerts; production has ${production.v2Rules} and ${production.v2Alerts}`,
  };
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/whatIf.test.ts
```

Expected PASS: 6 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/whatIf.ts demos/agent-aml/runner/test/whatIf.test.ts
git commit -m "agent-aml demo: rule what-if comparator and isolation evaluator"
```

### Task 8: Seeded scenario guard for the whole pure core

- [ ] Not started

This task adds no production code. It is the characterization test that the planted story holds end to end in memory: 90 days of seeded history with four look-alike businesses, one planted rapid in-out chain and one planted ring, replayed under v1 and under the v2 candidate.

`demos/agent-aml/runner/test/scenario.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { REPORTING_THRESHOLD_CENTS, type Account, type GroundTruthEntry, type Transaction } from '../src/domain';
import {
  buildPopulation,
  generateHistory,
  plantRapidInOut,
  plantStructuringRing,
} from '../src/generator';
import { createRng } from '../src/prng';
import { baselineRules, candidateStructuring, replayHistory } from '../src/rules';
import { plantedCoverage, scoreRules } from '../src/scorer';
import { compareRuleVersions } from '../src/whatIf';
import { DAY_MS } from '../src/time';

const day0 = Date.UTC(2026, 0, 5);
const historyDays = 90;

const buildWorld = () => {
  const population = buildPopulation({
    rng: createRng(20261016),
    retailCount: 240,
    businessCount: 40,
    lookAlikeCount: 4,
    branchCount: 12,
  });
  const history = generateHistory({
    rng: createRng(42),
    population,
    days: historyDays,
    firstDayStartMs: day0,
    firstTxnId: 1,
    thresholdCents: REPORTING_THRESHOLD_CENTS,
  });
  const rapid = plantRapidInOut({
    rng: createRng(43),
    dayStartMs: day0 + 70 * DAY_MS,
    firstTxnId: history.nextTxnId,
    accountNumber: 1,
    branchCount: 12,
  });
  const lastDayStartMs = day0 + (historyDays + 3) * DAY_MS;
  const ring = plantStructuringRing({
    rng: createRng(44),
    lastDayStartMs,
    firstTxnId: rapid.nextTxnId,
    firstAccountNumber: 1,
    ringSize: 3,
    thresholdCents: REPORTING_THRESHOLD_CENTS,
    branchCount: 12,
  });
  const accounts: readonly Account[] = [...population.accounts, ...rapid.accounts, ...ring.accounts];
  const transactions: readonly Transaction[] = [...history.transactions, ...rapid.transactions, ...ring.transactions];
  const groundTruth: readonly GroundTruthEntry[] = [...rapid.truth, ...ring.truth];
  return { accounts, transactions, groundTruth, lastDayStartMs };
};

describe('seeded scenario end to end', () => {
  const world = buildWorld();
  const plantedAccountIds = new Set(world.groundTruth.map((entry) => entry.accountId));
  const nonPlantedTransactionCount = world.transactions.filter((txn) => !plantedAccountIds.has(txn.accountId)).length;
  const replay = (rules: ReturnType<typeof baselineRules>) =>
    replayHistory({
      rules,
      accounts: world.accounts,
      transactions: world.transactions,
      watchlistCandidates: new Map(),
      firstDayStartMs: day0,
      lastDayStartMs: world.lastDayStartMs,
      lookbackDays: 14,
    });
  const v1Alerts = replay(baselineRules(REPORTING_THRESHOLD_CENTS));
  const v2Alerts = replay([candidateStructuring(REPORTING_THRESHOLD_CENTS)]);
  const alerts = [...v1Alerts, ...v2Alerts];

  it('flags every planted case under the baseline rules', () => {
    const coverage = plantedCoverage({ alerts: v1Alerts, groundTruth: world.groundTruth });
    expect(coverage.missing).toEqual([]);
    expect(coverage.recall).toBe(1);
  });

  it('raises false positives on look-alike businesses under v1', () => {
    const [structuringV1] = scoreRules({
      rules: [{ ruleId: 'structuring', version: 'v1' }],
      alerts,
      groundTruth: world.groundTruth,
      nonPlantedTransactionCount,
    });
    expect(structuringV1?.falsePositives).toBeGreaterThan(10);
    expect(structuringV1?.recall).toBe(1);
  });

  it('shows v2 keeping recall with no false positives', () => {
    const result = compareRuleVersions({
      ruleId: 'structuring',
      baselineVersion: 'v1',
      candidateVersion: 'v2',
      alerts,
      groundTruth: world.groundTruth,
      nonPlantedTransactionCount,
    });
    expect(result.decision).toBe('adopt');
    expect(result.candidate.falsePositives).toBe(0);
    expect(result.candidate.recall).toBe(1);
    expect(result.alertDelta).toBeLessThan(-10);
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/scenario.test.ts
```

Expected PASS: 3 passed (a few seconds, because the test replays 93 simulated days). If the first assertion fails, a generator or rule change broke the planted story; fix that before any live step.

Commit:

```bash
git add demos/agent-aml/runner/test/scenario.test.ts
git commit -m "agent-aml demo: seeded scenario guard"
```

### Task 9: Hybrid recall SQL builder

- [ ] Not started

One statement fuses a vector CTE (`VEC_EMBED_COSINE_DISTANCE`) and a full-text CTE (`fts_match_word`) with reciprocal rank fusion, constant 60, exactly the shape of the documented hybrid query.

`demos/agent-aml/runner/test/recallSql.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildHybridRecallSql, buildRecallQuery, recallHitFromRow } from '../src/recallSql';
import { sqlStringLiteral } from '../src/sqlLiteral';

describe('sqlStringLiteral', () => {
  it('doubles single quotes and backslashes', () => {
    expect(sqlStringLiteral("it's a\\b")).toBe("'it''s a\\\\b'");
  });
});

describe('buildHybridRecallSql', () => {
  const sql = buildHybridRecallSql({ queryText: "cash 'deposits' under threshold" });

  it('fuses a vector CTE and a full-text CTE with reciprocal rank fusion at constant 60', () => {
    expect(sql).toContain('WITH\nvec AS');
    expect(sql).toContain('fts AS');
    expect(sql).toContain('1.0 / (60 + r)');
    expect(sql).toContain('SUM(contribution) AS rrf_score');
  });

  it('embeds the query text once per search with quotes escaped', () => {
    expect(sql.split("'cash ''deposits'' under threshold'")).toHaveLength(4);
  });

  it('reads the vector side from TiFlash and uses fts_match_word on the text side', () => {
    expect(sql).toContain('READ_FROM_STORAGE(TIFLASH[episodic_memory])');
    expect(sql).toContain('VEC_EMBED_COSINE_DISTANCE(summary_vector,');
    expect(sql).toContain('fts_match_word(');
  });

  it('applies the candidate limit to both lists and the top K to the fused list', () => {
    const custom = buildHybridRecallSql({ queryText: 'x', candidateLimit: 12, topK: 5 });
    expect(custom.match(/LIMIT 12/g)).toHaveLength(2);
    expect(custom).toContain('LIMIT 5');
  });

  it('rejects non-integer limits instead of emitting broken SQL', () => {
    expect(() => buildHybridRecallSql({ queryText: 'x', topK: 1.5 })).toThrow('topK must be a safe integer');
  });
});

describe('recallHitFromRow', () => {
  it('maps database columns and keeps a missing rank undefined', () => {
    expect(
      recallHitFromRow({
        memory_id: '4',
        case_id: 'PAST-004',
        pattern: 'structuring',
        outcome: 'confirmed',
        summary: 's',
        rrf_score: '0.0328',
        vector_rank: 1,
        fulltext_rank: null,
      }),
    ).toEqual({
      memoryId: 4,
      caseId: 'PAST-004',
      pattern: 'structuring',
      outcome: 'confirmed',
      summary: 's',
      rrfScore: 0.0328,
      vectorRank: 1,
      fulltextRank: undefined,
    });
  });
});

describe('buildRecallQuery', () => {
  it('describes the pattern in the words past case summaries use', () => {
    expect(buildRecallQuery({ pattern: 'structuring', accountKind: 'retail', distinctBranches: 3 })).toBe(
      'repeated cash deposits just under the reporting threshold across several branches retail account 3 branches',
    );
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/recallSql.test.ts
```

Expected FAIL: `Cannot find module '../src/recallSql'`.

`demos/agent-aml/runner/src/sqlLiteral.ts`:

```typescript
export const sqlStringLiteral = (value: string): string =>
  `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;

export const assertSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer: ${value}`);
  return value;
};

const accountIdPattern = /^[A-Z]{3}-\d{4}$/;
const branchCodePattern = /^B\d{2}$/;

export const assertAccountId = (value: string): string => {
  if (!accountIdPattern.test(value)) throw new Error(`not an account id: ${value}`);
  return value;
};

export const assertBranchCode = (value: string): string => {
  if (!branchCodePattern.test(value)) throw new Error(`not a branch code: ${value}`);
  return value;
};
```

`demos/agent-aml/runner/src/recallSql.ts`:

```typescript
import type { PatternKind } from './domain';
import { assertSafeInteger, sqlStringLiteral } from './sqlLiteral';

export type RecallOptions = {
  readonly queryText: string;
  readonly candidateLimit?: number;
  readonly topK?: number;
};

export const RRF_CONSTANT = 60;

export const buildHybridRecallSql = (options: RecallOptions): string => {
  const candidateLimit = assertSafeInteger('candidateLimit', options.candidateLimit ?? 20);
  const topK = assertSafeInteger('topK', options.topK ?? 3);
  const query = sqlStringLiteral(options.queryText);
  return `
WITH
vec AS (
  SELECT memory_id,
         ROW_NUMBER() OVER (ORDER BY distance, memory_id) AS r
  FROM (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[episodic_memory]) */
           memory_id,
           VEC_EMBED_COSINE_DISTANCE(summary_vector, ${query}) AS distance
    FROM episodic_memory
    ORDER BY distance
    LIMIT ${candidateLimit}
  ) v
),
fts AS (
  SELECT memory_id,
         ROW_NUMBER() OVER (ORDER BY score DESC, memory_id) AS r
  FROM (
    SELECT memory_id,
           fts_match_word(${query}, summary) AS score
    FROM episodic_memory
    WHERE fts_match_word(${query}, summary)
    ORDER BY score DESC
    LIMIT ${candidateLimit}
  ) f
),
hits AS (
  SELECT memory_id, 1.0 / (${RRF_CONSTANT} + r) AS contribution, r AS vector_rank, NULL AS fulltext_rank FROM vec
  UNION ALL
  SELECT memory_id, 1.0 / (${RRF_CONSTANT} + r), NULL, r FROM fts
),
top_hits AS (
  SELECT memory_id,
         SUM(contribution) AS rrf_score,
         MAX(vector_rank) AS vector_rank,
         MAX(fulltext_rank) AS fulltext_rank
  FROM hits
  GROUP BY memory_id
  ORDER BY rrf_score DESC, memory_id
  LIMIT ${topK}
)
SELECT m.memory_id, m.case_id, m.pattern, m.outcome, m.summary,
       t.rrf_score, t.vector_rank, t.fulltext_rank
FROM top_hits t
JOIN episodic_memory m ON m.memory_id = t.memory_id
ORDER BY t.rrf_score DESC, t.memory_id
`.trim();
};

export type RecallHit = {
  readonly memoryId: number;
  readonly caseId: string;
  readonly pattern: string;
  readonly outcome: string;
  readonly summary: string;
  readonly rrfScore: number;
  readonly vectorRank: number | undefined;
  readonly fulltextRank: number | undefined;
};

const optionalNumber = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

export const recallHitFromRow = (row: Readonly<Record<string, unknown>>): RecallHit => ({
  memoryId: Number(row.memory_id),
  caseId: String(row.case_id),
  pattern: String(row.pattern),
  outcome: String(row.outcome),
  summary: String(row.summary),
  rrfScore: Number(row.rrf_score),
  vectorRank: optionalNumber(row.vector_rank),
  fulltextRank: optionalNumber(row.fulltext_rank),
});

export const patternPhrases: Readonly<Record<PatternKind, string>> = {
  structuring: 'repeated cash deposits just under the reporting threshold across several branches',
  'rapid-in-out': 'wire in then near-full wire out within hours pass-through',
  'watchlist-near-match': 'account holder name close to a watchlist entry fuzzy name match',
};

export const buildRecallQuery = (options: {
  readonly pattern: PatternKind;
  readonly accountKind: string;
  readonly distinctBranches: number;
}): string =>
  `${patternPhrases[options.pattern]} ${options.accountKind} account ${options.distinctBranches} branches`;
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/recallSql.test.ts
```

Expected PASS: 8 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/sqlLiteral.ts demos/agent-aml/runner/src/recallSql.ts demos/agent-aml/runner/test/recallSql.test.ts
git commit -m "agent-aml demo: hybrid recall SQL builder"
```

### Task 10: Starter schema, statement builders and row mappers

- [ ] Not started

`demos/agent-aml/runner/test/schema.test.ts` and `demos/agent-aml/runner/test/starterSql.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { resetStatements, schemaStatements } from '../src/schema';

describe('schemaStatements', () => {
  it('creates every table idempotently', () => {
    expect(schemaStatements).toHaveLength(9);
    schemaStatements.forEach((sql) => expect(sql.startsWith('CREATE TABLE IF NOT EXISTS')).toBe(true));
  });

  it('gives episodic memory auto-embedding, a full-text index and a vector index', () => {
    const memory = schemaStatements.find((sql) => sql.includes('episodic_memory')) ?? '';
    expect(memory).toContain('VECTOR(1024)');
    expect(memory).toContain('EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", summary)');
    expect(memory).toContain('FULLTEXT INDEX ft_summary (summary) WITH PARSER STANDARD');
    expect(memory).toContain('VECTOR INDEX idx_summary_vec ((VEC_COSINE_DISTANCE(summary_vector)))');
  });

  it('keeps alerts unique per rule version, account and week so replays are idempotent', () => {
    const alerts = schemaStatements.find((sql) => sql.includes('TABLE IF NOT EXISTS alerts')) ?? '';
    expect(alerts).toContain('UNIQUE KEY uq_alert (rule_id, rule_version, account_id, bucket)');
  });

  it('indexes the watchlist name for fts_match_word', () => {
    const watchlist = schemaStatements.find((sql) => sql.includes('TABLE IF NOT EXISTS watchlist')) ?? '';
    expect(watchlist).toContain('FULLTEXT INDEX ft_full_name (full_name) WITH PARSER STANDARD');
  });

  it('truncates one table per reset statement', () => {
    expect(resetStatements).toHaveLength(9);
    resetStatements.forEach((sql) => expect(sql.startsWith('TRUNCATE TABLE ')).toBe(true));
  });
});
```

```typescript
import { describe, expect, it } from 'vitest';
import type { Alert, Transaction } from '../src/domain';
import { alertFromRow, transactionFromRow } from '../src/rowMappers';
import {
  alertInsert,
  buildBulkInsert,
  caseInsert,
  chunk,
  entityFactsInsert,
  episodicInsert,
  ruleUpsert,
  selectWatchlistCandidates,
  transactionInserts,
  watchlistInsert,
} from '../src/starterSql';
import { candidateStructuring } from '../src/rules';

const aTxn = (txnId: number): Transaction => ({
  txnId,
  accountId: 'ACC-0001',
  counterpartyId: 'CP-001',
  txnType: 'cash_deposit',
  amountCents: 950_000,
  txnTsMs: Date.UTC(2026, 0, 5, 10, 30, 15, 123),
  branchCode: 'B01',
  memo: 'cash deposit',
});

describe('buildBulkInsert', () => {
  it('returns an empty statement for no rows', () => {
    expect(buildBulkInsert({ table: 't', columns: ['a'], rows: [] })).toEqual({ sql: '', params: [] });
  });

  it('quotes identifiers and builds one placeholder group per row', () => {
    const result = buildBulkInsert({ table: 't', columns: ['a', 'b'], rows: [[1, 2], [3, 4]], ignoreDuplicates: true });
    expect(result.sql).toBe('INSERT IGNORE INTO `t` (`a`, `b`) VALUES (?, ?), (?, ?)');
    expect(result.params).toEqual([1, 2, 3, 4]);
  });
});

describe('chunk', () => {
  it('splits into batches with a short final batch', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('transactionInserts', () => {
  it('formats timestamps to millisecond precision and batches 500 rows', () => {
    const statements = transactionInserts(Array.from({ length: 501 }, (_, index) => aTxn(index + 1)));
    expect(statements).toHaveLength(2);
    expect(statements[0]?.params).toHaveLength(500 * 8);
    expect(statements[0]?.params[5]).toBe('2026-01-05 10:30:15.123');
  });
});

describe('alertInsert and ruleUpsert', () => {
  it('serializes txn ids as JSON and ignores duplicate alert keys', () => {
    const alert: Alert = {
      ruleId: 'structuring',
      ruleVersion: 'v1',
      accountId: 'ACC-0001',
      windowStartMs: Date.UTC(2026, 0, 5),
      windowEndMs: Date.UTC(2026, 0, 6),
      raisedAtMs: Date.UTC(2026, 0, 6, 23, 59, 59, 999),
      bucket: 2900,
      txnIds: [1, 2, 3],
      score: 3,
    };
    const statement = alertInsert([alert]);
    expect(statement.sql.startsWith('INSERT IGNORE INTO `alerts`')).toBe(true);
    expect(statement.params).toContain('[1,2,3]');
  });

  it('upserts the candidate rule params as JSON text', () => {
    const statement = ruleUpsert(candidateStructuring(1_000_000));
    expect(statement.params[0]).toBe('structuring');
    expect(statement.params[1]).toBe('v2');
    expect(JSON.parse(String(statement.params[2]))).toMatchObject({ minDistinctBranches: 2 });
  });
});

describe('selectWatchlistCandidates', () => {
  it('uses fts_match_word for filtering and for relevance ordering', () => {
    const sql = selectWatchlistCandidates('queaby marlow');
    expect(sql).toContain("WHERE fts_match_word('queaby marlow', full_name)");
    expect(sql).toContain("ORDER BY fts_match_word('queaby marlow', full_name) DESC");
  });
});

describe('row mappers', () => {
  it('parses a transaction row with a microsecond timestamp as UTC', () => {
    const txn = transactionFromRow({
      txn_id: '7',
      account_id: 'ACC-0001',
      counterparty_id: 'CP-001',
      txn_type: 'wire_in',
      amount_cents: '12345',
      txn_ts_text: '2026-01-05 10:30:15.123000',
      branch_code: 'B01',
      memo: 'invoice payment',
    });
    expect(txn.txnTsMs).toBe(Date.UTC(2026, 0, 5, 10, 30, 15, 123));
    expect(txn.amountCents).toBe(12345);
  });

  it('rejects a transaction row with an unknown type', () => {
    expect(() =>
      transactionFromRow({
        txn_id: 1,
        account_id: 'a',
        counterparty_id: 'c',
        txn_type: 'crypto',
        amount_cents: 1,
        txn_ts_text: '2026-01-05 10:30:15.123000',
        branch_code: 'B01',
        memo: 'm',
      }),
    ).toThrow();
  });

  it('parses an alert row whose JSON column arrives as text or as an array', () => {
    const base = {
      rule_id: 'structuring',
      rule_version: 'v1',
      account_id: 'ACC-0001',
      bucket: '2900',
      window_start_text: '2026-01-05 00:00:00.000000',
      window_end_text: '2026-01-06 00:00:00.000000',
      score: 3,
      raised_at_text: '2026-01-06 23:59:59.999000',
    };
    expect(alertFromRow({ ...base, txn_ids: '[1,2]' }).txnIds).toEqual([1, 2]);
    expect(alertFromRow({ ...base, txn_ids: [3] }).txnIds).toEqual([3]);
  });
});

describe('seed inserts', () => {
  it('writes three entity facts per account', () => {
    const statement = entityFactsInsert([{ accountId: 'ACC-0001', holderName: 'Marlow Quenby', kind: 'retail', homeBranch: 'B01' }]);
    expect(statement.params).toEqual([
      'ACC-0001', 'holder_name', 'Marlow Quenby',
      'ACC-0001', 'kind', 'retail',
      'ACC-0001', 'home_branch', 'B01',
    ]);
  });

  it('inserts watchlist and episodic rows without the generated vector column', () => {
    expect(watchlistInsert([{ fullName: 'Veskar Tolmund Draycott', listTag: 'SYNTH-LIST' }]).sql).toBe(
      'INSERT INTO `watchlist` (`full_name`, `list_tag`) VALUES (?, ?)',
    );
    expect(
      episodicInsert([{ caseId: 'PAST-001', pattern: 'structuring', outcome: 'confirmed', summary: 's' }]).sql,
    ).toBe('INSERT INTO `episodic_memory` (`case_id`, `pattern`, `outcome`, `summary`) VALUES (?, ?, ?, ?)');
  });

  it('records a case with its layer, branch and journal ids', () => {
    const statement = caseInsert({
      caseId: 'CASE-0001',
      accountId: 'RNG-0001',
      pattern: 'structuring',
      openedAtMs: Date.UTC(2026, 3, 1),
      layerId: 'layer-1',
      branchId: 'br-1',
      journalId: 'jrn-case-0001',
    });
    expect(statement.params).toEqual(['CASE-0001', 'RNG-0001', 'structuring', '2026-04-01 00:00:00.000', 'layer-1', 'br-1', 'jrn-case-0001']);
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/schema.test.ts runner/test/starterSql.test.ts
```

Expected FAIL: `Cannot find module '../src/schema'`.

`demos/agent-aml/runner/src/schema.ts`:

```typescript
export const schemaStatements: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
    account_id VARCHAR(16) PRIMARY KEY,
    holder_name VARCHAR(120) NOT NULL,
    kind VARCHAR(12) NOT NULL,
    home_branch VARCHAR(8) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    txn_id BIGINT PRIMARY KEY,
    account_id VARCHAR(16) NOT NULL,
    counterparty_id VARCHAR(16) NOT NULL,
    txn_type VARCHAR(16) NOT NULL,
    amount_cents BIGINT NOT NULL,
    txn_ts DATETIME(3) NOT NULL,
    branch_code VARCHAR(8) NOT NULL,
    memo VARCHAR(80) NOT NULL,
    KEY idx_account_ts (account_id, txn_ts),
    KEY idx_ts (txn_ts)
  )`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    entry_id INT PRIMARY KEY AUTO_INCREMENT,
    full_name VARCHAR(120) NOT NULL,
    list_tag VARCHAR(24) NOT NULL,
    FULLTEXT INDEX ft_full_name (full_name) WITH PARSER STANDARD
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    rule_id VARCHAR(32) NOT NULL,
    version VARCHAR(8) NOT NULL,
    params JSON NOT NULL,
    active TINYINT NOT NULL DEFAULT 1,
    PRIMARY KEY (rule_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    alert_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    rule_id VARCHAR(32) NOT NULL,
    rule_version VARCHAR(8) NOT NULL,
    account_id VARCHAR(16) NOT NULL,
    bucket BIGINT NOT NULL,
    window_start DATETIME(3) NOT NULL,
    window_end DATETIME(3) NOT NULL,
    score DOUBLE NOT NULL,
    txn_ids JSON NOT NULL,
    raised_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_alert (rule_id, rule_version, account_id, bucket)
  )`,
  `CREATE TABLE IF NOT EXISTS ground_truth (
    account_id VARCHAR(16) PRIMARY KEY,
    pattern VARCHAR(32) NOT NULL,
    injected_at DATETIME(3) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cases (
    case_id VARCHAR(24) PRIMARY KEY,
    alert_id BIGINT NOT NULL,
    account_id VARCHAR(16) NOT NULL,
    pattern VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL,
    opened_at DATETIME(3) NOT NULL,
    layer_id VARCHAR(64) NOT NULL,
    branch_id VARCHAR(64) NOT NULL,
    journal_id VARCHAR(64) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS entity_facts (
    entity_id VARCHAR(16) NOT NULL,
    fact_key VARCHAR(40) NOT NULL,
    fact_value VARCHAR(200) NOT NULL,
    PRIMARY KEY (entity_id, fact_key)
  )`,
  `CREATE TABLE IF NOT EXISTS episodic_memory (
    memory_id INT PRIMARY KEY AUTO_INCREMENT,
    case_id VARCHAR(24) NOT NULL,
    pattern VARCHAR(32) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    summary TEXT NOT NULL,
    summary_vector VECTOR(1024) GENERATED ALWAYS AS (
      EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", summary)
    ) STORED,
    FULLTEXT INDEX ft_summary (summary) WITH PARSER STANDARD,
    VECTOR INDEX idx_summary_vec ((VEC_COSINE_DISTANCE(summary_vector)))
  )`,
];

export const resetStatements: readonly string[] = [
  'TRUNCATE TABLE transactions',
  'TRUNCATE TABLE accounts',
  'TRUNCATE TABLE alerts',
  'TRUNCATE TABLE ground_truth',
  'TRUNCATE TABLE cases',
  'TRUNCATE TABLE entity_facts',
  'TRUNCATE TABLE watchlist',
  'TRUNCATE TABLE rules',
  'TRUNCATE TABLE episodic_memory',
];
```

`demos/agent-aml/runner/src/rowMappers.ts`:

```typescript
import { z } from 'zod';
import type { Account, Alert, GroundTruthEntry, Transaction, WatchlistEntry } from './domain';
import { parseDateTime } from './time';

const PatternSchema = z.enum(['structuring', 'rapid-in-out', 'watchlist-near-match']);

const TransactionRowSchema = z.object({
  txn_id: z.coerce.number(),
  account_id: z.string(),
  counterparty_id: z.string(),
  txn_type: z.enum(['cash_deposit', 'wire_in', 'wire_out', 'card_purchase']),
  amount_cents: z.coerce.number(),
  txn_ts_text: z.string(),
  branch_code: z.string(),
  memo: z.string(),
});

const AccountRowSchema = z.object({
  account_id: z.string(),
  holder_name: z.string(),
  kind: z.enum(['retail', 'business']),
  home_branch: z.string(),
});

const GroundTruthRowSchema = z.object({
  account_id: z.string(),
  pattern: PatternSchema,
  injected_at_text: z.string(),
});

const JsonNumberArraySchema = z
  .union([z.string().transform((text): unknown => JSON.parse(text)), z.array(z.number())])
  .pipe(z.array(z.number()));

const AlertRowSchema = z.object({
  rule_id: PatternSchema,
  rule_version: z.string(),
  account_id: z.string(),
  bucket: z.coerce.number(),
  window_start_text: z.string(),
  window_end_text: z.string(),
  score: z.coerce.number(),
  txn_ids: JsonNumberArraySchema,
  raised_at_text: z.string(),
});

const WatchlistRowSchema = z.object({
  entry_id: z.coerce.number(),
  full_name: z.string(),
  list_tag: z.string(),
});

export const transactionFromRow = (row: unknown): Transaction => {
  const parsed = TransactionRowSchema.parse(row);
  return {
    txnId: parsed.txn_id,
    accountId: parsed.account_id,
    counterpartyId: parsed.counterparty_id,
    txnType: parsed.txn_type,
    amountCents: parsed.amount_cents,
    txnTsMs: parseDateTime(parsed.txn_ts_text),
    branchCode: parsed.branch_code,
    memo: parsed.memo,
  };
};

export const accountFromRow = (row: unknown): Account => {
  const parsed = AccountRowSchema.parse(row);
  return {
    accountId: parsed.account_id,
    holderName: parsed.holder_name,
    kind: parsed.kind,
    homeBranch: parsed.home_branch,
  };
};

export const groundTruthFromRow = (row: unknown): GroundTruthEntry => {
  const parsed = GroundTruthRowSchema.parse(row);
  return { accountId: parsed.account_id, pattern: parsed.pattern, injectedAtMs: parseDateTime(parsed.injected_at_text) };
};

export const alertFromRow = (row: unknown): Alert => {
  const parsed = AlertRowSchema.parse(row);
  return {
    ruleId: parsed.rule_id,
    ruleVersion: parsed.rule_version,
    accountId: parsed.account_id,
    bucket: parsed.bucket,
    windowStartMs: parseDateTime(parsed.window_start_text),
    windowEndMs: parseDateTime(parsed.window_end_text),
    txnIds: parsed.txn_ids,
    score: parsed.score,
    raisedAtMs: parseDateTime(parsed.raised_at_text),
  };
};

export const watchlistEntryFromRow = (row: unknown): WatchlistEntry => {
  const parsed = WatchlistRowSchema.parse(row);
  return { entryId: parsed.entry_id, fullName: parsed.full_name, listTag: parsed.list_tag };
};
```

`demos/agent-aml/runner/src/starterSql.ts`:

```typescript
import { quoteIdentifier } from '@lab/runner-kit';
import type { Account, Alert, GroundTruthEntry, Transaction } from './domain';
import { sqlStringLiteral } from './sqlLiteral';
import { formatDateTimeMs } from './time';
import type { RuleDefinition } from './rules';

export type Statement = { readonly sql: string; readonly params: readonly unknown[] };

export const BULK_BATCH_SIZE = 500;

export const buildBulkInsert = (options: {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly ignoreDuplicates?: boolean;
}): Statement => {
  if (options.rows.length === 0) return { sql: '', params: [] };
  const columnList = options.columns.map(quoteIdentifier).join(', ');
  const group = `(${options.columns.map(() => '?').join(', ')})`;
  const verb = options.ignoreDuplicates === true ? 'INSERT IGNORE INTO' : 'INSERT INTO';
  return {
    sql: `${verb} ${quoteIdentifier(options.table)} (${columnList}) VALUES ${options.rows.map(() => group).join(', ')}`,
    params: options.rows.flat(),
  };
};

export const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export const transactionInserts = (transactions: readonly Transaction[]): readonly Statement[] =>
  chunk(transactions, BULK_BATCH_SIZE).map((batch) =>
    buildBulkInsert({
      table: 'transactions',
      columns: ['txn_id', 'account_id', 'counterparty_id', 'txn_type', 'amount_cents', 'txn_ts', 'branch_code', 'memo'],
      rows: batch.map((txn) => [
        txn.txnId,
        txn.accountId,
        txn.counterpartyId,
        txn.txnType,
        txn.amountCents,
        formatDateTimeMs(txn.txnTsMs),
        txn.branchCode,
        txn.memo,
      ]),
    }),
  );

export const accountInsert = (accounts: readonly Account[]): Statement =>
  buildBulkInsert({
    table: 'accounts',
    columns: ['account_id', 'holder_name', 'kind', 'home_branch'],
    rows: accounts.map((account) => [account.accountId, account.holderName, account.kind, account.homeBranch]),
    ignoreDuplicates: true,
  });

export const groundTruthInsert = (entries: readonly GroundTruthEntry[]): Statement =>
  buildBulkInsert({
    table: 'ground_truth',
    columns: ['account_id', 'pattern', 'injected_at'],
    rows: entries.map((entry) => [entry.accountId, entry.pattern, formatDateTimeMs(entry.injectedAtMs)]),
    ignoreDuplicates: true,
  });

export const alertInsert = (alerts: readonly Alert[]): Statement =>
  buildBulkInsert({
    table: 'alerts',
    columns: [
      'rule_id',
      'rule_version',
      'account_id',
      'bucket',
      'window_start',
      'window_end',
      'score',
      'txn_ids',
      'raised_at',
    ],
    rows: alerts.map((alert) => [
      alert.ruleId,
      alert.ruleVersion,
      alert.accountId,
      alert.bucket,
      formatDateTimeMs(alert.windowStartMs),
      formatDateTimeMs(alert.windowEndMs),
      alert.score,
      JSON.stringify(alert.txnIds),
      formatDateTimeMs(alert.raisedAtMs),
    ]),
    ignoreDuplicates: true,
  });

export const ruleUpsert = (rule: RuleDefinition): Statement => ({
  sql:
    'INSERT INTO rules (rule_id, version, params, active) VALUES (?, ?, ?, 1) ' +
    'ON DUPLICATE KEY UPDATE params = VALUES(params), active = VALUES(active)',
  params: [rule.ruleId, rule.version, JSON.stringify(rule.params)],
});

const datetimeText = (column: string): string => `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s.%f')`;

export const selectTransactionsSince = `SELECT txn_id, account_id, counterparty_id, txn_type, amount_cents, ${datetimeText('txn_ts')} AS txn_ts_text, branch_code, memo FROM transactions WHERE txn_ts > ? ORDER BY txn_id`;

export const selectAccounts = 'SELECT account_id, holder_name, kind, home_branch FROM accounts ORDER BY account_id';

export const selectGroundTruth = `SELECT account_id, pattern, ${datetimeText('injected_at')} AS injected_at_text FROM ground_truth ORDER BY account_id`;

export const selectAlerts = `SELECT rule_id, rule_version, account_id, bucket, ${datetimeText('window_start')} AS window_start_text, ${datetimeText('window_end')} AS window_end_text, score, txn_ids, ${datetimeText('raised_at')} AS raised_at_text FROM alerts ORDER BY alert_id`;

export const selectActiveRules = 'SELECT rule_id, version, params FROM rules WHERE active = 1 ORDER BY rule_id, version';

export const countNonPlantedTransactions =
  'SELECT COUNT(*) AS n FROM transactions WHERE account_id NOT IN (SELECT account_id FROM ground_truth)';

export const countTransactionsUpTo = 'SELECT COUNT(*) AS n FROM transactions WHERE txn_id <= ?';

export const maxTransactionId = 'SELECT COALESCE(MAX(txn_id), 0) AS max_id FROM transactions';

export const alertVolumeByVersion =
  'SELECT rule_version, COUNT(*) AS alerts FROM alerts WHERE rule_id = ? GROUP BY rule_version ORDER BY rule_version';

export const isolationProbe =
  "SELECT (SELECT COUNT(*) FROM rules WHERE version = 'v2') AS v2_rules, (SELECT COUNT(*) FROM alerts WHERE rule_version = 'v2') AS v2_alerts";

export const selectWatchlistCandidates = (ftsQuery: string): string => {
  const literal = sqlStringLiteral(ftsQuery);
  return `SELECT entry_id, full_name, list_tag FROM watchlist WHERE fts_match_word(${literal}, full_name) ORDER BY fts_match_word(${literal}, full_name) DESC LIMIT 5`;
};

export const entityFactsInsert = (accounts: readonly Account[]): Statement =>
  buildBulkInsert({
    table: 'entity_facts',
    columns: ['entity_id', 'fact_key', 'fact_value'],
    rows: accounts.flatMap((account) => [
      [account.accountId, 'holder_name', account.holderName],
      [account.accountId, 'kind', account.kind],
      [account.accountId, 'home_branch', account.homeBranch],
    ]),
    ignoreDuplicates: true,
  });

export const selectEntityFacts = 'SELECT fact_key, fact_value FROM entity_facts WHERE entity_id = ? ORDER BY fact_key';

export const watchlistInsert = (entries: readonly { readonly fullName: string; readonly listTag: string }[]): Statement =>
  buildBulkInsert({
    table: 'watchlist',
    columns: ['full_name', 'list_tag'],
    rows: entries.map((entry) => [entry.fullName, entry.listTag]),
  });

export const episodicInsert = (
  items: readonly { readonly caseId: string; readonly pattern: string; readonly outcome: string; readonly summary: string }[],
): Statement =>
  buildBulkInsert({
    table: 'episodic_memory',
    columns: ['case_id', 'pattern', 'outcome', 'summary'],
    rows: items.map((item) => [item.caseId, item.pattern, item.outcome, item.summary]),
  });

export const caseInsert = (record: {
  readonly caseId: string;
  readonly accountId: string;
  readonly pattern: string;
  readonly openedAtMs: number;
  readonly layerId: string;
  readonly branchId: string;
  readonly journalId: string;
}): Statement => ({
  sql:
    'INSERT INTO cases (case_id, alert_id, account_id, pattern, status, opened_at, layer_id, branch_id, journal_id) ' +
    "VALUES (?, 0, ?, ?, 'open', ?, ?, ?, ?)",
  params: [
    record.caseId,
    record.accountId,
    record.pattern,
    formatDateTimeMs(record.openedAtMs),
    record.layerId,
    record.branchId,
    record.journalId,
  ],
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/schema.test.ts runner/test/starterSql.test.ts
```

Expected PASS: 18 passed (5 and 13).

Commit:

```bash
git add demos/agent-aml/runner/src/schema.ts demos/agent-aml/runner/src/rowMappers.ts demos/agent-aml/runner/src/starterSql.ts demos/agent-aml/runner/test/schema.test.ts demos/agent-aml/runner/test/starterSql.test.ts
git commit -m "agent-aml demo: Starter schema, statements and row mappers"
```

### Task 11: Case working set builder, linking and renderers

- [ ] Not started

The short-term memory of a case is a working set built from the alert, the flagged transactions, accounts that share an outgoing counterparty, Lake history peers and the recalled cases. It is rendered into notes and a draft report that say plainly nothing is filed.

`demos/agent-aml/runner/test/workingSet.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { Account, Alert, Transaction } from '../src/domain';
import type { RecallHit } from '../src/recallSql';
import {
  buildWorkingSet,
  caseIdFor,
  findLinks,
  pickCaseAlert,
  renderDraftReport,
  renderNotes,
  summarizePeers,
} from '../src/workingSet';

const account: Account = { accountId: 'RNG-0001', holderName: 'Marlow Quenby', kind: 'retail', homeBranch: 'B01' };

const aTxn = (overrides: Partial<Transaction>): Transaction => ({
  txnId: 1,
  accountId: 'RNG-0001',
  counterpartyId: 'CP-TILL',
  txnType: 'cash_deposit',
  amountCents: 950_000,
  txnTsMs: 0,
  branchCode: 'B01',
  memo: 'cash deposit',
  ...overrides,
});

const alert: Alert = {
  ruleId: 'structuring',
  ruleVersion: 'v1',
  accountId: 'RNG-0001',
  windowStartMs: 0,
  windowEndMs: 0,
  raisedAtMs: 10,
  bucket: 1,
  txnIds: [1, 2, 3],
  score: 3,
};

const transactions: readonly Transaction[] = [
  aTxn({ txnId: 1, branchCode: 'B01' }),
  aTxn({ txnId: 2, branchCode: 'B02', amountCents: 960_000 }),
  aTxn({ txnId: 3, branchCode: 'B03', amountCents: 940_000 }),
  aTxn({ txnId: 4, txnType: 'wire_out', counterpartyId: 'CP-MULE-01', amountCents: 2_700_000 }),
  aTxn({ txnId: 5, accountId: 'RNG-0002', txnType: 'wire_out', counterpartyId: 'CP-MULE-01' }),
  aTxn({ txnId: 6, accountId: 'ACC-0100', txnType: 'wire_out', counterpartyId: 'CP-007' }),
  aTxn({ txnId: 7, accountId: 'RNG-0001', txnType: 'wire_out', counterpartyId: 'CP-007' }),
];

describe('caseIdFor', () => {
  it('zero pads the sequence', () => {
    expect(caseIdFor(7)).toBe('CASE-0007');
  });
});

describe('summarizePeers', () => {
  it('counts peers and the single-branch subset', () => {
    expect(summarizePeers([{ branches: '1' }, { branches: 1 }, { branches: 3 }])).toEqual({
      accountsWithBandActivity: 3,
      singleBranchAccounts: 2,
    });
  });
});

describe('findLinks', () => {
  it('links accounts that share an outgoing counterparty used by a small group', () => {
    expect(findLinks({ accountId: 'RNG-0001', transactions, maxSharers: 6 })).toEqual({
      accounts: ['ACC-0100', 'RNG-0002'],
      counterparties: ['CP-007', 'CP-MULE-01'],
    });
  });

  it('ignores counterparties shared by more accounts than the cap', () => {
    expect(findLinks({ accountId: 'RNG-0001', transactions, maxSharers: 1 })).toEqual({
      accounts: [],
      counterparties: [],
    });
  });
});

describe('pickCaseAlert', () => {
  const other: Alert = { ...alert, ruleId: 'rapid-in-out', accountId: 'PAS-0001', raisedAtMs: 99 };

  it('prefers the requested pattern over a newer alert for another pattern', () => {
    expect(pickCaseAlert({ alerts: [other, alert], preferred: 'structuring', excludeAccounts: [] })?.accountId).toBe(
      'RNG-0001',
    );
  });

  it('ranks a higher score first even when another alert is newer', () => {
    const newerButWeaker: Alert = { ...alert, accountId: 'ACC-0100', score: 3, raisedAtMs: 500 };
    const stronger: Alert = { ...alert, accountId: 'RNG-0002', score: 6, raisedAtMs: 100 };
    expect(
      pickCaseAlert({ alerts: [newerButWeaker, stronger], preferred: 'structuring', excludeAccounts: [] })?.accountId,
    ).toBe('RNG-0002');
  });

  it('skips accounts that already have a case', () => {
    expect(
      pickCaseAlert({ alerts: [other, alert], preferred: 'structuring', excludeAccounts: ['RNG-0001'] })?.accountId,
    ).toBe('PAS-0001');
  });

  it('returns undefined when nothing is open', () => {
    expect(pickCaseAlert({ alerts: [], preferred: 'structuring', excludeAccounts: [] })).toBeUndefined();
  });
});

describe('buildWorkingSet and renderers', () => {
  const hits: readonly RecallHit[] = [
    {
      memoryId: 1,
      caseId: 'PAST-001',
      pattern: 'structuring',
      outcome: 'confirmed',
      summary: 's',
      rrfScore: 0.0328,
      vectorRank: 1,
      fulltextRank: 1,
    },
  ];
  const workingSet = buildWorkingSet({
    caseId: 'CASE-0001',
    alert,
    account,
    windowTransactions: transactions,
    recallHits: hits,
    peers: { accountsWithBandActivity: 4, singleBranchAccounts: 4 },
    facts: { home_branch: 'B01' },
  });

  it('summarizes the flagged activity from the alert transaction ids', () => {
    expect(workingSet).toMatchObject({
      flaggedTxnCount: 3,
      flaggedTotalCents: 2_850_000,
      distinctBranches: 3,
      linkedAccounts: ['ACC-0100', 'RNG-0002'],
    });
  });

  it('renders analyst notes with the recalled cases and peers', () => {
    const notes = renderNotes(workingSet);
    expect(notes).toContain('Flagged transactions: 3, total $28,500.00');
    expect(notes).toContain('- PAST-001 (structuring, confirmed), fused score 0.0328');
    expect(notes).toContain('History peers with similar activity: 4, of which single branch: 4');
  });

  it('renders a draft report that says nothing was filed and makes no determination', () => {
    const report = renderDraftReport(workingSet);
    expect(report).toContain('Nothing has been filed. A human analyst decides what happens next.');
    expect(report).toContain('It makes no compliance or legal determination.');
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/workingSet.test.ts
```

Expected FAIL: `Cannot find module '../src/workingSet'`.

`demos/agent-aml/runner/src/format.ts`:

```typescript
export const formatCents = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${sign}$${dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${remainder}`;
};

export const percentText = (ratio: number | undefined): string =>
  ratio === undefined ? 'n/a' : `${(ratio * 100).toFixed(1)}%`;
```

`demos/agent-aml/runner/src/workingSet.ts`:

```typescript
import type { Account, Alert, PatternKind, Transaction } from './domain';
import { formatCents } from './format';
import type { RecallHit } from './recallSql';

export type PeerSummary = {
  readonly accountsWithBandActivity: number;
  readonly singleBranchAccounts: number;
};

export type PriorCase = {
  readonly caseId: string;
  readonly pattern: string;
  readonly outcome: string;
  readonly rrfScore: number;
};

export type CaseWorkingSet = {
  readonly caseId: string;
  readonly pattern: PatternKind;
  readonly ruleVersion: string;
  readonly accountId: string;
  readonly holderName: string;
  readonly accountKind: string;
  readonly alertScore: number;
  readonly flaggedTxnCount: number;
  readonly flaggedTotalCents: number;
  readonly distinctBranches: number;
  readonly linkedAccounts: readonly string[];
  readonly sharedCounterparties: readonly string[];
  readonly priorCases: readonly PriorCase[];
  readonly peers: PeerSummary;
  readonly facts: Readonly<Record<string, string>>;
};

export const caseIdFor = (sequence: number): string => `CASE-${String(sequence).padStart(4, '0')}`;

export const summarizePeers = (rows: readonly Readonly<Record<string, unknown>>[]): PeerSummary => ({
  accountsWithBandActivity: rows.length,
  singleBranchAccounts: rows.filter((row) => Number(row.branches) === 1).length,
});

export const findLinks = (options: {
  readonly accountId: string;
  readonly transactions: readonly Transaction[];
  readonly maxSharers: number;
}): { readonly accounts: readonly string[]; readonly counterparties: readonly string[] } => {
  const outgoing = options.transactions.filter((txn) => txn.txnType === 'wire_out');
  const sharersByCounterparty = outgoing.reduce(
    (map, txn) => new Map([...map, [txn.counterpartyId, new Set([...(map.get(txn.counterpartyId) ?? []), txn.accountId])]]),
    new Map<string, ReadonlySet<string>>(),
  );
  const shared = [...sharersByCounterparty.entries()].filter(
    ([, sharers]) => sharers.has(options.accountId) && sharers.size > 1 && sharers.size <= options.maxSharers,
  );
  return {
    counterparties: shared.map(([counterparty]) => counterparty).sort(),
    accounts: [...new Set(shared.flatMap(([, sharers]) => [...sharers]))]
      .filter((id) => id !== options.accountId)
      .sort(),
  };
};

export const pickCaseAlert = (options: {
  readonly alerts: readonly Alert[];
  readonly preferred: PatternKind;
  readonly excludeAccounts: readonly string[];
}): Alert | undefined => {
  const open = options.alerts.filter((alert) => !options.excludeAccounts.includes(alert.accountId));
  const ranked = [...open].sort(
    (a, b) =>
      Number(b.ruleId === options.preferred) - Number(a.ruleId === options.preferred) ||
      b.score - a.score ||
      b.raisedAtMs - a.raisedAtMs ||
      a.accountId.localeCompare(b.accountId),
  );
  return ranked[0];
};

export const buildWorkingSet = (options: {
  readonly caseId: string;
  readonly alert: Alert;
  readonly account: Account;
  readonly windowTransactions: readonly Transaction[];
  readonly recallHits: readonly RecallHit[];
  readonly peers: PeerSummary;
  readonly facts: Readonly<Record<string, string>>;
}): CaseWorkingSet => {
  const { alert, account } = options;
  const flagged = options.windowTransactions.filter(
    (txn) => txn.accountId === account.accountId && alert.txnIds.includes(txn.txnId),
  );
  const links = findLinks({ accountId: account.accountId, transactions: options.windowTransactions, maxSharers: 6 });
  return {
    caseId: options.caseId,
    pattern: alert.ruleId,
    ruleVersion: alert.ruleVersion,
    accountId: account.accountId,
    holderName: account.holderName,
    accountKind: account.kind,
    alertScore: alert.score,
    flaggedTxnCount: flagged.length,
    flaggedTotalCents: flagged.reduce((sum, txn) => sum + txn.amountCents, 0),
    distinctBranches: new Set(flagged.map((txn) => txn.branchCode)).size,
    linkedAccounts: links.accounts,
    sharedCounterparties: links.counterparties,
    priorCases: options.recallHits.map((hit) => ({
      caseId: hit.caseId,
      pattern: hit.pattern,
      outcome: hit.outcome,
      rrfScore: hit.rrfScore,
    })),
    peers: options.peers,
    facts: options.facts,
  };
};

const listOrNone = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join(', '));

export const renderNotes = (workingSet: CaseWorkingSet): string =>
  [
    `# ${workingSet.caseId} investigation notes`,
    '',
    `Account: ${workingSet.accountId} (${workingSet.holderName}, ${workingSet.accountKind})`,
    `Rule: ${workingSet.pattern} ${workingSet.ruleVersion}, score ${workingSet.alertScore}`,
    `Flagged transactions: ${workingSet.flaggedTxnCount}, total ${formatCents(workingSet.flaggedTotalCents)}`,
    `Distinct branches in flagged activity: ${workingSet.distinctBranches}`,
    `Linked accounts via shared counterparty: ${listOrNone(workingSet.linkedAccounts)}`,
    `Shared counterparties: ${listOrNone(workingSet.sharedCounterparties)}`,
    `History peers with similar activity: ${workingSet.peers.accountsWithBandActivity}, of which single branch: ${workingSet.peers.singleBranchAccounts}`,
    '',
    '## Similar past cases',
    ...(workingSet.priorCases.length === 0
      ? ['none recalled']
      : workingSet.priorCases.map(
          (prior) => `- ${prior.caseId} (${prior.pattern}, ${prior.outcome}), fused score ${prior.rrfScore.toFixed(4)}`,
        )),
    '',
  ].join('\n');

export const renderDraftReport = (workingSet: CaseWorkingSet): string =>
  [
    `# DRAFT for analyst review: ${workingSet.caseId}`,
    '',
    'Status: draft. Nothing has been filed. A human analyst decides what happens next.',
    '',
    `Subject account ${workingSet.accountId} triggered the ${workingSet.pattern} rule (${workingSet.ruleVersion}).`,
    `The flagged activity covers ${workingSet.flaggedTxnCount} transactions totalling ${formatCents(workingSet.flaggedTotalCents)} across ${workingSet.distinctBranches} branches.`,
    `Accounts sharing an outgoing counterparty: ${listOrNone(workingSet.linkedAccounts)}.`,
    '',
    'This is synthetic data from a demonstration. It makes no compliance or legal determination.',
    '',
  ].join('\n');
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/workingSet.test.ts
```

Expected PASS: 11 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/format.ts demos/agent-aml/runner/src/workingSet.ts demos/agent-aml/runner/test/workingSet.test.ts
git commit -m "agent-aml demo: case working set and renderers"
```

### Task 12: Skill lint and distiller with the structuring seed skill

- [ ] Not started

The seed skill file is a fixture. The distiller is deterministic and idempotent: running it twice with the same evidence changes nothing, and new numbers refresh the same bullet in place.

`demos/agent-aml/fixtures/skills/structuring-triage.md`:

```markdown
# Skill: structuring-triage
Version: 1

## Purpose

Triage an alert raised by the structuring rule: repeated cash deposits just under the reporting threshold.

## When to use

The alert rule id is structuring.

## Steps

1. Load the case working set and read the flagged transactions.
2. Count the deposits in the band and the distinct branches they touch.
3. Recall similar past cases and read their outcomes.
4. Check history peers with the same activity before escalating.
5. Draft notes for the analyst. Never file anything.

## Learned

- No lessons recorded yet.
```

`demos/agent-aml/runner/test/skills.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baselineRules, candidateStructuring } from '../src/rules';
import { describeRuleChange, distillSkill, lintSkill, type SkillEvidence } from '../src/skills';

const skillPath = fileURLToPath(new URL('../../fixtures/skills/structuring-triage.md', import.meta.url));
const seedSkill = readFileSync(skillPath, 'utf8');

const evidence: SkillEvidence = {
  ruleId: 'structuring',
  baselineVersion: 'v1',
  candidateVersion: 'v2',
  changeSummary: 'minDistinctBranches 1 -> 2',
  baselineAlerts: 55,
  candidateAlerts: 3,
  baselinePrecision: 3 / 55,
  candidatePrecision: 1,
  candidateRecall: 1,
};

describe('describeRuleChange', () => {
  it('lists only the parameters that differ', () => {
    const baseline = baselineRules(1_000_000)[0];
    const candidate = candidateStructuring(1_000_000);
    if (baseline?.ruleId !== 'structuring' || candidate.ruleId !== 'structuring') throw new Error('unexpected rule');
    expect(describeRuleChange(baseline.params, candidate.params)).toBe('minDistinctBranches 1 -> 2');
  });
});

describe('lintSkill', () => {
  it('accepts the seed skill fixture', () => {
    expect(lintSkill(seedSkill)).toEqual([]);
  });

  it('reports a missing section and a badly numbered step', () => {
    const broken = seedSkill.replace('## Learned', '## Notes').replace('2. Count', '7. Count');
    expect(lintSkill(broken)).toEqual(['missing section: Learned', 'step 2 must be numbered consecutively']);
  });

  it('reports a missing version line', () => {
    expect(lintSkill(seedSkill.replace('Version: 1', 'Rev 1'))).toContain('second line must be "Version: <integer>"');
  });
});

describe('distillSkill', () => {
  const distilled = distillSkill({ skillText: seedSkill, evidence });

  it('adds a numbered step and a learned bullet, drops the placeholder and bumps the version', () => {
    expect(distilled.changed).toBe(true);
    expect(distilled.text).toContain('Version: 2');
    expect(distilled.text).toContain(
      '6. Apply structuring v2 (minDistinctBranches 1 -> 2) before escalating, because it cut alert volume while planted recall held.',
    );
    expect(distilled.text).toContain(
      '- structuring v2 (minDistinctBranches 1 -> 2): alerts 55 -> 3, precision 5.5% -> 100.0% on simulated analyst verdicts, planted recall 100.0%.',
    );
    expect(distilled.text).not.toContain('No lessons recorded yet');
  });

  it('produces a skill that passes lint', () => {
    expect(distilled.lintErrors).toEqual([]);
  });

  it('is idempotent: distilling the same evidence again changes nothing', () => {
    const again = distillSkill({ skillText: distilled.text, evidence });
    expect(again.changed).toBe(false);
    expect(again.text).toBe(distilled.text);
  });

  it('refreshes the bullet in place when the evidence numbers change', () => {
    const refreshed = distillSkill({ skillText: distilled.text, evidence: { ...evidence, candidateAlerts: 4 } });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.text.match(/- structuring v2 \(/g)).toHaveLength(1);
    expect(refreshed.text).toContain('alerts 55 -> 4');
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/skills.test.ts
```

Expected FAIL: `Cannot find module '../src/skills'`.

`demos/agent-aml/runner/src/skills.ts`:

```typescript
import type { PatternKind } from './domain';
import { percentText } from './format';
import type { StructuringParams } from './rules';

export type SkillEvidence = {
  readonly ruleId: PatternKind;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly changeSummary: string;
  readonly baselineAlerts: number;
  readonly candidateAlerts: number;
  readonly baselinePrecision: number | undefined;
  readonly candidatePrecision: number | undefined;
  readonly candidateRecall: number | undefined;
};

export type DistilledSkill = {
  readonly text: string;
  readonly changed: boolean;
  readonly lintErrors: readonly string[];
};

const requiredSections: readonly string[] = ['Purpose', 'When to use', 'Steps', 'Learned'];

const structuringKeys: readonly (keyof StructuringParams)[] = [
  'thresholdCents',
  'bandPct',
  'windowDays',
  'minDeposits',
  'minDistinctBranches',
];

const PLACEHOLDER = '- No lessons recorded yet.';

export const describeRuleChange = (baseline: StructuringParams, candidate: StructuringParams): string => {
  const changes = structuringKeys
    .filter((key) => baseline[key] !== candidate[key])
    .map((key) => `${key} ${baseline[key]} -> ${candidate[key]}`);
  return changes.length === 0 ? 'no parameter change' : changes.join(', ');
};

const sectionRange = (lines: readonly string[], name: string): { start: number; end: number } | undefined => {
  const start = lines.findIndex((line) => line === `## ${name}`);
  if (start === -1) return undefined;
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return { start, end: next === -1 ? lines.length : next };
};

const sectionBody = (lines: readonly string[], name: string): readonly string[] => {
  const range = sectionRange(lines, name);
  if (range === undefined) return [];
  return lines.slice(range.start + 1, range.end).filter((line) => line.trim() !== '');
};

export const lintSkill = (text: string): readonly string[] => {
  const lines = text.split('\n');
  const errors: string[] = [];
  if (!/^# Skill: [a-z0-9]+(?:-[a-z0-9]+)*$/.test(lines[0] ?? '')) errors.push('first line must be "# Skill: <kebab-name>"');
  if (!/^Version: \d+$/.test(lines[1] ?? '')) errors.push('second line must be "Version: <integer>"');
  requiredSections.forEach((name) => {
    if (sectionRange(lines, name) === undefined) errors.push(`missing section: ${name}`);
  });
  const steps = sectionBody(lines, 'Steps');
  steps.forEach((line, index) => {
    if (!line.startsWith(`${index + 1}. `)) errors.push(`step ${index + 1} must be numbered consecutively`);
  });
  if (steps.length === 0 && sectionRange(lines, 'Steps') !== undefined) errors.push('Steps must not be empty');
  const learned = sectionBody(lines, 'Learned');
  learned.forEach((line) => {
    if (!line.startsWith('- ')) errors.push('Learned entries must be bullets');
  });
  if (learned.length === 0 && sectionRange(lines, 'Learned') !== undefined) errors.push('Learned must not be empty');
  return errors;
};

const learnedBullet = (evidence: SkillEvidence): string =>
  `- ${evidence.ruleId} ${evidence.candidateVersion} (${evidence.changeSummary}): alerts ${evidence.baselineAlerts} -> ${evidence.candidateAlerts}, precision ${percentText(evidence.baselinePrecision)} -> ${percentText(evidence.candidatePrecision)} on simulated analyst verdicts, planted recall ${percentText(evidence.candidateRecall)}.`;

const stepText = (evidence: SkillEvidence): string =>
  `Apply ${evidence.ruleId} ${evidence.candidateVersion} (${evidence.changeSummary}) before escalating, because it cut alert volume while planted recall held.`;

const replaceSection = (lines: readonly string[], name: string, body: readonly string[]): readonly string[] => {
  const range = sectionRange(lines, name);
  if (range === undefined) return lines;
  return [...lines.slice(0, range.start + 1), '', ...body, '', ...lines.slice(range.end)];
};

const bumpVersion = (lines: readonly string[]): readonly string[] =>
  lines.map((line) => {
    const match = /^Version: (\d+)$/.exec(line);
    return match === null ? line : `Version: ${Number(match[1]) + 1}`;
  });

export const distillSkill = (options: { readonly skillText: string; readonly evidence: SkillEvidence }): DistilledSkill => {
  const { skillText, evidence } = options;
  const lines = skillText.replace(/\n+$/, '').split('\n');
  const bulletPrefix = `- ${evidence.ruleId} ${evidence.candidateVersion} (`;
  const learned = sectionBody(lines, 'Learned')
    .filter((line) => line !== PLACEHOLDER)
    .filter((line) => !line.startsWith(bulletPrefix));
  const steps = sectionBody(lines, 'Steps');
  const hasStep = steps.some((line) => line.includes(`Apply ${evidence.ruleId} ${evidence.candidateVersion} (`));
  const nextSteps = hasStep
    ? steps.map((line, index) =>
        line.includes(`Apply ${evidence.ruleId} ${evidence.candidateVersion} (`)
          ? `${index + 1}. ${stepText(evidence)}`
          : line,
      )
    : [...steps, `${steps.length + 1}. ${stepText(evidence)}`];
  const withSteps = replaceSection(lines, 'Steps', nextSteps);
  const withLearned = replaceSection(withSteps, 'Learned', [...learned, learnedBullet(evidence)]);
  const render = (rendered: readonly string[]): string => `${rendered.join('\n').replace(/\n+$/, '')}\n`;
  const candidateText = render(withLearned);
  const changed = candidateText !== render(lines);
  const text = changed ? render(bumpVersion(withLearned)) : candidateText;
  return { text, changed, lintErrors: lintSkill(text) };
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/skills.test.ts
```

Expected PASS: 8 passed.

Commit:

```bash
git add demos/agent-aml/fixtures/skills/structuring-triage.md demos/agent-aml/runner/src/skills.ts demos/agent-aml/runner/test/skills.test.ts
git commit -m "agent-aml demo: skill lint and distiller"
```

### Task 13: Lesson composer and journal and path helpers

- [ ] Not started

`demos/agent-aml/runner/test/lessonAndJournal.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { formatCents, percentText } from '../src/format';
import {
  agentIdFor,
  branchNameFor,
  casePathFor,
  journalEntry,
  journalIdFor,
  layerNameFor,
} from '../src/journal';
import { composeLesson } from '../src/lesson';
import type { WhatIfResult } from '../src/whatIf';

const whatIf: WhatIfResult = {
  ruleId: 'structuring',
  baselineVersion: 'v1',
  candidateVersion: 'v2',
  baselineAlerts: 55,
  candidateAlerts: 3,
  alertDelta: -52,
  removedAccounts: [],
  addedAccounts: [],
  baseline: {
    ruleId: 'structuring',
    ruleVersion: 'v1',
    alerts: 55,
    truePositives: 3,
    falsePositives: 52,
    plantedAccounts: 3,
    flaggedPlanted: 3,
    precision: 3 / 55,
    recall: 1,
    falsePositivesPer1000: 5.1,
  },
  candidate: {
    ruleId: 'structuring',
    ruleVersion: 'v2',
    alerts: 3,
    truePositives: 3,
    falsePositives: 0,
    plantedAccounts: 3,
    flaggedPlanted: 3,
    precision: 1,
    recall: 1,
    falsePositivesPer1000: 0,
  },
  decision: 'adopt',
  reason: 'candidate keeps planted recall and raises fewer alerts',
};

describe('composeLesson', () => {
  const lesson = composeLesson({
    caseId: 'CASE-0001',
    pattern: 'structuring',
    whatIf,
    changeSummary: 'minDistinctBranches 1 -> 2',
  });

  it('records the numbers behind the lesson and says the verdicts were simulated', () => {
    expect(lesson.outcome).toBe('lesson');
    expect(lesson.summary).toContain('structuring v1 raised 55 alerts and 52 were false positives');
    expect(lesson.summary).toContain('structuring v2 (minDistinctBranches 1 -> 2) raised 3 alerts with planted recall 100.0%');
    expect(lesson.summary).toContain('Analyst verdicts were simulated from ground truth.');
  });

  it('uses the same words past structuring summaries use, so hybrid recall can find it', () => {
    expect(lesson.summary).toContain('repeated cash deposits just under the reporting threshold');
  });
});

describe('journal helpers', () => {
  it('derives stable names from the case id', () => {
    expect(casePathFor('CASE-0001')).toBe('/harbor/cases/CASE-0001');
    expect(layerNameFor('CASE-0001')).toBe('case-case-0001');
    expect(journalIdFor('CASE-0001')).toBe('jrn-case-0001');
    expect(branchNameFor('CASE-0001')).toBe('aml-case-0001');
    expect(agentIdFor('CASE-0001')).toBe('aml-agent-case-0001');
  });

  it('builds an entry with a retry-safe idempotency key', () => {
    expect(journalEntry({ caseId: 'CASE-0001', type: 'case.opened', summary: 'layer and branch ready' })).toEqual({
      type: 'case.opened',
      subjects: ['case:CASE-0001'],
      summary: 'layer and branch ready',
      idempotencyKey: 'CASE-0001:case.opened',
    });
  });

  it('rejects an entry type the journal would refuse', () => {
    expect(() => journalEntry({ caseId: 'CASE-0001', type: 'Case Opened', summary: 'x' })).toThrow(
      'invalid journal entry type',
    );
  });
});

describe('format', () => {
  it('formats cents as dollars with thousands separators', () => {
    expect(formatCents(2_850_000)).toBe('$28,500.00');
    expect(formatCents(5)).toBe('$0.05');
  });

  it('formats a missing ratio as n/a', () => {
    expect(percentText(undefined)).toBe('n/a');
    expect(percentText(0.055)).toBe('5.5%');
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/lessonAndJournal.test.ts
```

Expected FAIL: `Cannot find module '../src/journal'`.

`demos/agent-aml/runner/src/journal.ts`:

```typescript
export type JournalEntry = {
  readonly type: string;
  readonly subjects: readonly string[];
  readonly summary: string;
  readonly idempotencyKey: string;
};

const entryTypePattern = /^[a-z][a-z0-9_.-]*$/;

export const FILE_SYSTEM_ROOT = '/harbor';

export const casePathFor = (caseId: string): string => `${FILE_SYSTEM_ROOT}/cases/${caseId}`;

export const skillsPath = `${FILE_SYSTEM_ROOT}/skills`;

export const layerNameFor = (caseId: string): string => `case-${caseId.toLowerCase()}`;

export const journalIdFor = (caseId: string): string => `jrn-${caseId.toLowerCase()}`;

export const branchNameFor = (caseId: string): string => `aml-${caseId.toLowerCase()}`;

export const agentIdFor = (caseId: string): string => `aml-agent-${caseId.toLowerCase()}`;

export const journalEntry = (options: {
  readonly caseId: string;
  readonly type: string;
  readonly summary: string;
}): JournalEntry => {
  if (!entryTypePattern.test(options.type)) throw new Error(`invalid journal entry type: ${options.type}`);
  return {
    type: options.type,
    subjects: [`case:${options.caseId}`],
    summary: options.summary,
    idempotencyKey: `${options.caseId}:${options.type}`,
  };
};
```

`demos/agent-aml/runner/src/lesson.ts`:

```typescript
import type { PatternKind } from './domain';
import { percentText } from './format';
import { patternPhrases } from './recallSql';
import type { WhatIfResult } from './whatIf';

export type Lesson = {
  readonly caseId: string;
  readonly pattern: PatternKind;
  readonly outcome: 'lesson';
  readonly summary: string;
};

export const composeLesson = (options: {
  readonly caseId: string;
  readonly pattern: PatternKind;
  readonly whatIf: WhatIfResult;
  readonly changeSummary: string;
}): Lesson => {
  const { whatIf } = options;
  const summary = [
    `Lesson from ${options.caseId} (${options.pattern}): ${patternPhrases[options.pattern]}.`,
    `${whatIf.ruleId} ${whatIf.baselineVersion} raised ${whatIf.baselineAlerts} alerts and ${whatIf.baseline.falsePositives} were false positives against planted ground truth.`,
    `${whatIf.ruleId} ${whatIf.candidateVersion} (${options.changeSummary}) raised ${whatIf.candidateAlerts} alerts with planted recall ${percentText(whatIf.candidate.recall)}.`,
    'Analyst verdicts were simulated from ground truth. Synthetic data.',
  ].join(' ');
  return { caseId: options.caseId, pattern: options.pattern, outcome: 'lesson', summary };
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/lessonAndJournal.test.ts
```

Expected PASS: 7 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/journal.ts demos/agent-aml/runner/src/lesson.ts demos/agent-aml/runner/test/lessonAndJournal.test.ts
git commit -m "agent-aml demo: lesson composer and journal helpers"
```

### Task 14: Lake SQL builders and parsers

- [ ] Not started

Setup SQL, the minute load task (one `BEGIN ... END;` body with four `COPY INTO` statements), lookback queries over a months-wide range, and the evaluation queries. Account ids, rule versions and integers are validated before they reach SQL text.

`demos/agent-aml/runner/test/lakeSql.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildAccountLookbackSql,
  buildBandPeersSql,
  buildLakeSetupStatements,
  buildPlantedRecallSql,
  countHistoryUpTo,
  executeLoadTask,
  lookbackMonthsToMs,
  parsePlantedRecall,
  parseRuleEval,
  resetLakeStatements,
  teardownStatements,
} from '../src/lakeSql';

const setup = buildLakeSetupStatements({
  bucket: 'harbor-lab-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: "se'cret",
  warehouse: 'harbor_wh',
});

describe('buildLakeSetupStatements', () => {
  it('creates the database and four tables before any load object', () => {
    expect(setup[0]).toBe('CREATE DATABASE IF NOT EXISTS harbor');
    expect(setup.slice(1, 5).map((sql) => sql.match(/harbor\.(\w+)/)?.[1])).toEqual([
      'txn_history',
      'ground_truth',
      'flag_log',
      'run_events',
    ]);
  });

  it('escapes credentials and points the stage at the lake prefix', () => {
    const connection = setup.find((sql) => sql.startsWith('CREATE CONNECTION'));
    expect(connection).toContain("SECRET_ACCESS_KEY = 'se''cret'");
    expect(setup.find((sql) => sql.startsWith('CREATE STAGE'))).toContain("URL = 's3://harbor-lab-bucket/lake/'");
  });

  it('loads Parquet transactions and NDJSON events in one minute task, then resumes it', () => {
    const task = setup.find((sql) => sql.startsWith('CREATE TASK')) ?? '';
    expect(task).toContain("WAREHOUSE = 'harbor_wh' SCHEDULE = 1 MINUTE");
    expect(task).toContain("COPY INTO harbor.txn_history FROM @harbor_lake/export/transactions/ PATTERN = '.*[.]parquet' FILE_FORMAT = (TYPE = PARQUET);");
    expect(task).toContain("COPY INTO harbor.flag_log FROM @harbor_lake/events/flags/ PATTERN = '.*[.]ndjson' FILE_FORMAT = (TYPE = NDJSON);");
    expect(setup.at(-1)).toBe('ALTER TASK harbor_load RESUME');
    expect(executeLoadTask).toBe('EXECUTE TASK harbor_load');
  });
});

describe('resetLakeStatements', () => {
  it('truncates the four history tables so a re-record does not double count', () => {
    expect(resetLakeStatements.map((sql) => sql.replace('TRUNCATE TABLE harbor.', ''))).toEqual([
      'txn_history',
      'ground_truth',
      'flag_log',
      'run_events',
    ]);
  });
});

describe('teardownStatements', () => {
  it('suspends and drops the task before dropping what it reads from', () => {
    expect(teardownStatements[0]).toBe('ALTER TASK harbor_load SUSPEND');
    expect(teardownStatements.at(-1)).toBe('DROP DATABASE IF EXISTS harbor');
  });
});

describe('lookback builders', () => {
  it('counts history up to a transaction id cutoff', () => {
    expect(countHistoryUpTo(9000)).toBe('SELECT COUNT(*) AS n FROM harbor.txn_history WHERE txn_id <= 9000');
  });

  it('builds the band peers query over a months-wide range', () => {
    const until = Date.UTC(2026, 3, 1);
    const sql = buildBandPeersSql({
      lowerCents: 900_000,
      upperCents: 1_000_000,
      sinceMs: until - lookbackMonthsToMs(3),
      untilMs: until,
      minDeposits: 3,
    });
    expect(sql).toContain("txn_ts >= '2026-01-01 00:00:00'");
    expect(sql).toContain("txn_ts < '2026-04-01 00:00:00'");
    expect(sql).toContain('HAVING COUNT(*) >= 3');
  });

  it('refuses an account id that is not in the expected shape', () => {
    expect(() => buildAccountLookbackSql({ accountId: "ACC-0001' OR 1=1", sinceMs: 0, untilMs: 1 })).toThrow(
      'not an account id',
    );
  });

  it('refuses a non-integer month count', () => {
    expect(() => lookbackMonthsToMs(1.5)).toThrow('months must be a safe integer');
  });

  it('builds the planted recall query for one rule version only', () => {
    expect(buildPlantedRecallSql('v2')).toContain("f.rule_version = 'v2'");
    expect(() => buildPlantedRecallSql("v2' OR '1'='1")).toThrow('not a rule version');
  });
});

describe('result parsers', () => {
  it('derives precision from confirmed over flags', () => {
    expect(
      parseRuleEval([{ rule_id: 'structuring', rule_version: 'v1', scope: 'production', flags: '50', confirmed: '3', false_positives: '47' }]),
    ).toEqual([
      { ruleId: 'structuring', ruleVersion: 'v1', scope: 'production', flags: 50, confirmed: 3, falsePositives: 47, precision: 0.06 },
    ]);
  });

  it('derives recall from flagged over planted', () => {
    expect(parsePlantedRecall([{ pattern: 'structuring', planted: 3, flagged: 3 }])).toEqual([
      { pattern: 'structuring', planted: 3, flagged: 3, recall: 1 },
    ]);
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/lakeSql.test.ts
```

Expected FAIL: `Cannot find module '../src/lakeSql'`.

`demos/agent-aml/runner/src/lakeSql.ts`:

```typescript
import { assertAccountId, assertSafeInteger, sqlStringLiteral } from './sqlLiteral';
import { formatDateTime } from './time';

export type LakeSetupOptions = {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly warehouse: string;
};

export const LAKE_DATABASE = 'harbor';
export const LOAD_TASK = 'harbor_load';
export const executeLoadTask = `EXECUTE TASK ${LOAD_TASK}`;

const tableStatements: readonly string[] = [
  `CREATE DATABASE IF NOT EXISTS ${LAKE_DATABASE}`,
  `CREATE TABLE IF NOT EXISTS ${LAKE_DATABASE}.txn_history (
    txn_id BIGINT, account_id STRING, counterparty_id STRING, txn_type STRING,
    amount_cents BIGINT, txn_ts TIMESTAMP, branch_code STRING, memo STRING
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAKE_DATABASE}.ground_truth (
    account_id STRING, pattern STRING, injected_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAKE_DATABASE}.flag_log (
    flag_id STRING, rule_id STRING, rule_version STRING, account_id STRING,
    scope STRING, verdict STRING, simulated INT, raised_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAKE_DATABASE}.run_events (
    run_id STRING, seq BIGINT, kind STRING, case_id STRING, detail STRING, emitted_at TIMESTAMP
  )`,
];

const copyStatement = (table: string, path: string, format: 'PARQUET' | 'NDJSON'): string => {
  const extension = format === 'PARQUET' ? 'parquet' : 'ndjson';
  return `COPY INTO ${LAKE_DATABASE}.${table} FROM @harbor_lake/${path} PATTERN = '.*[.]${extension}' FILE_FORMAT = (TYPE = ${format})`;
};

export const loadTaskBody = [
  copyStatement('txn_history', 'export/transactions/', 'PARQUET'),
  copyStatement('ground_truth', 'events/truth/', 'NDJSON'),
  copyStatement('flag_log', 'events/flags/', 'NDJSON'),
  copyStatement('run_events', 'events/run/', 'NDJSON'),
]
  .map((statement) => `${statement};`)
  .join('\n  ');

export const buildLakeSetupStatements = (options: LakeSetupOptions): readonly string[] => [
  ...tableStatements,
  `CREATE CONNECTION IF NOT EXISTS harbor_s3 STORAGE_TYPE = 's3' ACCESS_KEY_ID = ${sqlStringLiteral(options.accessKeyId)} SECRET_ACCESS_KEY = ${sqlStringLiteral(options.secretAccessKey)} REGION = ${sqlStringLiteral(options.region)}`,
  `CREATE STAGE IF NOT EXISTS harbor_lake URL = ${sqlStringLiteral(`s3://${options.bucket}/lake/`)} CONNECTION = (CONNECTION_NAME = 'harbor_s3')`,
  `CREATE TASK IF NOT EXISTS ${LOAD_TASK} WAREHOUSE = ${sqlStringLiteral(options.warehouse)} SCHEDULE = 1 MINUTE AS\nBEGIN\n  ${loadTaskBody}\nEND;`,
  `ALTER TASK ${LOAD_TASK} RESUME`,
];

export const resetLakeStatements: readonly string[] = [
  `TRUNCATE TABLE ${LAKE_DATABASE}.txn_history`,
  `TRUNCATE TABLE ${LAKE_DATABASE}.ground_truth`,
  `TRUNCATE TABLE ${LAKE_DATABASE}.flag_log`,
  `TRUNCATE TABLE ${LAKE_DATABASE}.run_events`,
];

export const teardownStatements: readonly string[] = [
  `ALTER TASK ${LOAD_TASK} SUSPEND`,
  `DROP TASK IF EXISTS ${LOAD_TASK}`,
  'DROP STAGE IF EXISTS harbor_lake',
  'DROP CONNECTION IF EXISTS harbor_s3',
  `DROP DATABASE IF EXISTS ${LAKE_DATABASE}`,
];

export const countHistoryUpTo = (txnId: number): string =>
  `SELECT COUNT(*) AS n FROM ${LAKE_DATABASE}.txn_history WHERE txn_id <= ${assertSafeInteger('txnId', txnId)}`;

export const buildBandPeersSql = (options: {
  readonly lowerCents: number;
  readonly upperCents: number;
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly minDeposits: number;
}): string =>
  `SELECT account_id, COUNT(*) AS deposits, COUNT(DISTINCT branch_code) AS branches, SUM(amount_cents) AS total_cents
FROM ${LAKE_DATABASE}.txn_history
WHERE txn_type = 'cash_deposit'
  AND amount_cents >= ${assertSafeInteger('lowerCents', options.lowerCents)}
  AND amount_cents < ${assertSafeInteger('upperCents', options.upperCents)}
  AND txn_ts >= '${formatDateTime(options.sinceMs)}'
  AND txn_ts < '${formatDateTime(options.untilMs)}'
GROUP BY account_id
HAVING COUNT(*) >= ${assertSafeInteger('minDeposits', options.minDeposits)}
ORDER BY deposits DESC, account_id
LIMIT 50`;

export const buildAccountLookbackSql = (options: {
  readonly accountId: string;
  readonly sinceMs: number;
  readonly untilMs: number;
}): string =>
  `SELECT txn_type, COUNT(*) AS txns, SUM(amount_cents) AS total_cents, COUNT(DISTINCT counterparty_id) AS counterparties, COUNT(DISTINCT branch_code) AS branches, MIN(txn_ts) AS first_seen, MAX(txn_ts) AS last_seen
FROM ${LAKE_DATABASE}.txn_history
WHERE account_id = '${assertAccountId(options.accountId)}'
  AND txn_ts >= '${formatDateTime(options.sinceMs)}'
  AND txn_ts < '${formatDateTime(options.untilMs)}'
GROUP BY txn_type
ORDER BY txn_type`;

export const lookbackMonthsToMs = (months: number): number => assertSafeInteger('months', months) * 30 * 86_400_000;

export const ruleEvalSql =
  `SELECT rule_id, rule_version, scope, COUNT(*) AS flags,
  SUM(CASE WHEN verdict = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
  SUM(CASE WHEN verdict = 'false-positive' THEN 1 ELSE 0 END) AS false_positives
FROM ${LAKE_DATABASE}.flag_log
GROUP BY rule_id, rule_version, scope
ORDER BY rule_id, rule_version, scope`;

export const buildPlantedRecallSql = (ruleVersion: string): string => {
  if (!/^v\d+$/.test(ruleVersion)) throw new Error(`not a rule version: ${ruleVersion}`);
  return `SELECT g.pattern, COUNT(DISTINCT g.account_id) AS planted, COUNT(DISTINCT f.account_id) AS flagged
FROM ${LAKE_DATABASE}.ground_truth g
LEFT JOIN ${LAKE_DATABASE}.flag_log f
  ON f.account_id = g.account_id AND f.rule_id = g.pattern AND f.rule_version = '${ruleVersion}'
GROUP BY g.pattern
ORDER BY g.pattern`;
};

export type LakeRuleEval = {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly scope: string;
  readonly flags: number;
  readonly confirmed: number;
  readonly falsePositives: number;
  readonly precision: number | undefined;
};

export const parseRuleEval = (rows: readonly Readonly<Record<string, unknown>>[]): readonly LakeRuleEval[] =>
  rows.map((row) => {
    const flags = Number(row.flags);
    const confirmed = Number(row.confirmed);
    return {
      ruleId: String(row.rule_id),
      ruleVersion: String(row.rule_version),
      scope: String(row.scope),
      flags,
      confirmed,
      falsePositives: Number(row.false_positives),
      precision: flags === 0 ? undefined : confirmed / flags,
    };
  });

export type LakePlantedRecall = {
  readonly pattern: string;
  readonly planted: number;
  readonly flagged: number;
  readonly recall: number | undefined;
};

export const parsePlantedRecall = (rows: readonly Readonly<Record<string, unknown>>[]): readonly LakePlantedRecall[] =>
  rows.map((row) => {
    const planted = Number(row.planted);
    const flagged = Number(row.flagged);
    return { pattern: String(row.pattern), planted, flagged, recall: planted === 0 ? undefined : flagged / planted };
  });
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/lakeSql.test.ts
```

Expected PASS: 12 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/lakeSql.ts demos/agent-aml/runner/test/lakeSql.test.ts
git commit -m "agent-aml demo: Lake SQL builders"
```

### Task 15: Export arguments, sink rows, branch timestamp and tick math

- [ ] Not started

`demos/agent-aml/runner/test/exportAndSink.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { Alert } from '../src/domain';
import { pointInTimeMs } from '../src/branchPlan';
import { buildExportArgs, buildExportWhere, exportUri, redactArgs } from '../src/exportPlan';
import { flagRow, runEventRow, truthRow } from '../src/sinkRows';
import { alertsPerMinute, elapsedSeconds } from '../src/tickMath';

describe('export plan', () => {
  it('puts each export batch under its own prefix', () => {
    expect(exportUri({ bucket: 'b', batch: 2 })).toBe('s3://b/lake/export/transactions/batch-02/');
  });

  it('builds a bounded where clause for a second export', () => {
    expect(buildExportWhere({ afterTxnId: 12000, upToTxnId: 12900 })).toBe('txn_id > 12000 AND txn_id <= 12900');
    expect(buildExportWhere({})).toBeUndefined();
  });

  const args = buildExportArgs({
    clusterId: 'c1',
    database: 'harbor_core',
    table: 'transactions',
    s3Uri: 's3://b/lake/export/transactions/batch-01/',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'shh',
    afterTxnId: 0,
    upToTxnId: 10198,
  });

  it('exports one table as Parquet to S3 without prompting', () => {
    expect(args.slice(0, 3)).toEqual(['serverless', 'export', 'create']);
    expect(args).toContain('--filter');
    expect(args[args.indexOf('--filter') + 1]).toBe('harbor_core.transactions');
    expect(args[args.indexOf('--file-type') + 1]).toBe('PARQUET');
    expect(args[args.indexOf('--where') + 1]).toBe('txn_id > 0 AND txn_id <= 10198');
    expect(args.at(-1)).toBe('--force');
  });

  it('redacts the access key and secret before the arguments are logged', () => {
    const logged = redactArgs(args).join(' ');
    expect(logged).not.toContain('AKIAEXAMPLE');
    expect(logged).not.toContain('shh');
    expect(logged).toContain('--s3.access-key-id <redacted>');
  });
});

describe('pointInTimeMs', () => {
  it('branches one second after the commit when that is safely in the past', () => {
    expect(pointInTimeMs({ committedAtMs: 10_000, nowMs: 60_000 })).toBe(11_000);
  });

  it('never asks for a timestamp closer than two seconds to now', () => {
    expect(pointInTimeMs({ committedAtMs: 59_500, nowMs: 60_000 })).toBe(58_000);
  });
});

describe('tick math', () => {
  it('scales alerts per tick to alerts per minute', () => {
    expect(alertsPerMinute({ newAlerts: 3, tickWallMs: 2000 })).toBe(90);
    expect(alertsPerMinute({ newAlerts: 3, tickWallMs: 0 })).toBe(0);
  });

  it('reports elapsed seconds and clamps clock skew to zero', () => {
    expect(elapsedSeconds(1000, 3500)).toBe(2.5);
    expect(elapsedSeconds(3500, 1000)).toBe(0);
  });
});

describe('sink rows', () => {
  const alert: Alert = {
    ruleId: 'structuring',
    ruleVersion: 'v1',
    accountId: 'ACC-0001',
    windowStartMs: 0,
    windowEndMs: 0,
    raisedAtMs: Date.UTC(2026, 3, 1, 12, 30, 0),
    bucket: 2900,
    txnIds: [],
    score: 3,
  };

  it('labels every flag row as a simulated verdict with a scope', () => {
    expect(flagRow({ runId: 'r1', alert, scope: 'branch-shadow', verdict: 'confirmed' })).toEqual({
      flag_id: 'r1:branch-shadow:structuring:v1:ACC-0001:2900',
      rule_id: 'structuring',
      rule_version: 'v1',
      account_id: 'ACC-0001',
      scope: 'branch-shadow',
      verdict: 'confirmed',
      simulated: 1,
      raised_at: '2026-04-01 12:30:00',
    });
  });

  it('formats ground truth and run event rows with Lake-friendly timestamps', () => {
    expect(truthRow({ accountId: 'RNG-0001', pattern: 'structuring', injectedAtMs: Date.UTC(2026, 3, 1) })).toEqual({
      account_id: 'RNG-0001',
      pattern: 'structuring',
      injected_at: '2026-04-01 00:00:00',
    });
    expect(
      runEventRow({ runId: 'r1', seq: 4, kind: 'case.opened', caseId: 'CASE-0001', detail: 'ok', atMs: 0 }).emitted_at,
    ).toBe('1970-01-01 00:00:00');
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/exportAndSink.test.ts
```

Expected FAIL: `Cannot find module '../src/branchPlan'`.

`demos/agent-aml/runner/src/exportPlan.ts`:

```typescript
export type ExportOptions = {
  readonly clusterId: string;
  readonly database: string;
  readonly table: string;
  readonly s3Uri: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly afterTxnId?: number;
  readonly upToTxnId?: number;
};

export const exportUri = (options: { readonly bucket: string; readonly batch: number }): string =>
  `s3://${options.bucket}/lake/export/transactions/batch-${String(options.batch).padStart(2, '0')}/`;

export const buildExportWhere = (options: {
  readonly afterTxnId?: number;
  readonly upToTxnId?: number;
}): string | undefined => {
  const clauses = [
    options.afterTxnId === undefined ? undefined : `txn_id > ${Math.trunc(options.afterTxnId)}`,
    options.upToTxnId === undefined ? undefined : `txn_id <= ${Math.trunc(options.upToTxnId)}`,
  ].filter((clause): clause is string => clause !== undefined);
  return clauses.length === 0 ? undefined : clauses.join(' AND ');
};

export const buildExportArgs = (options: ExportOptions): readonly string[] => {
  const where = buildExportWhere(options);
  return [
    'serverless',
    'export',
    'create',
    '-c',
    options.clusterId,
    '--file-type',
    'PARQUET',
    '--target-type',
    'S3',
    '--s3.uri',
    options.s3Uri,
    '--s3.access-key-id',
    options.accessKeyId,
    '--s3.secret-access-key',
    options.secretAccessKey,
    '--filter',
    `${options.database}.${options.table}`,
    ...(where === undefined ? [] : ['--where', where]),
    '--force',
  ];
};

const secretFlags: ReadonlySet<string> = new Set(['--s3.access-key-id', '--s3.secret-access-key']);

export const redactArgs = (args: readonly string[]): readonly string[] =>
  args.map((arg, index) => (secretFlags.has(args[index - 1] ?? '') ? '<redacted>' : arg));
```

`demos/agent-aml/runner/src/sinkRows.ts`:

```typescript
import type { Alert, GroundTruthEntry } from './domain';
import { formatDateTime } from './time';
import type { Verdict } from './scorer';

export type FlagScope = 'production' | 'branch-shadow';

export type FlagRow = {
  readonly flag_id: string;
  readonly rule_id: string;
  readonly rule_version: string;
  readonly account_id: string;
  readonly scope: FlagScope;
  readonly verdict: Verdict;
  readonly simulated: 1;
  readonly raised_at: string;
};

export type TruthRow = {
  readonly account_id: string;
  readonly pattern: string;
  readonly injected_at: string;
};

export type RunEventRow = {
  readonly run_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly case_id: string;
  readonly detail: string;
  readonly emitted_at: string;
};

export const flagRow = (options: {
  readonly runId: string;
  readonly alert: Alert;
  readonly scope: FlagScope;
  readonly verdict: Verdict;
}): FlagRow => ({
  flag_id: `${options.runId}:${options.scope}:${options.alert.ruleId}:${options.alert.ruleVersion}:${options.alert.accountId}:${options.alert.bucket}`,
  rule_id: options.alert.ruleId,
  rule_version: options.alert.ruleVersion,
  account_id: options.alert.accountId,
  scope: options.scope,
  verdict: options.verdict,
  simulated: 1,
  raised_at: formatDateTime(options.alert.raisedAtMs),
});

export const truthRow = (entry: GroundTruthEntry): TruthRow => ({
  account_id: entry.accountId,
  pattern: entry.pattern,
  injected_at: formatDateTime(entry.injectedAtMs),
});

export const runEventRow = (options: {
  readonly runId: string;
  readonly seq: number;
  readonly kind: string;
  readonly caseId: string;
  readonly detail: string;
  readonly atMs: number;
}): RunEventRow => ({
  run_id: options.runId,
  seq: options.seq,
  kind: options.kind,
  case_id: options.caseId,
  detail: options.detail,
  emitted_at: formatDateTime(options.atMs),
});
```

`demos/agent-aml/runner/src/branchPlan.ts`:

```typescript
export const pointInTimeMs = (options: {
  readonly committedAtMs: number;
  readonly nowMs: number;
}): number => Math.min(options.committedAtMs + 1000, options.nowMs - 2000);
```

`demos/agent-aml/runner/src/tickMath.ts`:

```typescript
export const alertsPerMinute = (options: { readonly newAlerts: number; readonly tickWallMs: number }): number =>
  options.tickWallMs <= 0 ? 0 : (options.newAlerts * 60_000) / options.tickWallMs;

export const elapsedSeconds = (startMs: number, endMs: number): number => Math.max(endMs - startMs, 0) / 1000;
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/exportAndSink.test.ts
```

Expected PASS: 10 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/exportPlan.ts demos/agent-aml/runner/src/sinkRows.ts demos/agent-aml/runner/src/branchPlan.ts demos/agent-aml/runner/src/tickMath.ts demos/agent-aml/runner/test/exportAndSink.test.ts
git commit -m "agent-aml demo: export arguments, sink rows, branch time, tick math"
```

### Task 16: Environment config, serial queue, retry, export output parsing and the branch environment

- [ ] Not started

`demos/agent-aml/runner/test/configAndQueue.test.ts`, `retry.test.ts` and `branchEnv.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { exportState, parseExportId } from '../src/exportParse';
import { createSerialQueue } from '../src/queue';

const baseEnv = {
  AML_CLUSTER_ID: 'c-1',
  S3_BUCKET: 'harbor-lab-bucket',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'shh',
  LAKE_WAREHOUSE: 'harbor_wh',
};

describe('loadConfig', () => {
  it('applies defaults and reads the reporting threshold as a configurable constant', () => {
    const config = loadConfig(baseEnv);
    expect(config).toMatchObject({
      region: 'us-east-1',
      historyDays: 90,
      tickMs: 2000,
      thresholdCents: 1_000_000,
      reset: false,
      firstDayStartMs: Date.UTC(2026, 0, 5),
    });
  });

  it('lets the environment override the threshold and the seed', () => {
    const config = loadConfig({ ...baseEnv, AML_REPORTING_THRESHOLD_CENTS: '500000', AML_SEED: '7', AML_RESET: 'true' });
    expect(config).toMatchObject({ thresholdCents: 500_000, seed: 7, reset: true });
  });

  it('names the missing variable when a required one is absent', () => {
    expect(() => loadConfig({ ...baseEnv, S3_BUCKET: undefined })).toThrow('S3_BUCKET');
  });
});

describe('createSerialQueue', () => {
  it('runs tasks one at a time in submission order', async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    const slow = queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    const fast = queue.enqueue(async () => {
      order.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('keeps running later tasks after one fails, and still rejects the failed caller', async () => {
    const queue = createSerialQueue();
    const failed = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const later = queue.enqueue(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(later).resolves.toBe('ok');
  });
});

describe('export output parsing', () => {
  it('reads an export id from labelled text or JSON', () => {
    expect(parseExportId('Export ID: exp_8f3a21c0')).toBe('exp_8f3a21c0');
    expect(parseExportId('{"id":"exp-123abc","state":"RUNNING"}')).toBe('exp-123abc');
    expect(parseExportId('nothing useful')).toBeUndefined();
  });

  it('classifies export status text', () => {
    expect(exportState('state: RUNNING')).toBe('running');
    expect(exportState('state: SUCCEEDED')).toBe('done');
    expect(exportState('state: FAILED')).toBe('failed');
  });
});
```

```typescript
import { describe, expect, it } from 'vitest';
import { retryUntil } from '../src/retry';

const noPause = async (): Promise<void> => undefined;

describe('retryUntil', () => {
  it('returns the first defined result without pausing', async () => {
    const pauses: number[] = [];
    const result = await retryUntil({
      attempt: async () => 'ready',
      tries: 5,
      delayMs: 100,
      pause: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result).toBe('ready');
    expect(pauses).toEqual([]);
  });

  it('retries with the given delay until a result appears', async () => {
    const calls: number[] = [];
    const pauses: number[] = [];
    const result = await retryUntil({
      attempt: async () => {
        calls.push(calls.length + 1);
        return calls.length === 3 ? 'visible' : undefined;
      },
      tries: 5,
      delayMs: 250,
      pause: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result).toBe('visible');
    expect(pauses).toEqual([250, 250]);
  });

  it('gives up with undefined after the last try', async () => {
    const result = await retryUntil({ attempt: async () => undefined, tries: 3, delayMs: 1, pause: noPause });
    expect(result).toBeUndefined();
  });
});
```

```typescript
import { describe, expect, it } from 'vitest';
import { tidbConfigFromEnv } from '@lab/runner-kit';
import { branchEnv, branchUser } from '../src/branchEnv';

describe('branchUser', () => {
  it('prefixes a bare user name', () => {
    expect(branchUser({ userPrefix: '3pTAoNNegb47Uc8', user: 'reader' })).toBe('3pTAoNNegb47Uc8.reader');
  });

  it('swaps the instance prefix for the branch prefix on a prefixed user', () => {
    expect(branchUser({ userPrefix: 'branchpfx', user: 'instpfx.reader' })).toBe('branchpfx.reader');
  });

  it('keeps a user that already carries the branch prefix', () => {
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
    database: 'harbor_core',
  });

  it('points the standard TiDB variables at the branch with TLS on', () => {
    expect(env).toMatchObject({
      TIDB_HOST: 'branch-host',
      TIDB_PORT: '4000',
      TIDB_USER: 'p.reader',
      TIDB_PASSWORD: 'pw',
      TIDB_DATABASE: 'harbor_core',
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

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/configAndQueue.test.ts runner/test/retry.test.ts runner/test/branchEnv.test.ts
```

Expected FAIL: `Cannot find module '../src/config'`.

`demos/agent-aml/runner/src/config.ts`:

```typescript
import { z } from 'zod';
import { REPORTING_THRESHOLD_CENTS } from './domain';

const requiredText = z.string().min(1);

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  AML_CLUSTER_ID: requiredText,
  S3_BUCKET: requiredText,
  S3_REGION: requiredText.default('us-east-1'),
  AWS_ACCESS_KEY_ID: requiredText,
  AWS_SECRET_ACCESS_KEY: requiredText,
  LAKE_WAREHOUSE: requiredText,
  AML_BRANCH_PASSWORD: z.string().default(''),
  AML_SEED: positiveInt(20261016),
  AML_HISTORY_DAYS: positiveInt(90),
  AML_RETAIL_COUNT: positiveInt(240),
  AML_BUSINESS_COUNT: positiveInt(40),
  AML_LOOK_ALIKE_COUNT: positiveInt(4),
  AML_BRANCH_COUNT: positiveInt(12),
  AML_TICK_MS: positiveInt(2000),
  AML_LOOKBACK_MONTHS: positiveInt(3),
  AML_REPORTING_THRESHOLD_CENTS: positiveInt(REPORTING_THRESHOLD_CENTS),
  AML_FIRST_DAY: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-01-05'),
  AML_RESET: z.enum(['true', 'false']).default('false'),
});

export type AmlConfig = {
  readonly clusterId: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly lakeWarehouse: string;
  readonly branchPassword: string;
  readonly seed: number;
  readonly historyDays: number;
  readonly retailCount: number;
  readonly businessCount: number;
  readonly lookAlikeCount: number;
  readonly branchCount: number;
  readonly tickMs: number;
  readonly lookbackMonths: number;
  readonly thresholdCents: number;
  readonly firstDayStartMs: number;
  readonly reset: boolean;
};

export const loadConfig = (env: Readonly<Record<string, string | undefined>>): AmlConfig => {
  const parsed = EnvSchema.parse(env);
  return {
    clusterId: parsed.AML_CLUSTER_ID,
    bucket: parsed.S3_BUCKET,
    region: parsed.S3_REGION,
    accessKeyId: parsed.AWS_ACCESS_KEY_ID,
    secretAccessKey: parsed.AWS_SECRET_ACCESS_KEY,
    lakeWarehouse: parsed.LAKE_WAREHOUSE,
    branchPassword: parsed.AML_BRANCH_PASSWORD,
    seed: parsed.AML_SEED,
    historyDays: parsed.AML_HISTORY_DAYS,
    retailCount: parsed.AML_RETAIL_COUNT,
    businessCount: parsed.AML_BUSINESS_COUNT,
    lookAlikeCount: parsed.AML_LOOK_ALIKE_COUNT,
    branchCount: parsed.AML_BRANCH_COUNT,
    tickMs: parsed.AML_TICK_MS,
    lookbackMonths: parsed.AML_LOOKBACK_MONTHS,
    thresholdCents: parsed.AML_REPORTING_THRESHOLD_CENTS,
    firstDayStartMs: Date.parse(`${parsed.AML_FIRST_DAY}T00:00:00Z`),
    reset: parsed.AML_RESET === 'true',
  };
};
```

`demos/agent-aml/runner/src/queue.ts`:

```typescript
export type SerialQueue = {
  readonly enqueue: <T>(task: () => Promise<T>) => Promise<T>;
};

export const createSerialQueue = (): SerialQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
  return { enqueue };
};
```

`demos/agent-aml/runner/src/retry.ts`:

```typescript
export const retryUntil = async <T>(options: {
  readonly attempt: () => Promise<T | undefined>;
  readonly tries: number;
  readonly delayMs: number;
  readonly pause: (ms: number) => Promise<void>;
}): Promise<T | undefined> => {
  const result = await options.attempt();
  if (result !== undefined || options.tries <= 1) return result;
  await options.pause(options.delayMs);
  return retryUntil({ ...options, tries: options.tries - 1 });
};
```

`demos/agent-aml/runner/src/branchEnv.ts` (builds the environment `createTidbPool` needs for a branch; the branch SQL user is `<userPrefix>.<name>`):

```typescript
export type BranchEnvOptions = {
  readonly base: Readonly<Record<string, string | undefined>>;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
};

export const branchUser = (options: { readonly userPrefix: string | undefined; readonly user: string }): string => {
  const bare = options.user.includes('.') ? (options.user.split('.').at(-1) ?? options.user) : options.user;
  if (options.userPrefix === undefined || options.userPrefix === '') return options.user;
  if (options.user.startsWith(`${options.userPrefix}.`)) return options.user;
  return `${options.userPrefix}.${bare}`;
};

export const branchEnv = (options: BranchEnvOptions): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(options.base).filter(([, value]) => value !== undefined)),
  TIDB_HOST: options.host,
  TIDB_PORT: String(options.port),
  TIDB_USER: options.user,
  TIDB_PASSWORD: options.password,
  TIDB_DATABASE: options.database,
  TIDB_TLS: 'true',
  TIDB_POOL_SIZE: '2',
});
```

`demos/agent-aml/runner/src/exportParse.ts` (guesses until Packet 13-V3 records real output):

```typescript
export const parseExportId = (stdout: string): string | undefined => {
  const labelled = /export[\s_-]*id\W+([A-Za-z0-9_-]{6,})/i.exec(stdout);
  if (labelled?.[1] !== undefined) return labelled[1];
  const json = /"id"\s*:\s*"([A-Za-z0-9_-]{6,})"/.exec(stdout);
  return json?.[1];
};

export type ExportState = 'running' | 'done' | 'failed';

export const exportState = (stdout: string): ExportState => {
  if (/fail|cancel/i.test(stdout)) return 'failed';
  if (/succeed|success|complete/i.test(stdout)) return 'done';
  return 'running';
};
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/configAndQueue.test.ts runner/test/retry.test.ts runner/test/branchEnv.test.ts
```

Expected PASS: 17 passed (7, 3 and 7).

Commit:

```bash
git add demos/agent-aml/runner/src/config.ts demos/agent-aml/runner/src/queue.ts demos/agent-aml/runner/src/retry.ts demos/agent-aml/runner/src/exportParse.ts demos/agent-aml/runner/src/branchEnv.ts demos/agent-aml/runner/test/configAndQueue.test.ts demos/agent-aml/runner/test/retry.test.ts demos/agent-aml/runner/test/branchEnv.test.ts
git commit -m "agent-aml demo: config, serial queue, retry, export parsing, branch env"
```

### Task 17: Fixtures and their loader

- [ ] Not started

The watchlist is entirely invented and shares no name token with the customer pools. The past cases are synthetic summaries and every one says so. The playbook is the scripted agent.

`demos/agent-aml/runner/test/fixtures.test.ts`:

```typescript
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patternKinds } from '../src/domain';
import { PastCasesSchema, PlaybookSchema, skillFileFor, stepsFor, WatchlistFixtureSchema } from '../src/fixtures';
import { firstNames, lastNames } from '../src/generator';
import { tokenizeName } from '../src/names';
import { lintSkill } from '../src/skills';

const fixturePath = (name: string): string => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const readJson = (name: string): unknown => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

describe('watchlist fixture', () => {
  const watchlist = WatchlistFixtureSchema.parse(readJson('watchlist.json'));

  it('contains only invented names that share no token with the customer name pools', () => {
    const customerTokens = new Set([...firstNames, ...lastNames].flatMap(tokenizeName));
    watchlist.entries.flatMap(tokenizeName).forEach((token) => expect(customerTokens.has(token)).toBe(false));
  });

  it('has unique entries', () => {
    expect(new Set(watchlist.entries).size).toBe(watchlist.entries.length);
  });
});

describe('past cases fixture', () => {
  const cases = PastCasesSchema.parse(readJson('past-cases.json'));

  it('covers every pattern and marks all summaries as synthetic', () => {
    expect(new Set(cases.map((item) => item.pattern))).toEqual(new Set(patternKinds));
    cases.forEach((item) => expect(item.summary).toContain('Synthetic'));
  });

  it('uses unique case ids', () => {
    expect(new Set(cases.map((item) => item.caseId)).size).toBe(cases.length);
  });
});

describe('playbook fixture', () => {
  const playbook = PlaybookSchema.parse(readJson('playbook.json'));

  it('loads the working set first and writes evidence before any branch test', () => {
    patternKinds.forEach((pattern) => {
      const steps = stepsFor(pattern, playbook);
      expect(steps[0]).toBe('load-working-set');
      const branchIndex = steps.indexOf('test-rule-on-branch');
      if (branchIndex !== -1) expect(steps.indexOf('write-evidence')).toBeLessThan(branchIndex);
    });
  });
});

describe('skill fixtures', () => {
  it('has one lint-clean skill file per pattern', () => {
    const files = readdirSync(fixturePath('skills')).sort();
    expect(files).toEqual(patternKinds.map(skillFileFor).sort());
    files.forEach((file) => expect(lintSkill(readFileSync(fixturePath(`skills/${file}`), 'utf8'))).toEqual([]));
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/fixtures.test.ts
```

Expected FAIL: `Cannot find module '../src/fixtures'`.

`demos/agent-aml/runner/src/fixtures.ts`:

```typescript
import { z } from 'zod';
import type { PatternKind } from './domain';

const StepIdSchema = z.enum([
  'load-working-set',
  'recall-similar-cases',
  'lake-lookback',
  'write-evidence',
  'test-rule-on-branch',
]);

export type StepId = z.infer<typeof StepIdSchema>;

export const PlaybookSchema = z.object({
  structuring: z.array(StepIdSchema).min(1),
  'rapid-in-out': z.array(StepIdSchema).min(1),
  'watchlist-near-match': z.array(StepIdSchema).min(1),
});

export type Playbook = z.infer<typeof PlaybookSchema>;

export const stepsFor = (pattern: PatternKind, playbook: Playbook): readonly StepId[] => playbook[pattern];

export const WatchlistFixtureSchema = z.object({
  listTag: z.string().min(1),
  note: z.string(),
  entries: z.array(z.string().min(3)).min(10),
});

export const PastCasesSchema = z.array(
  z.object({
    caseId: z.string().regex(/^PAST-\d{3}$/),
    pattern: z.enum(['structuring', 'rapid-in-out', 'watchlist-near-match']),
    outcome: z.enum(['confirmed', 'false-positive', 'lesson']),
    summary: z.string().min(40),
  }),
);

export type PastCase = z.infer<typeof PastCasesSchema>[number];

export const skillFileFor = (pattern: PatternKind): string => {
  if (pattern === 'structuring') return 'structuring-triage.md';
  if (pattern === 'rapid-in-out') return 'rapid-movement-review.md';
  return 'watchlist-review.md';
};
```

`demos/agent-aml/fixtures/watchlist.json`:

```json
{
  "listTag": "SYNTH-LIST",
  "note": "Entirely invented names for a demonstration. Not derived from any real list.",
  "entries": [
    "Veskar Tolmund Draycott",
    "Orlane Vychek Brandt",
    "Halvard Zenmore Pike",
    "Ilyana Brasko Fenn",
    "Dmitar Quellis Roake",
    "Seraphine Mordaunt Vey",
    "Tavish Ormerod Skeld",
    "Yevhen Larkspur Doane",
    "Lucan Brightmoor Voss",
    "Anneliese Cobhurst Tarn",
    "Rhodri Penvale Sorrel",
    "Matteo Ironsby Kell",
    "Zofia Harrowgate Lund",
    "Casimir Wetherell Oske",
    "Philomena Ashgrove Drey",
    "Boris Stannic Hallow",
    "Katya Fennimore Rusk",
    "Leopold Greywater Thane",
    "Ottoline Marchbank Vire",
    "Gideon Rookwood Sable",
    "Nadezhda Pellimore Cray",
    "Ambrose Tidewell Korn",
    "Svetla Oakenshaw Brisk",
    "Emeric Dunlaith Voe"
  ]
}
```

`demos/agent-aml/fixtures/past-cases.json`:

```json
[
  {
    "caseId": "PAST-001",
    "pattern": "structuring",
    "outcome": "confirmed",
    "summary": "Repeated cash deposits just under the reporting threshold across several branches by three linked retail accounts, all wiring funds to one shared counterparty within a day. Escalated by the analyst. Synthetic."
  },
  {
    "caseId": "PAST-002",
    "pattern": "structuring",
    "outcome": "false-positive",
    "summary": "Cash deposits just under the reporting threshold every other day at a single branch by a cash-intensive business account. Takings pattern, no linked accounts, closed as a false positive. Synthetic."
  },
  {
    "caseId": "PAST-003",
    "pattern": "structuring",
    "outcome": "confirmed",
    "summary": "Six near-threshold cash deposits in five days spread over three branches, then an outgoing wire of most of the total. Two other accounts used the same counterparty. Escalated by the analyst. Synthetic."
  },
  {
    "caseId": "PAST-004",
    "pattern": "structuring",
    "outcome": "false-positive",
    "summary": "Weekly near-threshold cash deposits at the home branch by a laundromat style business. Stable cadence for months of history, closed as a false positive. Synthetic."
  },
  {
    "caseId": "PAST-005",
    "pattern": "rapid-in-out",
    "outcome": "confirmed",
    "summary": "Wire in followed by a near-full wire out within two hours, repeated three times in a day by a holding company account. Pass-through pattern, escalated by the analyst. Synthetic."
  },
  {
    "caseId": "PAST-006",
    "pattern": "rapid-in-out",
    "outcome": "false-positive",
    "summary": "A single large wire in and wire out of the same amount within hours by a property business completing a sale. One pair only, closed as a false positive. Synthetic."
  },
  {
    "caseId": "PAST-007",
    "pattern": "rapid-in-out",
    "outcome": "confirmed",
    "summary": "Two pass-through pairs in one day with about three percent retained, new business account with no prior history. Escalated by the analyst. Synthetic."
  },
  {
    "caseId": "PAST-008",
    "pattern": "watchlist-near-match",
    "outcome": "false-positive",
    "summary": "Account holder name close to a watchlist entry after a list update. Different date of birth and country on file, common surname, closed as a false positive. Synthetic."
  },
  {
    "caseId": "PAST-009",
    "pattern": "watchlist-near-match",
    "outcome": "confirmed",
    "summary": "Account holder name with the given and family names swapped and one letter changed compared with a watchlist entry, matching address details. Escalated by the analyst. Synthetic."
  },
  {
    "caseId": "PAST-010",
    "pattern": "watchlist-near-match",
    "outcome": "false-positive",
    "summary": "Fuzzy name match against a watchlist entry on one shared token only. Customer for many years with ordinary activity, closed as a false positive. Synthetic."
  },
  {
    "caseId": "PAST-011",
    "pattern": "structuring",
    "outcome": "lesson",
    "summary": "Lesson: check how many distinct branches the near-threshold cash deposits touch. Single branch repeating deposits were mostly cash-intensive businesses. Synthetic."
  },
  {
    "caseId": "PAST-012",
    "pattern": "rapid-in-out",
    "outcome": "lesson",
    "summary": "Lesson: count the in and out wire pairs before escalating. One pair is usually a completed sale, two or more in a day deserve a closer look. Synthetic."
  }
]
```

`demos/agent-aml/fixtures/playbook.json`:

```json
{
  "structuring": ["load-working-set", "recall-similar-cases", "lake-lookback", "write-evidence", "test-rule-on-branch"],
  "rapid-in-out": ["load-working-set", "recall-similar-cases", "lake-lookback", "write-evidence"],
  "watchlist-near-match": ["load-working-set", "recall-similar-cases", "lake-lookback", "write-evidence"]
}
```

`demos/agent-aml/fixtures/skills/rapid-movement-review.md`:

```markdown
# Skill: rapid-movement-review
Version: 1

## Purpose

Review an alert raised by the rapid in-out rule: wires that enter an account and leave again within hours.

## When to use

The alert rule id is rapid-in-out.

## Steps

1. Load the case working set and list the in and out wire pairs.
2. Compare the retained share of each pair.
3. Recall similar past cases and read their outcomes.
4. Draft notes for the analyst. Never file anything.

## Learned

- No lessons recorded yet.
```

`demos/agent-aml/fixtures/skills/watchlist-review.md`:

```markdown
# Skill: watchlist-review
Version: 1

## Purpose

Review an alert raised by the watchlist near-match rule: an account holder name close to a synthetic watchlist entry.

## When to use

The alert rule id is watchlist-near-match.

## Steps

1. Load the case working set and compare the holder name with the matched entry token by token.
2. Look back over the account history for ordinary activity.
3. Recall similar past cases and read their outcomes.
4. Draft notes for the analyst. Never file anything.

## Learned

- No lessons recorded yet.
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run runner/test/fixtures.test.ts
```

Expected PASS: 6 passed.

Commit:

```bash
git add demos/agent-aml/runner/src/fixtures.ts demos/agent-aml/fixtures demos/agent-aml/runner/test/fixtures.test.ts
git commit -m "agent-aml demo: fixtures and loader"
```

### Task 18: Manifest

- [ ] Not started

`demos/agent-aml/test/manifest.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('agent-aml demo manifest', () => {
  it('parses against DemoManifestSchema', () => {
    expect(DemoManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('is demo number 13 with id agent-aml', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.id).toBe('agent-aml');
    expect(result.number).toBe(13);
  });

  it('runs the runner through node --import tsx runner/main.ts', () => {
    expect(DemoManifestSchema.parse(manifest).runner.command).toEqual(['node', '--import', 'tsx', 'runner/main.ts']);
  });

  it('gives every metric a howMeasured explanation', () => {
    DemoManifestSchema.parse(manifest).metrics.forEach((metric) => expect(metric.howMeasured.length).toBeGreaterThan(20));
  });

  it('labels every metric that depends on simulated verdicts as simulated', () => {
    const verdictMetrics = DemoManifestSchema.parse(manifest).metrics.filter((metric) => metric.id.startsWith('precision-'));
    expect(verdictMetrics).toHaveLength(2);
    verdictMetrics.forEach((metric) => expect(metric.label).toContain('simulated'));
  });

  it('declares the five agreed controls and five agreed checks', () => {
    const parsed = DemoManifestSchema.parse(manifest);
    expect(parsed.controls.map((control) => control.id)).toEqual([
      'inject-structuring-ring',
      'inject-watchlist-near-match',
      'open-investigation',
      'test-rule-on-branch',
      'promote-skill',
    ]);
    expect(parsed.checks.map((check) => check.id)).toEqual([
      'every-planted-case-flagged',
      'investigation-branch-isolated',
      'journal-verifies',
      'skill-commit-lands-on-base',
      'lake-history-matches-export',
    ]);
  });

  it('walks the eleven agreed phases in order', () => {
    expect(DemoManifestSchema.parse(manifest).phases.map((phase) => phase.id)).toEqual([
      'setup',
      'baseline-traffic',
      'inject-pattern',
      'alert',
      'open-investigation',
      'recall-similar-cases',
      'test-rule-on-branch',
      'analyst-verdict',
      'lake-eval',
      'distill-commit-skill',
      'lesson-to-memory',
    ]);
  });
});
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run test/manifest.test.ts
```

Expected FAIL: `Cannot find module '../manifest.json'`.

`demos/agent-aml/manifest.json`:

```json
{
  "id": "agent-aml",
  "number": 13,
  "title": "TiDB Cloud agent stack: anti-money-laundering agent (Filesystem + TiDB X + Lake)",
  "tagline": "A scripted AML investigator opens a case layer and a database branch per alert, remembers past cases, and learns a better rule in Lake, all on synthetic data.",
  "integrations": [
    "TiDB Cloud Filesystem",
    "TiDB Cloud Starter",
    "TiDB Cloud Lake",
    "Amazon S3"
  ],
  "pattern": "Financial services teams asking how an investigation agent can keep case evidence isolated, test rule changes safely, remember past cases and improve over time without touching production data.",
  "publish": true,
  "runner": {
    "command": [
      "node",
      "--import",
      "tsx",
      "runner/main.ts"
    ],
    "cwd": "."
  },
  "nodes": [
    {
      "id": "txn-generator",
      "label": "Synthetic Transaction Generator",
      "kind": "source",
      "x": 6,
      "y": 15
    },
    {
      "id": "harbor-core",
      "label": "harbor-core (TiDB Cloud Starter)",
      "kind": "tidb",
      "x": 28,
      "y": 15
    },
    {
      "id": "episodic-memory",
      "label": "Episodic Memory (hybrid search)",
      "kind": "tidb",
      "x": 52,
      "y": 15
    },
    {
      "id": "rule-engine",
      "label": "Rule Engine and Alerts",
      "kind": "service",
      "x": 28,
      "y": 45
    },
    {
      "id": "agent-harness",
      "label": "Scripted Agent Harness",
      "kind": "service",
      "x": 52,
      "y": 45
    },
    {
      "id": "case-layers",
      "label": "Case File System (layers)",
      "kind": "cloud",
      "x": 82,
      "y": 22
    },
    {
      "id": "case-journal",
      "label": "Case Journal (hash chain)",
      "kind": "cloud",
      "x": 82,
      "y": 42
    },
    {
      "id": "vault",
      "label": "Vault (delegated grant)",
      "kind": "identity",
      "x": 82,
      "y": 60
    },
    {
      "id": "skills-base",
      "label": "Skills (base file system)",
      "kind": "cloud",
      "x": 82,
      "y": 80
    },
    {
      "id": "investigation-branch",
      "label": "Investigation Branch (Starter)",
      "kind": "tidb",
      "x": 28,
      "y": 72
    },
    {
      "id": "s3-bucket",
      "label": "S3 Bucket",
      "kind": "sink",
      "x": 52,
      "y": 76
    },
    {
      "id": "lake",
      "label": "TiDB Cloud Lake (history and eval)",
      "kind": "sink",
      "x": 52,
      "y": 94
    }
  ],
  "edges": [
    {
      "id": "txn-writes",
      "from": "txn-generator",
      "to": "harbor-core",
      "label": "transactions written",
      "unit": "rows"
    },
    {
      "id": "window-scans",
      "from": "harbor-core",
      "to": "rule-engine",
      "label": "rule windows read",
      "unit": "rows"
    },
    {
      "id": "alerts-written",
      "from": "rule-engine",
      "to": "harbor-core",
      "label": "alerts stored",
      "unit": "alerts"
    },
    {
      "id": "alerts-to-agent",
      "from": "rule-engine",
      "to": "agent-harness",
      "label": "alerts handed to the agent",
      "unit": "alerts"
    },
    {
      "id": "recall-queries",
      "from": "agent-harness",
      "to": "episodic-memory",
      "label": "hybrid recall",
      "unit": "queries"
    },
    {
      "id": "lesson-written",
      "from": "agent-harness",
      "to": "episodic-memory",
      "label": "lesson stored",
      "unit": "rows"
    },
    {
      "id": "evidence-writes",
      "from": "agent-harness",
      "to": "case-layers",
      "label": "evidence written to a layer",
      "unit": "files"
    },
    {
      "id": "what-if-queries",
      "from": "agent-harness",
      "to": "investigation-branch",
      "label": "rule what-if SQL",
      "unit": "queries"
    },
    {
      "id": "audit-entries",
      "from": "agent-harness",
      "to": "case-journal",
      "label": "audit entries appended",
      "unit": "entries"
    },
    {
      "id": "vault-grants",
      "from": "agent-harness",
      "to": "vault",
      "label": "ten minute read grant",
      "unit": "grants"
    },
    {
      "id": "branch-create",
      "from": "harbor-core",
      "to": "investigation-branch",
      "label": "copy-on-write branch",
      "unit": "branches"
    },
    {
      "id": "parquet-export",
      "from": "harbor-core",
      "to": "s3-bucket",
      "label": "Parquet export",
      "unit": "files"
    },
    {
      "id": "run-events",
      "from": "agent-harness",
      "to": "s3-bucket",
      "label": "flags and run events (NDJSON)",
      "unit": "rows"
    },
    {
      "id": "lake-load",
      "from": "s3-bucket",
      "to": "lake",
      "label": "COPY INTO task",
      "unit": "rows"
    },
    {
      "id": "lookback-queries",
      "from": "lake",
      "to": "agent-harness",
      "label": "history lookback and eval",
      "unit": "queries"
    },
    {
      "id": "skill-commits",
      "from": "agent-harness",
      "to": "skills-base",
      "label": "skill layer committed",
      "unit": "files"
    }
  ],
  "metrics": [
    {
      "id": "alerts-per-minute",
      "label": "Alerts per Minute (accelerated clock)",
      "unit": "count",
      "display": "both",
      "better": "neutral",
      "group": "traffic",
      "howMeasured": "New alert rows inserted by one rule-engine tick (affectedRows of the INSERT IGNORE into alerts), scaled by 60000 / AML_TICK_MS. One tick simulates one day of transactions, so this is alerts per wall-clock minute on an accelerated clock, not a production alert rate."
    },
    {
      "id": "planted-recall",
      "label": "Planted-Pattern Recall",
      "unit": "%",
      "display": "both",
      "better": "higher",
      "group": "correctness",
      "target": 100,
      "howMeasured": "plantedCoverage over all production alerts and the ground_truth table: planted accounts that have an alert from their own pattern's rule, divided by all planted accounts, times 100. Ground truth is known because the generator planted it."
    },
    {
      "id": "false-positives-per-1000",
      "label": "False Positives per 1,000 Non-Planted Transactions",
      "unit": "count",
      "display": "both",
      "better": "lower",
      "group": "correctness",
      "howMeasured": "Sum over active production rules of false-positive alerts (alert account not planted for that rule's pattern) times 1000, divided by SELECT COUNT(*) FROM transactions WHERE account_id NOT IN (SELECT account_id FROM ground_truth). Measured against planted ground truth, not analyst opinion."
    },
    {
      "id": "layer-open-seconds",
      "label": "Case Layer and Journal Open Time",
      "unit": "s",
      "display": "tile",
      "better": "lower",
      "group": "investigation",
      "howMeasured": "Seconds from the open-investigation control to the case layer, journal and vault grant all existing (openCaseWorkspace in runner/src/live/filesystem.ts), by Date.now() deltas around those calls."
    },
    {
      "id": "branch-create-seconds",
      "label": "Investigation Branch Create Time",
      "unit": "s",
      "display": "tile",
      "better": "lower",
      "group": "investigation",
      "howMeasured": "Seconds from calling branches.create to branches.waitActive resolving. Branch creation is documented to take a few minutes, so this overlaps the layer and recall work instead of blocking it."
    },
    {
      "id": "investigation-open-time",
      "label": "Investigation Open Time (layer plus branch)",
      "unit": "s",
      "display": "tile",
      "better": "lower",
      "group": "investigation",
      "howMeasured": "Seconds from the open-investigation control until the layer, journal, grant, recall, evidence files and the active branch all exist. Dominated by branch creation."
    },
    {
      "id": "hybrid-recall-ms",
      "label": "Hybrid Recall Latency",
      "unit": "ms",
      "display": "both",
      "better": "lower",
      "group": "memory",
      "howMeasured": "timed() around the single hybrid SQL statement from buildHybridRecallSql: a vector CTE and an fts_match_word CTE fused with reciprocal rank fusion, constant 60, top 3, over the episodic_memory table."
    },
    {
      "id": "lake-lookback-ms",
      "label": "Lake Lookback Latency (months of history)",
      "unit": "ms",
      "display": "both",
      "better": "lower",
      "group": "lake",
      "howMeasured": "timed() around the Lake band-peers (or account lookback) query over AML_LOOKBACK_MONTHS months of synthetic transaction history in harbor.txn_history, through the kit's Lake client, including network time."
    },
    {
      "id": "lake-load-seconds",
      "label": "Starter Export to Lake Visible",
      "unit": "s",
      "display": "tile",
      "better": "lower",
      "group": "lake",
      "howMeasured": "Seconds from kicking the Lake load task (EXECUTE TASK) until SELECT COUNT(*) FROM harbor.txn_history WHERE txn_id <= cutoff reaches the Starter row count for the same cutoff, polled every 5 seconds. Excludes the export job time, which is logged separately."
    },
    {
      "id": "rule-change-alert-delta",
      "label": "Rule Change Alert Volume Delta (measured on the branch)",
      "unit": "count",
      "display": "tile",
      "better": "neutral",
      "group": "learning",
      "howMeasured": "On the investigation branch: COUNT of v2 structuring alerts minus COUNT of v1 structuring alerts from SELECT rule_version, COUNT(*) FROM alerts WHERE rule_id = 'structuring' GROUP BY rule_version, after the candidate rule v2 and its replayed alerts are written to the branch only. Negative means quieter."
    },
    {
      "id": "precision-v1-simulated",
      "label": "Rule v1 Precision (simulated analyst verdicts)",
      "unit": "%",
      "display": "tile",
      "better": "higher",
      "group": "learning",
      "howMeasured": "Lake query over harbor.flag_log, production scope, structuring v1: confirmed flags divided by all flags, times 100. Verdicts are simulated: a flag is confirmed when its account is planted ground truth for that rule."
    },
    {
      "id": "precision-v2-simulated",
      "label": "Rule v2 Precision (simulated analyst verdicts)",
      "unit": "%",
      "display": "tile",
      "better": "higher",
      "group": "learning",
      "howMeasured": "Same Lake query for scope branch-shadow, structuring v2, the flags the candidate rule would have raised on the branch. Verdicts are simulated from ground truth."
    }
  ],
  "phases": [
    {
      "id": "setup",
      "label": "Setup",
      "narration": "Harbor Mutual is a fictional bank. We seed synthetic customers, a synthetic watchlist and months of transactions into a TiDB Cloud Starter instance, then export the history to Lake through S3."
    },
    {
      "id": "baseline-traffic",
      "label": "Baseline Traffic",
      "narration": "Ordinary traffic keeps flowing and the v1 rules keep raising alerts. Notice how many are false positives against the ground truth we planted."
    },
    {
      "id": "inject-pattern",
      "label": "Inject a Pattern",
      "narration": "Now we plant a structuring ring, or a name that is close to a new watchlist entry. We know the answer because we planted it."
    },
    {
      "id": "alert",
      "label": "Alert",
      "narration": "The rule engine flags it. Every planted case must be flagged, and the demo checks that."
    },
    {
      "id": "open-investigation",
      "label": "Open an Investigation",
      "narration": "Each alert gets its own file system layer, a journal, a ten minute vault grant and a copy-on-write database branch. Branch creation takes minutes, so the agent keeps working while it finishes."
    },
    {
      "id": "recall-similar-cases",
      "label": "Recall Similar Cases",
      "narration": "The agent recalls similar past cases with one hybrid query, vector plus full text, and looks back through months of history in Lake. Then it writes evidence and a draft into the case layer. Nothing is filed; a human decides."
    },
    {
      "id": "test-rule-on-branch",
      "label": "Test a Rule on the Branch",
      "narration": "The agent tries a tighter candidate rule on the branch. Production rules and alerts are untouched, and the demo proves it."
    },
    {
      "id": "analyst-verdict",
      "label": "Analyst Verdict (simulated)",
      "narration": "Verdicts here are simulated from the planted ground truth and labeled that way. They stand in for a human analyst."
    },
    {
      "id": "lake-eval",
      "label": "Lake Evaluation",
      "narration": "Flags, verdicts and history land in Lake. One query gives precision per rule version, and recall on planted cases."
    },
    {
      "id": "distill-commit-skill",
      "label": "Distill and Commit a Skill",
      "narration": "The agent writes what it learned into a skill file inside a layer. A human presses promote, and only then does the layer commit to the shared skills folder."
    },
    {
      "id": "lesson-to-memory",
      "label": "Lesson to Memory",
      "narration": "The lesson goes into episodic memory, so the next similar case recalls it. The journal hash chain then verifies the whole investigation."
    }
  ],
  "checks": [
    {
      "id": "every-planted-case-flagged",
      "label": "Every Planted Case Flagged",
      "description": "Every account in ground_truth has at least one production alert from the rule for its own pattern."
    },
    {
      "id": "investigation-branch-isolated",
      "label": "Branch Isolated from Production",
      "description": "The candidate rule and its alerts exist on the investigation branch and are absent from the production rules and alerts tables."
    },
    {
      "id": "journal-verifies",
      "label": "Case Journal Verifies",
      "description": "ti fs-journal verify-journal passes on the case journal after every investigation step was appended."
    },
    {
      "id": "skill-commit-lands-on-base",
      "label": "Skill Commit Lands on the Base",
      "description": "After commit-layer, reading the skill from the base file system returns exactly the staged text."
    },
    {
      "id": "lake-history-matches-export",
      "label": "Lake History Matches the Export",
      "description": "Rows in harbor.txn_history up to the export cutoff txn_id equal the Starter row count for the same cutoff."
    }
  ],
  "controls": [
    {
      "id": "inject-structuring-ring",
      "label": "Inject structuring ring",
      "description": "Plants a three-account ring of near-threshold cash deposits across branches, with ground truth."
    },
    {
      "id": "inject-watchlist-near-match",
      "label": "Inject watchlist near-match",
      "description": "Adds a synthetic watchlist entry whose name is close to an existing customer and rescreens by full-text search."
    },
    {
      "id": "open-investigation",
      "label": "Open investigation",
      "description": "Opens a layer, journal, grant and branch for the top open alert and runs the playbook steps."
    },
    {
      "id": "test-rule-on-branch",
      "label": "Test rule on branch",
      "description": "Writes candidate rule v2 to the branch only, compares alert volume and recall, then records simulated verdicts and runs the Lake evaluation."
    },
    {
      "id": "promote-skill",
      "label": "Promote skill",
      "description": "Human approval step: commits the staged skill layer to the base file system and writes the lesson to episodic memory."
    }
  ]
}
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run test/manifest.test.ts
```

Expected PASS: 7 passed.

Commit:

```bash
git add demos/agent-aml/manifest.json demos/agent-aml/test/manifest.test.ts
git commit -m "agent-aml demo: manifest"
```

### Task 19: Environment file and one-time cloud setup (manual, live)

- [ ] Not started

Nothing in this task is committed except `.env.example`. Do the packets 13-V0 to 13-V3 around it: V0 needs only the kit source; V1 to V3 need the resources created here.

Step 1: install and sign in to both CLIs. This is Plan 12 Task 1 step 1 without the macFUSE install, which this demo does not need.

```bash
curl -fsSL https://github.com/tidbcloud/ti-cli/releases/latest/download/install.sh | sh -s -- --yes
ti configure
ticloud config create --profile-name harbor-aml --public-key <public-key> --private-key <private-key>
```

Expected: `ti --version` and `ticloud --version` print versions. Record both for `LAB_ENV_COMPONENT_TI_CLI` and `LAB_ENV_COMPONENT_TICLOUD_CLI`.

Step 2: create the Starter instance `harbor-core` in aws-us-east-1 from the TiDB Cloud console (Starter, region N. Virginia). The CLI form is `ti db create-db-cluster --db-cluster-type starter --db-cluster-name harbor-core --wait`; its region option is not confirmed in section 4, so use the console. Create a SQL user, copy the public endpoint host, and copy the instance id.

Step 3: create the file system and export its id and token.

```bash
ti fs create-file-system --display-name harbor-aml --label demo=agent-aml --wait
```

Expected: output includes the new file system id and stores the owner token in your `ti` profile (copy the token if it warns it could not). Set `TI_FS_FILE_SYSTEM_ID` to the id; no kit method takes a file system id.

Step 4: create the bucket and a bucket-scoped IAM user.

```bash
export S3_BUCKET=harbor-aml-lab-$(date +%s)
aws s3api create-bucket --bucket "$S3_BUCKET" --region us-east-1
aws iam create-user --user-name aml-lab
```

`aml-lab-policy.json` (keep it outside the repo):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::BUCKET" },
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::BUCKET/*" }
  ]
}
```

Replace `BUCKET` with the bucket name, then:

```bash
aws iam put-user-policy --user-name aml-lab --policy-name aml-lab-bucket --policy-document file://aml-lab-policy.json
aws iam create-access-key --user-name aml-lab
```

Expected: JSON containing an `AccessKeyId` and `SecretAccessKey`. These become `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (the kit's S3 sink reads the default AWS credential chain).

Step 5: Lake. In the Lake console, in the region that matches aws-us-east-1 (13-V3 records which regions pair), create a warehouse named `harbor-wh` (XSmall), then open Overview, Connect, select the warehouse and copy the host, the SQL user and the password (shown once). They become `LAKE_HOST`, `LAKE_USER`, `LAKE_PASSWORD` and `LAKE_WAREHOUSE=harbor-wh`. This mirrors Plan 12 Task 1; a Lake warehouse from that plan may be reused, since this demo only creates its own `harbor` database.

Step 6: `demos/agent-aml/.env.example` (committed, standard block first):

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
LAB_ENV_COMPONENT_S3=Amazon S3, us-east-1
AML_CLUSTER_ID=
AML_BRANCH_PASSWORD=
TI_FS_FILE_SYSTEM_ID=
S3_BUCKET=
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
LAKE_HOST=
LAKE_USER=
LAKE_PASSWORD=
LAKE_PORT=443
LAKE_WAREHOUSE=harbor-wh
AML_SEED=20261016
AML_FIRST_DAY=2026-01-05
AML_HISTORY_DAYS=90
AML_RETAIL_COUNT=240
AML_BUSINESS_COUNT=40
AML_LOOK_ALIKE_COUNT=4
AML_BRANCH_COUNT=12
AML_TICK_MS=2000
AML_LOOKBACK_MONTHS=3
AML_REPORTING_THRESHOLD_CENTS=1000000
AML_RESET=false
```

Copy it to `demos/agent-aml/.env`, fill in every value, and set `TIDB_HOST` to the Starter public endpoint host, `TIDB_USER` and `TIDB_PASSWORD` to the SQL user, `TIDB_DATABASE=harbor_core`, `TIDB_TLS=true`, and `AML_RESET=true` for the first run. Never commit `.env`.

Step 7: create the database.

```bash
pnpm lab db-init agent-aml
```

Expected: `database harbor_core ready (TiDB v` followed by the version string.

Commit:

```bash
git add demos/agent-aml/.env.example
git commit -m "agent-aml demo: env template"
```

### Task 20: Starter helpers and the recall smoke check (live)

- [ ] Not started

`demos/agent-aml/runner/src/starter.ts` holds every pool-level operation: schema, bulk inserts, window reads, scoring inputs, watchlist screening, hybrid recall and the visibility polls. It imports no kit.

```typescript
import type { Pool } from 'mysql2/promise';
import { sleep } from '@lab/runner-kit';
import { z } from 'zod';
import type { Account, Alert, GroundTruthEntry, Transaction, WatchlistEntry } from './domain';
import { ftsQueryFromName } from './names';
import { buildHybridRecallSql, recallHitFromRow, type RecallHit } from './recallSql';
import { accountFromRow, alertFromRow, groundTruthFromRow, transactionFromRow, watchlistEntryFromRow } from './rowMappers';
import { retryUntil } from './retry';
import { parseRuleRow, type RuleDefinition } from './rules';
import { resetStatements, schemaStatements } from './schema';
import {
  accountInsert,
  alertInsert,
  alertVolumeByVersion,
  chunk,
  countNonPlantedTransactions,
  countTransactionsUpTo,
  entityFactsInsert,
  groundTruthInsert,
  isolationProbe,
  maxTransactionId,
  selectAccounts,
  selectActiveRules,
  selectAlerts,
  selectEntityFacts,
  selectGroundTruth,
  selectTransactionsSince,
  selectWatchlistCandidates,
  transactionInserts,
  type Statement,
} from './starterSql';
import { formatDateTimeMs } from './time';
import { parseDateTime } from './time';
import type { IsolationProbe } from './whatIf';

export type StarterPool = Pool;

type Row = Readonly<Record<string, unknown>>;

const HeaderSchema = z.object({ affectedRows: z.number() });

export const rowsOf = async (pool: StarterPool, sql: string, params: readonly unknown[] = []): Promise<readonly Row[]> => {
  const [rows] = await pool.query(sql, [...params]);
  return z.array(z.looseObject({})).parse(rows);
};

export const execute = async (pool: StarterPool, statement: Statement): Promise<number> => {
  if (statement.sql === '') return 0;
  const [header] = await pool.query(statement.sql, [...statement.params]);
  return HeaderSchema.parse(header).affectedRows;
};

const countOf = async (pool: StarterPool, sql: string, params: readonly unknown[] = []): Promise<number> => {
  const [row] = await rowsOf(pool, sql, params);
  return Number(row?.n ?? 0);
};

export const ensureSchema = async (pool: StarterPool, reset: boolean): Promise<void> => {
  await schemaStatements.reduce(async (previous, sql) => {
    await previous;
    await pool.query(sql);
  }, Promise.resolve());
  if (!reset) return;
  await resetStatements.reduce(async (previous, sql) => {
    await previous;
    await pool.query(sql);
  }, Promise.resolve());
};

export const insertTransactions = async (pool: StarterPool, transactions: readonly Transaction[]): Promise<number> => {
  const counts = await transactionInserts(transactions).reduce<Promise<number>>(
    async (previous, statement) => (await previous) + (await execute(pool, statement)),
    Promise.resolve(0),
  );
  return counts;
};

export const insertPeople = async (pool: StarterPool, accounts: readonly Account[]): Promise<void> => {
  await execute(pool, accountInsert(accounts));
  await execute(pool, entityFactsInsert(accounts));
};

export const insertTruth = (pool: StarterPool, truth: readonly GroundTruthEntry[]): Promise<number> =>
  execute(pool, groundTruthInsert(truth));

export const insertAlerts = (pool: StarterPool, alerts: readonly Alert[]): Promise<number> =>
  chunk(alerts, 200).reduce<Promise<number>>(
    async (previous, batch) => (await previous) + (await execute(pool, alertInsert(batch))),
    Promise.resolve(0),
  );

export const readTransactionsSince = async (pool: StarterPool, sinceMs: number): Promise<readonly Transaction[]> =>
  (await rowsOf(pool, selectTransactionsSince, [formatDateTimeMs(sinceMs)])).map(transactionFromRow);

export const readAccounts = async (pool: StarterPool): Promise<readonly Account[]> =>
  (await rowsOf(pool, selectAccounts)).map(accountFromRow);

export const readTruth = async (pool: StarterPool): Promise<readonly GroundTruthEntry[]> =>
  (await rowsOf(pool, selectGroundTruth)).map(groundTruthFromRow);

export const readAlerts = async (pool: StarterPool): Promise<readonly Alert[]> =>
  (await rowsOf(pool, selectAlerts)).map(alertFromRow);

export const readActiveRules = async (pool: StarterPool): Promise<readonly RuleDefinition[]> =>
  (await rowsOf(pool, selectActiveRules)).map(parseRuleRow);

export const readEntityFacts = async (pool: StarterPool, entityId: string): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    (await rowsOf(pool, selectEntityFacts, [entityId])).map((row): readonly [string, string] => [
      String(row.fact_key),
      String(row.fact_value),
    ]),
  );

export const nonPlantedTransactionCount = (pool: StarterPool): Promise<number> =>
  countOf(pool, countNonPlantedTransactions);

export const transactionCountUpTo = (pool: StarterPool, txnId: number): Promise<number> =>
  countOf(pool, countTransactionsUpTo, [txnId]);

export const serverNowMs = async (pool: StarterPool): Promise<number> => {
  const [row] = await rowsOf(pool, "SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%d %H:%i:%s.%f') AS now_text");
  return parseDateTime(String(row?.now_text));
};

export const maxTxnId = async (pool: StarterPool): Promise<number> => {
  const [row] = await rowsOf(pool, maxTransactionId);
  return Number(row?.max_id ?? 0);
};

export const alertVolume = async (pool: StarterPool, ruleId: string): Promise<ReadonlyMap<string, number>> =>
  new Map(
    (await rowsOf(pool, alertVolumeByVersion, [ruleId])).map((row): readonly [string, number] => [
      String(row.rule_version),
      Number(row.alerts),
    ]),
  );

export const probeIsolation = async (pool: StarterPool): Promise<IsolationProbe> => {
  const [row] = await rowsOf(pool, isolationProbe);
  return { v2Rules: Number(row?.v2_rules ?? 0), v2Alerts: Number(row?.v2_alerts ?? 0) };
};

export const screenAccounts = async (
  pool: StarterPool,
  accounts: readonly Account[],
): Promise<ReadonlyMap<string, readonly WatchlistEntry[]>> => {
  const screenOne = async (account: Account): Promise<readonly [string, readonly WatchlistEntry[]]> => {
    const query = ftsQueryFromName(account.holderName);
    if (query === '') return [account.accountId, []];
    const rows = await rowsOf(pool, selectWatchlistCandidates(query));
    return [account.accountId, rows.map(watchlistEntryFromRow)];
  };
  const entries = await chunk(accounts, 8).reduce<Promise<readonly (readonly [string, readonly WatchlistEntry[]])[]>>(
    async (previous, batch) => [...(await previous), ...(await Promise.all(batch.map(screenOne)))],
    Promise.resolve([]),
  );
  return new Map(entries.filter(([, hits]) => hits.length > 0));
};

export const recall = async (pool: StarterPool, queryText: string): Promise<readonly RecallHit[]> =>
  (await rowsOf(pool, buildHybridRecallSql({ queryText }))).map(recallHitFromRow);

export const awaitWatchlistEntry = async (pool: StarterPool, fullName: string): Promise<boolean> => {
  const query = ftsQueryFromName(fullName);
  const found = await retryUntil({
    attempt: async () => {
      const rows = await rowsOf(pool, selectWatchlistCandidates(query));
      return rows.some((row) => row.full_name === fullName) ? true : undefined;
    },
    tries: 30,
    delayMs: 2000,
    pause: sleep,
  });
  return found === true;
};

export const awaitRecallOf = async (pool: StarterPool, queryText: string, caseId: string): Promise<readonly RecallHit[]> => {
  const hits = await retryUntil({
    attempt: async () => {
      const result = await recall(pool, queryText);
      return result.some((hit) => hit.caseId === caseId) ? result : undefined;
    },
    tries: 10,
    delayMs: 3000,
    pause: sleep,
  });
  return hits ?? recall(pool, queryText);
};
```

Run:

```bash
pnpm --filter @lab/demo-agent-aml typecheck
```

Expected: exit 0. (`smoke.ts`, created in Task 21, is part of the same `tsconfig`; typecheck it after that task.)

Commit:

```bash
git add demos/agent-aml/runner/src/starter.ts
git commit -m "agent-aml demo: Starter pool helpers"
```

### Task 21: Filesystem, Lake and export adapters with live smoke checks

- [ ] Not started

These modules are the only code that calls the kit for CLI, Lake and S3 work. They are verified by the `smoke` subcommands below, run against the resources from Task 19. Every call shape follows section 4; Packet 13-V0 reconciles them with the real kit before this task starts.

`demos/agent-aml/runner/src/live/context.ts`:

```typescript
import type { BranchInfo } from '@lab/agent-stack-kit';
import type { Emitter } from '@lab/runner-kit';
import type { AmlConfig } from '../config';
import type { Account, Alert, GroundTruthEntry, WatchlistEntry } from '../domain';
import type { PastCase, Playbook } from '../fixtures';
import type { Population } from '../generator';
import type { DistilledSkill } from '../skills';
import type { StarterPool } from '../starter';
import type { Store } from '../store';
import type { WhatIfResult } from '../whatIf';
import type { CaseWorkingSet } from '../workingSet';
import type { Lake } from './lake';
import type { RowSink } from './sinks';

export type World = {
  readonly population: Population;
  readonly accounts: readonly Account[];
  readonly truth: readonly GroundTruthEntry[];
  readonly watchlistEntries: number;
  readonly watchlistCandidates: ReadonlyMap<string, readonly WatchlistEntry[]>;
  readonly nextTxnId: number;
  readonly lastDayStartMs: number;
  readonly dayCounter: number;
  readonly ringCount: number;
  readonly ringAccountCount: number;
  readonly nearMatchCount: number;
  readonly exportedUpToTxnId: number;
  readonly lastAlertCommitWallMs: number;
  readonly runEventSeq: number;
  readonly flagsEmitted: number;
  readonly coverageStatus: 'pending' | 'pass' | 'fail';
};

export type CaseRecord = {
  readonly caseId: string;
  readonly alert: Alert;
  readonly layerId: string;
  readonly grantToken: string;
  readonly branchEndpoint: BranchInfo | undefined;
  readonly workingSet: CaseWorkingSet | undefined;
  readonly whatIf: WhatIfResult | undefined;
  readonly shadowAlerts: readonly Alert[];
  readonly skillLayerId: string | undefined;
  readonly distilled: DistilledSkill | undefined;
  readonly skillPath: string | undefined;
  readonly lakeRecallV2: number | undefined;
};

export type Fixtures = {
  readonly directory: string;
  readonly watchlistNames: readonly string[];
  readonly watchlistTag: string;
  readonly pastCases: readonly PastCase[];
  readonly playbook: Playbook;
};

export type Context = {
  readonly config: AmlConfig;
  readonly database: string;
  readonly runId: string;
  readonly emitter: Emitter;
  readonly pool: StarterPool;
  readonly lake: Lake;
  readonly sinks: { readonly truth: RowSink; readonly flags: RowSink; readonly run: RowSink };
  readonly fixtures: Fixtures;
  readonly world: Store<World>;
  readonly cases: Store<readonly CaseRecord[]>;
};

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
```

`demos/agent-aml/runner/src/live/cli.ts` (the kit's `runCli` never rejects on a nonzero exit, so every call goes through this wrapper):

```typescript
import { runCli } from '@lab/agent-stack-kit';

type CliOptions = Parameters<typeof runCli>[0];

export const runOrThrow = async (options: CliOptions): Promise<Awaited<ReturnType<typeof runCli>>> => {
  const result = await runCli(options);
  if (result.code !== 0) {
    throw new Error(`${options.bin} ${options.args.slice(0, 3).join(' ')} exited ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  return result;
};
```

`demos/agent-aml/runner/src/live/sinks.ts` (buffers rows and flushes them as one NDJSON object through the kit's S3 sink):

```typescript
import type { S3EventSink } from '@lab/agent-stack-kit';

export type RowSink = {
  readonly emit: (row: object) => void;
  readonly flush: () => Promise<number>;
};

export const createRowSink = (sink: S3EventSink): RowSink => {
  let pending: readonly string[] = [];
  return {
    emit: (row) => {
      pending = [...pending, JSON.stringify(row)];
    },
    flush: async () => {
      const lines = pending;
      pending = [];
      if (lines.length === 0) return 0;
      await sink.write(lines);
      return lines.length;
    },
  };
};
```

`demos/agent-aml/runner/src/live/filesystem.ts`:

```typescript
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tiFs } from '@lab/agent-stack-kit';
import {
  FILE_SYSTEM_ROOT,
  agentIdFor,
  casePathFor,
  journalEntry,
  journalIdFor,
  layerNameFor,
  skillsPath,
} from '../journal';
import { runOrThrow } from './cli';

export const SYNTHETIC_SECRET_NAME = 'watchlist-api';
export const SYNTHETIC_SECRET_FIELD = 'KEY';
export const SYNTHETIC_SECRET_VALUE = 'SYNTHETIC-WATCHLIST-KEY-NOT-REAL';

const ti = (args: readonly string[]) => runOrThrow({ bin: 'ti', args });

const withTempFile = async <T>(content: string, use: (localPath: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'aml-'));
  try {
    const localPath = join(directory, 'payload');
    await writeFile(localPath, content, 'utf8');
    return await use(localPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const makeDirectory = async (path: string): Promise<void> => {
  try {
    await ti(['fs', 'create-directory', '--path', path]);
  } catch (error) {
    if (!/exist/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
};

export const writeBaseFile = (options: { readonly remotePath: string; readonly content: string }): Promise<unknown> =>
  withTempFile(options.content, (localPath) =>
    ti(['fs', 'copy-file', '--from-local', localPath, '--to-remote', options.remotePath, '--overwrite']),
  );

export const writeLayerFile = (options: {
  readonly layerId: string;
  readonly remotePath: string;
  readonly content: string;
}): Promise<unknown> =>
  withTempFile(options.content, (localPath) =>
    ti([
      'fs',
      'copy-file',
      '--from-local',
      localPath,
      '--to-remote',
      options.remotePath,
      '--layer-id',
      options.layerId,
      '--overwrite',
    ]),
  );

export const readBaseFile = async (path: string): Promise<string> => (await ti(['fs', 'read-file', '--path', path])).stdout;

export const seedFileSystem = async (fixturesDirectory: string): Promise<void> => {
  await makeDirectory(FILE_SYSTEM_ROOT);
  await makeDirectory(`${FILE_SYSTEM_ROOT}/cases`);
  await makeDirectory(skillsPath);
  const skillsDirectory = join(fixturesDirectory, 'skills');
  const files = await readdir(skillsDirectory);
  await files.reduce(async (previous, file) => {
    await previous;
    await writeBaseFile({
      remotePath: `${skillsPath}/${file}`,
      content: await readFile(join(skillsDirectory, file), 'utf8'),
    });
  }, Promise.resolve());
};

export const seedVaultSecret = (): Promise<unknown> =>
  withTempFile(SYNTHETIC_SECRET_VALUE, (localPath) =>
    ti(['fs-vault', 'create-secret', '--secret-name', SYNTHETIC_SECRET_NAME, '--field', `${SYNTHETIC_SECRET_FIELD}=@${localPath}`]),
  );

export type CaseWorkspace = {
  readonly layerId: string;
  readonly journalId: string;
  readonly grantToken: string;
};

export const openCaseWorkspace = async (caseId: string): Promise<CaseWorkspace> => {
  await makeDirectory(casePathFor(caseId));
  const layer = await tiFs.createLayer({
    baseRootPath: casePathFor(caseId),
    layerName: layerNameFor(caseId),
    tags: { case: caseId },
  });
  const journalId = journalIdFor(caseId);
  await tiFs.createJournal({ journalId, journalKind: 'aml-case', title: `Investigation ${caseId}` });
  const grant = await tiFs.createGrant({
    agentId: agentIdFor(caseId),
    scope: `${SYNTHETIC_SECRET_NAME}/${SYNTHETIC_SECRET_FIELD}`,
    permission: 'read',
    ttl: '10m',
  });
  return { layerId: layer.layerId, journalId, grantToken: grant };
};

export const readSecretWithGrant = async (grantToken: string): Promise<string> =>
  (
    await runOrThrow({
      bin: 'ti',
      args: ['fs-vault', 'read-secret', '--secret-name', SYNTHETIC_SECRET_NAME, '--field', SYNTHETIC_SECRET_FIELD, '--format', 'raw'],
      env: { TI_VAULT_TOKEN: grantToken },
    })
  ).stdout.trim();

export const appendCaseJournal = (options: {
  readonly caseId: string;
  readonly type: string;
  readonly summary: string;
}): Promise<void> => {
  const entry = journalEntry(options);
  return tiFs.appendJournal({
    journalId: journalIdFor(options.caseId),
    entry: { type: entry.type, subjects: entry.subjects, summary: entry.summary },
    idempotencyKey: entry.idempotencyKey,
  });
};
```

`demos/agent-aml/runner/src/live/lake.ts`:

```typescript
import { createLakeClient, lakeConfigFromEnv } from '@lab/agent-stack-kit';
import { sleep, timed } from '@lab/runner-kit';
import type { AmlConfig } from '../config';
import { buildLakeSetupStatements, executeLoadTask } from '../lakeSql';

export type Lake = ReturnType<typeof createLakeClient>;

export const connectLake = (env: NodeJS.ProcessEnv): Lake => createLakeClient(lakeConfigFromEnv(env));

export const setupLake = async (lake: Lake, config: AmlConfig): Promise<void> => {
  const statements = buildLakeSetupStatements({
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    warehouse: config.lakeWarehouse,
  });
  await statements.reduce(async (previous, sql) => {
    await previous;
    await lake.query(sql);
  }, Promise.resolve());
};

export const countRows = async (lake: Lake, sql: string): Promise<number> => {
  const [row] = await lake.query(sql);
  return Number(row?.n ?? 0);
};

export const timedQuery = (lake: Lake, sql: string) => timed(() => lake.query(sql));

export const awaitRowCount = async (options: {
  readonly lake: Lake;
  readonly countSql: string;
  readonly expected: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly kickEveryMs: number;
}): Promise<{ readonly reached: boolean; readonly observed: number; readonly seconds: number }> => {
  const startedAt = Date.now();
  const kick = async (): Promise<void> => {
    await options.lake.query(executeLoadTask).catch(() => undefined);
  };
  await kick();
  const poll = async (observed: number, lastKickAt: number): Promise<{ reached: boolean; observed: number }> => {
    const now = Date.now();
    if (observed >= options.expected) return { reached: true, observed };
    if (now - startedAt > options.timeoutMs) return { reached: false, observed };
    await sleep(options.pollMs);
    const needsKick = Date.now() - lastKickAt >= options.kickEveryMs;
    if (needsKick) await kick();
    const next = await countRows(options.lake, options.countSql).catch(() => observed);
    return poll(next, needsKick ? Date.now() : lastKickAt);
  };
  const result = await poll(0, Date.now());
  return { ...result, seconds: (Date.now() - startedAt) / 1000 };
};
```

`demos/agent-aml/runner/src/live/exports.ts`:

```typescript
import { runOrThrow } from './cli';
import { sleep } from '@lab/runner-kit';
import type { AmlConfig } from '../config';
import { exportState, parseExportId } from '../exportParse';
import { buildExportArgs, exportUri, redactArgs } from '../exportPlan';

export const runTransactionExport = async (options: {
  readonly config: AmlConfig;
  readonly database: string;
  readonly batch: number;
  readonly afterTxnId: number;
  readonly upToTxnId: number;
  readonly log: (message: string) => void;
}): Promise<{ readonly exportId: string; readonly seconds: number }> => {
  const startedAt = Date.now();
  const args = buildExportArgs({
    clusterId: options.config.clusterId,
    database: options.database,
    table: 'transactions',
    s3Uri: exportUri({ bucket: options.config.bucket, batch: options.batch }),
    accessKeyId: options.config.accessKeyId,
    secretAccessKey: options.config.secretAccessKey,
    afterTxnId: options.afterTxnId,
    upToTxnId: options.upToTxnId,
  });
  options.log(`ticloud ${redactArgs(args).join(' ')}`);
  const created = await runOrThrow({ bin: 'ticloud', args });
  const exportId = parseExportId(created.stdout);
  if (exportId === undefined) throw new Error(`could not read the export id from: ${created.stdout.slice(0, 200)}`);
  const wait = async (): Promise<void> => {
    if (Date.now() - startedAt > 10 * 60_000) throw new Error(`export ${exportId} did not finish in 10 minutes`);
    const described = await runOrThrow({
      bin: 'ticloud',
      args: ['serverless', 'export', 'describe', '-c', options.config.clusterId, '-e', exportId],
    });
    const state = exportState(described.stdout);
    if (state === 'failed') throw new Error(`export ${exportId} failed: ${described.stdout.slice(0, 200)}`);
    if (state === 'running') {
      await sleep(3000);
      await wait();
    }
  };
  await wait();
  return { exportId, seconds: (Date.now() - startedAt) / 1000 };
};

export const clearLakePrefix = async (config: AmlConfig): Promise<void> => {
  await runOrThrow({
    bin: 'aws',
    args: ['s3', 'rm', `s3://${config.bucket}/lake/`, '--recursive'],
    env: {
      AWS_ACCESS_KEY_ID: config.accessKeyId,
      AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
      AWS_DEFAULT_REGION: config.region,
    },
  });
};
```

`demos/agent-aml/runner/smoke.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { branches, rfc3339Second, tiFs } from '@lab/agent-stack-kit';
import { branchEnv, branchUser } from './src/branchEnv';
import { createTidbPool, timed } from '@lab/runner-kit';
import { loadConfig } from './src/config';
import { PastCasesSchema } from './src/fixtures';
import { skillsPath } from './src/journal';
import { errorMessage } from './src/live/context';
import {
  appendCaseJournal,
  makeDirectory,
  readBaseFile,
  seedFileSystem,
  writeLayerFile,
} from './src/live/filesystem';
import { connectLake, countRows, setupLake } from './src/live/lake';
import { buildRecallQuery } from './src/recallSql';
import { ensureSchema, execute, recall, rowsOf } from './src/starter';
import { episodicInsert } from './src/starterSql';

const fixturesDirectory = fileURLToPath(new URL('./fixtures', import.meta.url));
const config = loadConfig(process.env);
const out = (line: string): void => console.log(line);

const smokeFileSystem = async (): Promise<void> => {
  await seedFileSystem(fixturesDirectory);
  const smokePath = '/harbor/smoke';
  await makeDirectory(smokePath);
  const layer = await tiFs.createLayer({ baseRootPath: smokePath, layerName: 'smoke-layer' });
  out(`layer-created ${layer.layerId}`);
  await writeLayerFile({ layerId: layer.layerId, remotePath: `${smokePath}/note.md`, content: 'smoke\n' });
  const diff = await tiFs.diffLayer({ layerId: layer.layerId });
  out(`diff-changes ${diff.length}`);
  const before = await readBaseFile(`${smokePath}/note.md`).then(
    () => 'present',
    () => 'absent',
  );
  out(`base-before-commit ${before}`);
  const commit = await timed(() => tiFs.commitLayer({ layerId: layer.layerId }));
  out(`commit-ms ${commit.ms.toFixed(0)}`);
  const after = await readBaseFile(`${smokePath}/note.md`).then(
    () => 'present',
    () => 'absent',
  );
  out(`base-after-commit ${after}`);
  await tiFs.createJournal({ journalId: 'jrn-smoke', journalKind: 'smoke', title: 'smoke journal' });
  await appendCaseJournal({ caseId: 'SMOKE', type: 'smoke.checked', summary: 'one entry' });
  const verified = await tiFs.verifyJournal({ journalId: 'jrn-smoke' });
  out(`journal-verify ${verified.ok ? 'ok' : 'failed'}`);
  await tiFs.deleteLayer({ layerRef: layer.layerId });
  out(`skills-seeded ${(await readBaseFile(`${skillsPath}/structuring-triage.md`)).split('\n')[0]}`);
};

const smokeBranch = async (): Promise<void> => {
  const startedAt = Date.now();
  const created = await branches.create({
    clusterId: config.clusterId,
    name: 'aml-smoke',
    parentTimestamp: rfc3339Second(new Date(Date.now() - 60_000)),
  });
  out(`branch-created ${created.branchId}`);
  const endpoint = await branches.waitActive({ clusterId: config.clusterId, branchId: created.branchId, timeoutMs: 15 * 60_000 });
  out(`branch-create-seconds ${((Date.now() - startedAt) / 1000).toFixed(0)}`);
  if (endpoint.host === undefined || endpoint.port === undefined) throw new Error('branch reported no host or port');
  const pool = createTidbPool(
    branchEnv({
      base: process.env,
      host: endpoint.host,
      port: endpoint.port,
      user: branchUser({ userPrefix: endpoint.userPrefix, user: process.env.TIDB_USER ?? '' }),
      password: config.branchPassword === '' ? (process.env.TIDB_PASSWORD ?? '') : config.branchPassword,
      database: process.env.TIDB_DATABASE ?? 'harbor_core',
    }),
  );
  try {
    const [row] = await rowsOf(pool, 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    out(`branch-tables ${String(row?.n)}`);
  } finally {
    await pool.end();
    await branches.remove({ clusterId: config.clusterId, branchId: created.branchId });
    out('branch-removed');
  }
};

const smokeLake = async (): Promise<void> => {
  const lake = connectLake(process.env);
  await setupLake(lake, config);
  out('lake-setup-ok');
  const tables = ['txn_history', 'ground_truth', 'flag_log', 'run_events'];
  await tables.reduce(async (previous, table) => {
    await previous;
    out(`lake-${table} ${await countRows(lake, `SELECT COUNT(*) AS n FROM harbor.${table}`)}`);
  }, Promise.resolve());
};

const smokeRecall = async (): Promise<void> => {
  const pool = createTidbPool(process.env);
  try {
    await ensureSchema(pool, false);
    const [existing] = await rowsOf(pool, 'SELECT COUNT(*) AS n FROM episodic_memory');
    if (Number(existing?.n ?? 0) === 0) {
      const cases = PastCasesSchema.parse(JSON.parse(readFileSync(`${fixturesDirectory}/past-cases.json`, 'utf8')));
      await execute(pool, episodicInsert(cases));
    }
    const query = buildRecallQuery({ pattern: 'structuring', accountKind: 'retail', distinctBranches: 3 });
    const { value, ms } = await timed(() => recall(pool, query));
    out(`recall-ms ${ms.toFixed(0)}`);
    out(`recall-top ${value.map((hit) => hit.caseId).join(',')}`);
  } finally {
    await pool.end();
  }
};

const commands: Readonly<Record<string, () => Promise<void>>> = {
  fs: smokeFileSystem,
  branch: smokeBranch,
  lake: smokeLake,
  recall: smokeRecall,
};

const main = async (): Promise<void> => {
  const name = process.argv[2] ?? '';
  const command = commands[name];
  if (command === undefined) throw new Error(`usage: smoke.ts ${Object.keys(commands).join('|')}`);
  await command();
};

main()
  .catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
```

Run:

```bash
pnpm --filter @lab/demo-agent-aml typecheck
```

Expected: exit 0.

Live checks (each needs the matching resources and `.env`):

```bash
pnpm --filter @lab/demo-agent-aml smoke recall
```

Expected: `recall-ms <number>` then `recall-top` followed by three `PAST-` ids, with at least one of `PAST-001`, `PAST-003`, `PAST-011` among them. If the vector side is empty because the table has no TiFlash replica yet, wait a minute and rerun.

```bash
pnpm --filter @lab/demo-agent-aml smoke fs
```

Expected, in order: `layer-created <layer id>`, `diff-changes 1`, `base-before-commit absent`, `commit-ms <number>`, `base-after-commit present`, `journal-verify ok`, then `skills-seeded # Skill: structuring-triage`.

```bash
pnpm --filter @lab/demo-agent-aml smoke lake
```

Expected: `lake-setup-ok`, then `lake-txn_history 0`, `lake-ground_truth 0`, `lake-flag_log 0`, `lake-run_events 0` on a fresh database.

```bash
pnpm --filter @lab/demo-agent-aml smoke branch
```

Expected: `branch-created <branch id>`, `branch-create-seconds <number, usually minutes>`, `branch-tables <number>`, `branch-removed`. This is the live check for how the runner reaches a branch; if it fails on the host, user or password, record the finding in 13-V2 and fix `testRuleOnBranch` before continuing.

Commit:

```bash
git add demos/agent-aml/runner/src/live/cli.ts demos/agent-aml/runner/src/live/sinks.ts demos/agent-aml/runner/src/live/context.ts demos/agent-aml/runner/src/live/filesystem.ts demos/agent-aml/runner/src/live/lake.ts demos/agent-aml/runner/src/live/exports.ts demos/agent-aml/runner/smoke.ts
git commit -m "agent-aml demo: Filesystem, Lake and export adapters, smoke checks"
```

### Task 22: Setup and traffic flows

- [ ] Not started

`setup.ts` seeds everything, replays v1 over the history, exports the first Parquet batch, sets up Lake and checks the row counts. `traffic.ts` is one simulated day per tick plus the two injections; every evaluation publishes the planted-recall and false-positive metrics and the planted-coverage check.

`demos/agent-aml/runner/src/live/setup.ts`:

```typescript
import { quoteIdentifier, timed } from '@lab/runner-kit';
import { DAY_MS } from '../time';
import { createRng, deriveSeed } from '../prng';
import { buildPopulation, generateHistory, plantRapidInOut } from '../generator';
import { baselineRules, replayHistory } from '../rules';
import { countHistoryUpTo, resetLakeStatements } from '../lakeSql';
import { truthRow } from '../sinkRows';
import {
  ensureSchema,
  execute,
  insertAlerts,
  insertPeople,
  insertTransactions,
  insertTruth,
  maxTxnId,
  rowsOf,
  screenAccounts,
  serverNowMs,
  transactionCountUpTo,
} from '../starter';
import { episodicInsert, ruleUpsert, watchlistInsert } from '../starterSql';
import { errorMessage, type Context, type World } from './context';
import { seedFileSystem, seedVaultSecret } from './filesystem';
import { awaitRowCount, setupLake } from './lake';
import { clearLakePrefix, runTransactionExport } from './exports';

const isEmpty = async (ctx: Context, table: string): Promise<boolean> => {
  const [row] = await rowsOf(ctx.pool, `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)}`);
  return Number(row?.n ?? 0) === 0;
};

const seedReferenceData = async (ctx: Context): Promise<void> => {
  const { pool, config, fixtures } = ctx;
  await baselineRules(config.thresholdCents).reduce(async (previous, rule) => {
    await previous;
    await execute(pool, ruleUpsert(rule));
  }, Promise.resolve());
  await execute(
    pool,
    watchlistInsert(fixtures.watchlistNames.map((fullName) => ({ fullName, listTag: fixtures.watchlistTag }))),
  );
  await execute(pool, episodicInsert(fixtures.pastCases));
};

const seedFiles = async (ctx: Context): Promise<void> => {
  await seedFileSystem(ctx.fixtures.directory);
  await seedVaultSecret().catch((error: unknown) => {
    if (!/exist|already/i.test(errorMessage(error))) throw error;
  });
  ctx.emitter.node('case-layers', 'healthy', 'skills seeded under /harbor/skills');
  ctx.emitter.node('skills-base', 'healthy');
  ctx.emitter.node('vault', 'healthy', 'synthetic watchlist secret stored');
};

export const runSetup = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config } = ctx;
  emitter.phase('setup');
  ['txn-generator', 'harbor-core', 'rule-engine', 'agent-harness', 'episodic-memory'].forEach((node) =>
    emitter.node(node, 'starting'),
  );
  await ensureSchema(pool, config.reset);
  if (!(await isEmpty(ctx, 'transactions'))) {
    throw new Error('harbor_core already holds data; set AML_RESET=true to wipe and reseed it');
  }
  await seedReferenceData(ctx);
  emitter.node('episodic-memory', 'healthy', `${ctx.fixtures.pastCases.length} past cases embedded on insert`);
  await seedFiles(ctx);

  const population = buildPopulation({
    rng: createRng(deriveSeed(config.seed, 'population')),
    retailCount: config.retailCount,
    businessCount: config.businessCount,
    lookAlikeCount: config.lookAlikeCount,
    branchCount: config.branchCount,
  });
  const history = generateHistory({
    rng: createRng(deriveSeed(config.seed, 'history')),
    population,
    days: config.historyDays,
    firstDayStartMs: config.firstDayStartMs,
    firstTxnId: 1,
    thresholdCents: config.thresholdCents,
  });
  const rapid = plantRapidInOut({
    rng: createRng(deriveSeed(config.seed, 'rapid')),
    dayStartMs: config.firstDayStartMs + (config.historyDays - 20) * DAY_MS,
    firstTxnId: history.nextTxnId,
    accountNumber: 1,
    branchCount: config.branchCount,
  });
  const accounts = [...population.accounts, ...rapid.accounts];
  const transactions = [...history.transactions, ...rapid.transactions];
  const lastDayStartMs = config.firstDayStartMs + (config.historyDays - 1) * DAY_MS;

  await insertPeople(pool, accounts);
  const inserted = await insertTransactions(pool, transactions);
  await insertTruth(pool, rapid.truth);
  emitter.flow('txn-writes', inserted);
  emitter.log('info', `seeded ${accounts.length} accounts and ${inserted} synthetic transactions`, 'harbor-core');

  const watchlistCandidates = await screenAccounts(pool, accounts);
  const alerts = replayHistory({
    rules: baselineRules(config.thresholdCents),
    accounts,
    transactions,
    watchlistCandidates,
    firstDayStartMs: config.firstDayStartMs,
    lastDayStartMs,
    lookbackDays: 14,
  });
  const created = await insertAlerts(pool, alerts);
  emitter.flow('alerts-written', created);
  emitter.log('info', `baseline rules v1 replayed over history: ${created} alerts`, 'rule-engine');
  ['txn-generator', 'harbor-core', 'rule-engine', 'agent-harness'].forEach((node) => emitter.node(node, 'healthy'));

  const serverStartMs = await serverNowMs(pool);
  ctx.world.update(
    (): World => ({
      population,
      accounts,
      truth: rapid.truth,
      watchlistEntries: ctx.fixtures.watchlistNames.length,
      watchlistCandidates,
      nextTxnId: rapid.nextTxnId,
      lastDayStartMs,
      dayCounter: config.historyDays,
      ringCount: 0,
      ringAccountCount: 0,
      nearMatchCount: 0,
      exportedUpToTxnId: 0,
      lastAlertCommitWallMs: serverStartMs,
      runEventSeq: 0,
      flagsEmitted: 0,
      coverageStatus: 'pending',
    }),
  );

  emitter.check('lake-history-matches-export', 'pending');
  emitter.node('lake', 'busy', 'creating tables and the load task');
  await setupLake(ctx.lake, config);
  if (config.reset) {
    await clearLakePrefix(config);
    await resetLakeStatements.reduce(async (previous, sql) => {
      await previous;
      await ctx.lake.query(sql);
    }, Promise.resolve());
  }
  emitter.node('s3-bucket', 'busy', 'exporting transactions as Parquet');
  const cutoff = await maxTxnId(pool);
  const exported = await runTransactionExport({
    config,
    database: ctx.database,
    batch: 1,
    afterTxnId: 0,
    upToTxnId: cutoff,
    log: (message) => emitter.log('info', message, 's3-bucket'),
  });
  emitter.flow('parquet-export', 1);
  rapid.truth.forEach((entry) => ctx.sinks.truth.emit(truthRow(entry)));
  await ctx.sinks.truth.flush();
  const expected = await transactionCountUpTo(pool, cutoff);
  const loaded = await timed(() =>
    awaitRowCount({
      lake: ctx.lake,
      countSql: countHistoryUpTo(cutoff),
      expected,
      timeoutMs: 8 * 60_000,
      pollMs: 5000,
      kickEveryMs: 45_000,
    }),
  );
  emitter.flow('lake-load', loaded.value.observed);
  emitter.metric('lake-load-seconds', loaded.value.seconds);
  emitter.check(
    'lake-history-matches-export',
    loaded.value.reached && loaded.value.observed === expected ? 'pass' : 'fail',
    `Lake ${loaded.value.observed} rows, Starter ${expected} rows up to txn_id ${cutoff} (export ${exported.exportId})`,
  );
  emitter.node('s3-bucket', 'healthy');
  emitter.node('lake', 'healthy');
  ctx.world.update((world) => ({ ...world, exportedUpToTxnId: cutoff }));
};
```

`demos/agent-aml/runner/src/live/traffic.ts`:

```typescript
import { evaluateRules } from '../rules';
import { DAY_MS } from '../time';
import { createRng, deriveSeed } from '../prng';
import { generateDay, plantStructuringRing, plantWatchlistNearMatch } from '../generator';
import { sharesToken } from '../names';
import { plantedCoverage, scoreRules } from '../scorer';
import { truthRow } from '../sinkRows';
import { alertsPerMinute } from '../tickMath';
import {
  awaitWatchlistEntry,
  execute,
  insertAlerts,
  insertPeople,
  insertTransactions,
  insertTruth,
  nonPlantedTransactionCount,
  readActiveRules,
  readAlerts,
  readTransactionsSince,
  readTruth,
  screenAccounts,
  serverNowMs,
} from '../starter';
import { watchlistInsert } from '../starterSql';
import type { Context } from './context';

const LOOKBACK_DAYS = 14;

const publishScores = async (ctx: Context): Promise<void> => {
  const { emitter, pool } = ctx;
  const [alerts, truth, nonPlanted, rules] = await Promise.all([
    readAlerts(pool),
    readTruth(pool),
    nonPlantedTransactionCount(pool),
    readActiveRules(pool),
  ]);
  const scores = scoreRules({
    rules: rules.map((rule) => ({ ruleId: rule.ruleId, version: rule.version })),
    alerts,
    groundTruth: truth,
    nonPlantedTransactionCount: nonPlanted,
  });
  emitter.metric(
    'false-positives-per-1000',
    scores.reduce((sum, score) => sum + (score.falsePositivesPer1000 ?? 0), 0),
  );
  const coverage = plantedCoverage({ alerts, groundTruth: truth });
  if (coverage.recall !== undefined) emitter.metric('planted-recall', coverage.recall * 100);
  const status = coverage.missing.length === 0 ? 'pass' : 'fail';
  if (ctx.world.get().coverageStatus === status) return;
  ctx.world.update((world) => ({ ...world, coverageStatus: status }));
  emitter.check(
    'every-planted-case-flagged',
    status,
    `${coverage.flagged} of ${coverage.planted} planted accounts flagged by their own rule${coverage.missing.length === 0 ? '' : `; missing ${coverage.missing.join(', ')}`}`,
  );
};

const evaluateAndStore = async (ctx: Context, asOfMs: number): Promise<number> => {
  const { emitter, pool } = ctx;
  const world = ctx.world.get();
  const [rules, window] = await Promise.all([
    readActiveRules(pool),
    readTransactionsSince(pool, asOfMs - LOOKBACK_DAYS * DAY_MS),
  ]);
  emitter.flow('window-scans', window.length);
  const alerts = evaluateRules({
    rules,
    accounts: world.accounts,
    transactions: window,
    asOfMs,
    watchlistCandidates: world.watchlistCandidates,
  });
  const created = await insertAlerts(pool, alerts);
  emitter.flow('alerts-written', created);
  emitter.flow('alerts-to-agent', created);
  if (created > 0) {
    const committedAtMs = await serverNowMs(pool);
    ctx.world.update((current) => ({ ...current, lastAlertCommitWallMs: committedAtMs }));
  }
  await publishScores(ctx);
  return created;
};

export const baselineTick = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config } = ctx;
  const world = ctx.world.get();
  const dayStartMs = world.lastDayStartMs + DAY_MS;
  const day = generateDay({
    rng: createRng(deriveSeed(config.seed, `day-${world.dayCounter + 1}`)),
    dayStartMs,
    dayIndex: world.dayCounter + 1,
    population: world.population,
    firstTxnId: world.nextTxnId,
    thresholdCents: config.thresholdCents,
  });
  const inserted = await insertTransactions(pool, day.transactions);
  ctx.world.update((current) => ({
    ...current,
    nextTxnId: day.nextTxnId,
    lastDayStartMs: dayStartMs,
    dayCounter: current.dayCounter + 1,
  }));
  emitter.flow('txn-writes', inserted);
  const created = await evaluateAndStore(ctx, dayStartMs + DAY_MS - 1);
  emitter.metric('alerts-per-minute', alertsPerMinute({ newAlerts: created, tickWallMs: config.tickMs }));
};

export const injectStructuringRing = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config } = ctx;
  const world = ctx.world.get();
  emitter.phase('inject-pattern');
  const ringNumber = world.ringCount + 1;
  const planted = plantStructuringRing({
    rng: createRng(deriveSeed(config.seed, `ring-${ringNumber}`)),
    lastDayStartMs: world.lastDayStartMs,
    firstTxnId: world.nextTxnId,
    firstAccountNumber: world.ringAccountCount + 1,
    ringSize: 3,
    thresholdCents: config.thresholdCents,
    branchCount: config.branchCount,
  });
  await insertPeople(pool, planted.accounts);
  const inserted = await insertTransactions(pool, planted.transactions);
  await insertTruth(pool, planted.truth);
  planted.truth.forEach((entry) => ctx.sinks.truth.emit(truthRow(entry)));
  await ctx.sinks.truth.flush();
  ctx.world.update((current) => ({
    ...current,
    accounts: [...current.accounts, ...planted.accounts],
    truth: [...current.truth, ...planted.truth],
    nextTxnId: planted.nextTxnId,
    ringCount: ringNumber,
    ringAccountCount: current.ringAccountCount + planted.accounts.length,
    coverageStatus: 'pending',
  }));
  emitter.flow('txn-writes', inserted);
  emitter.check('every-planted-case-flagged', 'pending');
  emitter.log('info', `planted a ${planted.accounts.length}-account structuring ring with ground truth`, 'txn-generator');
  emitter.phase('alert');
  const created = await evaluateAndStore(ctx, world.lastDayStartMs + DAY_MS - 1);
  emitter.log('info', `rule engine raised ${created} new alerts after the injection`, 'rule-engine');
};

export const injectWatchlistNearMatch = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config, fixtures } = ctx;
  const world = ctx.world.get();
  emitter.phase('inject-pattern');
  const planted = plantWatchlistNearMatch({
    rng: createRng(deriveSeed(config.seed, `near-match-${world.nearMatchCount + 1}`)),
    accounts: world.accounts,
    firstEntryId: world.watchlistEntries + 1,
    injectedAtMs: world.lastDayStartMs,
    listTag: `${fixtures.watchlistTag}-UPDATE`,
  });
  await execute(pool, watchlistInsert([{ fullName: planted.entry.fullName, listTag: planted.entry.listTag }]));
  await insertTruth(pool, [planted.truth]);
  const visible = await awaitWatchlistEntry(pool, planted.entry.fullName);
  if (!visible) emitter.log('warn', 'the new watchlist entry is not visible to full-text search yet', 'harbor-core');
  ctx.sinks.truth.emit(truthRow(planted.truth));
  await ctx.sinks.truth.flush();
  const affected = world.accounts.filter((account) => sharesToken(account.holderName, planted.entry.fullName));
  const rescreened = await screenAccounts(pool, affected);
  ctx.world.update((current) => ({
    ...current,
    truth: [...current.truth, planted.truth],
    watchlistEntries: current.watchlistEntries + 1,
    watchlistCandidates: new Map([...current.watchlistCandidates, ...rescreened]),
    nearMatchCount: current.nearMatchCount + 1,
    coverageStatus: 'pending',
  }));
  emitter.check('every-planted-case-flagged', 'pending');
  emitter.log('info', 'a synthetic watchlist update arrived; rescreening accounts that share a name token', 'txn-generator');
  emitter.phase('alert');
  const created = await evaluateAndStore(ctx, world.lastDayStartMs + DAY_MS - 1);
  emitter.log('info', `rule engine raised ${created} new alerts after the list update`, 'rule-engine');
};
```

Run:

```bash
pnpm --filter @lab/demo-agent-aml typecheck
```

Expected: exit 0.

Commit:

```bash
git add demos/agent-aml/runner/src/live/setup.ts demos/agent-aml/runner/src/live/traffic.ts
git commit -m "agent-aml demo: setup and traffic flows"
```

### Task 23: Investigation and learning flows

- [ ] Not started

`investigate.ts` opens the case (layer, journal, grant, branch overlapped with the playbook steps) and runs the rule test on the branch. `learn.ts` records simulated verdicts, runs the Lake evaluation, stages the skill update in a layer and, on promote, commits it, writes the lesson and verifies the journal.

`demos/agent-aml/runner/src/live/investigate.ts`:

```typescript
import { branches, rfc3339Second, tiFs, type BranchInfo } from '@lab/agent-stack-kit';
import { createTidbPool, timed } from '@lab/runner-kit';
import { branchEnv, branchUser } from '../branchEnv';
import { pointInTimeMs } from '../branchPlan';
import type { Alert } from '../domain';
import { stepsFor, type StepId } from '../fixtures';
import { branchNameFor, casePathFor } from '../journal';
import { buildBandPeersSql, buildAccountLookbackSql, lookbackMonthsToMs } from '../lakeSql';
import { buildRecallQuery, type RecallHit } from '../recallSql';
import { replayHistory, candidateStructuring } from '../rules';
import { DAY_MS, startOfDay } from '../time';
import { elapsedSeconds } from '../tickMath';
import {
  alertVolume,
  execute,
  insertAlerts,
  nonPlantedTransactionCount,
  probeIsolation,
  serverNowMs,
  readAccounts,
  readAlerts,
  readActiveRules,
  readEntityFacts,
  readTransactionsSince,
  readTruth,
  recall,
} from '../starter';
import { caseInsert, ruleUpsert } from '../starterSql';
import { compareRuleVersions, evaluateIsolation } from '../whatIf';
import {
  buildWorkingSet,
  caseIdFor,
  pickCaseAlert,
  renderDraftReport,
  renderNotes,
  summarizePeers,
  type CaseWorkingSet,
  type PeerSummary,
} from '../workingSet';
import { errorMessage, type CaseRecord, type Context } from './context';
import {
  SYNTHETIC_SECRET_VALUE,
  appendCaseJournal,
  openCaseWorkspace,
  readSecretWithGrant,
  writeLayerFile,
  type CaseWorkspace,
} from './filesystem';
import { timedQuery } from './lake';

type StepState = {
  readonly caseId: string;
  readonly alert: Alert;
  readonly workspace: CaseWorkspace;
  readonly peers: PeerSummary | undefined;
  readonly hits: readonly RecallHit[];
  readonly workingSet: CaseWorkingSet | undefined;
};

type Handler = (state: StepState) => Promise<StepState>;

const FIRST_BAND_PCT = 0.9;

const upsertCase = (ctx: Context, record: CaseRecord): void => {
  ctx.cases.update((current) => [...current.filter((item) => item.caseId !== record.caseId), record]);
};

const loadWorkingSetStep = (ctx: Context): Handler => async (state) => {
  const { emitter, pool } = ctx;
  const [accounts, window] = await Promise.all([
    readAccounts(pool),
    readTransactionsSince(pool, state.alert.windowEndMs - 14 * DAY_MS),
  ]);
  const account = accounts.find((item) => item.accountId === state.alert.accountId);
  if (account === undefined) throw new Error(`account ${state.alert.accountId} not found`);
  const facts = await readEntityFacts(pool, account.accountId);
  const flaggedBranches = new Set(
    window.filter((txn) => state.alert.txnIds.includes(txn.txnId)).map((txn) => txn.branchCode),
  );
  return {
    ...state,
    workingSet: buildWorkingSet({
      caseId: state.caseId,
      alert: state.alert,
      account,
      windowTransactions: window,
      recallHits: [],
      peers: state.peers ?? { accountsWithBandActivity: 0, singleBranchAccounts: 0 },
      facts: { ...facts, flagged_branches: String(flaggedBranches.size) },
    }),
  };
};

const recallStep = (ctx: Context): Handler => async (state) => {
  const { emitter, pool } = ctx;
  emitter.phase('recall-similar-cases');
  const workingSet = state.workingSet;
  if (workingSet === undefined) throw new Error('working set must be loaded before recall');
  const queryText = buildRecallQuery({
    pattern: workingSet.pattern,
    accountKind: workingSet.accountKind,
    distinctBranches: workingSet.distinctBranches,
  });
  const { value, ms } = await timed(() => recall(pool, queryText));
  emitter.metric('hybrid-recall-ms', ms);
  emitter.flow('recall-queries', 1);
  emitter.log('info', `hybrid recall returned ${value.length} similar cases in ${ms.toFixed(0)} ms`, 'episodic-memory');
  await appendCaseJournal({ caseId: state.caseId, type: 'recall.completed', summary: `${value.length} similar cases` });
  emitter.flow('audit-entries', 1);
  return { ...state, hits: value, workingSet: { ...workingSet, priorCases: value.map((hit) => ({ caseId: hit.caseId, pattern: hit.pattern, outcome: hit.outcome, rrfScore: hit.rrfScore })) } };
};

const lookbackStep = (ctx: Context): Handler => async (state) => {
  const { emitter, lake, config } = ctx;
  const untilMs = startOfDay(state.alert.windowEndMs) + DAY_MS;
  const sinceMs = untilMs - lookbackMonthsToMs(config.lookbackMonths);
  const thresholdCents = config.thresholdCents;
  const sql =
    state.alert.ruleId === 'structuring'
      ? buildBandPeersSql({
          lowerCents: Math.floor(thresholdCents * FIRST_BAND_PCT),
          upperCents: thresholdCents,
          sinceMs,
          untilMs,
          minDeposits: 3,
        })
      : buildAccountLookbackSql({ accountId: state.alert.accountId, sinceMs, untilMs });
  const { value, ms } = await timedQuery(lake, sql);
  emitter.metric('lake-lookback-ms', ms);
  emitter.flow('lookback-queries', 1);
  const peers = summarizePeers(value);
  emitter.log(
    'info',
    `Lake lookback over ${config.lookbackMonths} months: ${value.length} rows in ${ms.toFixed(0)} ms (${peers.singleBranchAccounts} single-branch peers)`,
    'lake',
  );
  await appendCaseJournal({ caseId: state.caseId, type: 'lookback.completed', summary: `${value.length} history rows` });
  emitter.flow('audit-entries', 1);
  return { ...state, peers };
};

const writeEvidenceStep = (ctx: Context): Handler => async (state) => {
  const { emitter } = ctx;
  const workingSet = state.workingSet;
  if (workingSet === undefined) throw new Error('working set must exist before evidence is written');
  const base = casePathFor(state.caseId);
  const finalSet: CaseWorkingSet = {
    ...workingSet,
    peers: state.peers ?? workingSet.peers,
  };
  await writeLayerFile({ layerId: state.workspace.layerId, remotePath: `${base}/working-set.json`, content: JSON.stringify(finalSet, null, 2) });
  await writeLayerFile({ layerId: state.workspace.layerId, remotePath: `${base}/notes.md`, content: renderNotes(finalSet) });
  await writeLayerFile({ layerId: state.workspace.layerId, remotePath: `${base}/draft-report.md`, content: renderDraftReport(finalSet) });
  emitter.flow('evidence-writes', 3);
  const diff = await tiFs.diffLayer({ layerId: state.workspace.layerId });
  emitter.log('info', `case layer holds ${diff.length} uncommitted changes; the base file system is untouched`, 'case-layers');
  await appendCaseJournal({ caseId: state.caseId, type: 'evidence.written', summary: `${diff.length} files in the case layer` });
  emitter.flow('audit-entries', 1);
  return { ...state, workingSet: finalSet };
};

const awaitOperatorStep = (ctx: Context): Handler => async (state) => {
  ctx.emitter.log('info', 'evidence is ready; Test rule on branch works once the investigation branch is active', 'agent-harness');
  return state;
};

const handlers = (ctx: Context): Readonly<Record<StepId, Handler>> => ({
  'load-working-set': loadWorkingSetStep(ctx),
  'recall-similar-cases': recallStep(ctx),
  'lake-lookback': lookbackStep(ctx),
  'write-evidence': writeEvidenceStep(ctx),
  'test-rule-on-branch': awaitOperatorStep(ctx),
});

export const openInvestigation = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config, fixtures } = ctx;
  const startedAt = Date.now();
  const alerts = await readAlerts(pool);
  const picked = pickCaseAlert({
    alerts,
    preferred: 'structuring',
    excludeAccounts: ctx.cases.get().map((item) => item.alert.accountId),
  });
  if (picked === undefined) {
    emitter.log('warn', 'no open alert to investigate; inject a pattern first', 'agent-harness');
    return;
  }
  const caseId = caseIdFor(ctx.cases.get().length + 1);
  emitter.phase('open-investigation');
  emitter.node('agent-harness', 'busy', `opening ${caseId}`);
  ['case-layers', 'case-journal', 'vault'].forEach((node) => emitter.node(node, 'busy'));
  emitter.node('investigation-branch', 'starting', 'branch creation takes minutes');

  const branchStartedAt = Date.now();
  const pointInTime = pointInTimeMs({
    committedAtMs: ctx.world.get().lastAlertCommitWallMs,
    nowMs: await serverNowMs(pool),
  });
  const branch = await branches.create({
    clusterId: config.clusterId,
    name: branchNameFor(caseId),
    parentTimestamp: rfc3339Second(new Date(pointInTime)),
  });
  emitter.flow('branch-create', 1);
  const branchReady: Promise<BranchInfo> = branches.waitActive({
    clusterId: config.clusterId,
    branchId: branch.branchId,
    timeoutMs: 15 * 60_000,
  });
  branchReady.catch(() => undefined);

  const workspace = await openCaseWorkspace(caseId);
  const layerSeconds = elapsedSeconds(startedAt, Date.now());
  emitter.metric('layer-open-seconds', layerSeconds);
  emitter.flow('vault-grants', 1);
  const secret = await readSecretWithGrant(workspace.grantToken);
  emitter.log(
    secret === SYNTHETIC_SECRET_VALUE ? 'info' : 'warn',
    secret === SYNTHETIC_SECRET_VALUE
      ? 'delegated 10 minute read of the synthetic watchlist secret succeeded'
      : 'delegated read did not return the synthetic secret',
    'vault',
  );
  await appendCaseJournal({ caseId, type: 'case.opened', summary: `layer ${workspace.layerId}, branch ${branch.branchId}` });
  await appendCaseJournal({ caseId, type: 'grant.issued', summary: 'read grant on watchlist-api/KEY, ttl 10m' });
  emitter.flow('audit-entries', 2);
  emitter.check('journal-verifies', 'pending');
  emitter.node('case-layers', 'healthy');
  emitter.node('case-journal', 'healthy');
  emitter.node('vault', 'healthy');
  await execute(
    pool,
    caseInsert({
      caseId,
      accountId: picked.accountId,
      pattern: picked.ruleId,
      openedAtMs: Date.now(),
      layerId: workspace.layerId,
      branchId: branch.branchId,
      journalId: `jrn-${caseId.toLowerCase()}`,
    }),
  );
  upsertCase(ctx, {
    caseId,
    alert: picked,
    layerId: workspace.layerId,
    grantToken: workspace.grantToken,
    branchEndpoint: undefined,
    workingSet: undefined,
    whatIf: undefined,
    shadowAlerts: [],
    skillLayerId: undefined,
    distilled: undefined,
    skillPath: undefined,
    lakeRecallV2: undefined,
  });

  const steps = stepsFor(picked.ruleId, fixtures.playbook);
  const table = handlers(ctx);
  const initial: StepState = { caseId, alert: picked, workspace, peers: undefined, hits: [], workingSet: undefined };
  const finished = await steps.reduce<Promise<StepState>>(
    async (previous, step) => table[step](await previous),
    Promise.resolve(initial),
  );

  emitter.log('info', `waiting for branch ${branch.branchId} to become active`, 'investigation-branch');
  const endpoint = await branchReady;
  const branchSeconds = elapsedSeconds(branchStartedAt, Date.now());
  emitter.metric('branch-create-seconds', branchSeconds);
  emitter.metric('investigation-open-time', elapsedSeconds(startedAt, Date.now()));
  emitter.node('investigation-branch', 'healthy', 'branch active');
  emitter.node('agent-harness', 'healthy', `${caseId} ready for rule test`);
  await appendCaseJournal({ caseId, type: 'branch.ready', summary: `branch active after ${branchSeconds.toFixed(0)} seconds` });
  emitter.flow('audit-entries', 1);
  upsertCase(ctx, {
    caseId,
    alert: picked,
    layerId: workspace.layerId,
    grantToken: workspace.grantToken,
    branchEndpoint: endpoint,
    workingSet: finished.workingSet,
    whatIf: undefined,
    shadowAlerts: [],
    skillLayerId: undefined,
    distilled: undefined,
    skillPath: undefined,
    lakeRecallV2: undefined,
  });
};

export const testRuleOnBranch = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config } = ctx;
  const record = ctx.cases.get().at(-1);
  if (record?.branchEndpoint === undefined) {
    emitter.log('warn', 'open an investigation and wait for its branch before testing a rule', 'agent-harness');
    return;
  }
  const endpoint = record.branchEndpoint;
  emitter.phase('test-rule-on-branch');
  emitter.node('investigation-branch', 'busy', 'testing candidate rule v2');
  if (endpoint.host === undefined || endpoint.port === undefined) {
    throw new Error('the branch did not report a host and port; see Packet 13-V2');
  }
  const branchPool = createTidbPool(
    branchEnv({
      base: process.env,
      host: endpoint.host,
      port: endpoint.port,
      user: branchUser({ userPrefix: endpoint.userPrefix, user: process.env.TIDB_USER ?? '' }),
      password: config.branchPassword === '' ? (process.env.TIDB_PASSWORD ?? '') : config.branchPassword,
      database: ctx.database,
    }),
  );
  try {
    const candidate = candidateStructuring(config.thresholdCents);
    await execute(branchPool, ruleUpsert(candidate));
    emitter.flow('what-if-queries', 1);
    const [transactions, accounts, truth] = await Promise.all([
      readTransactionsSince(branchPool, 0),
      readAccounts(branchPool),
      readTruth(branchPool),
    ]);
    emitter.flow('what-if-queries', 3);
    const lastDayStartMs = startOfDay(transactions.reduce((latest, txn) => Math.max(latest, txn.txnTsMs), 0));
    const shadowAlerts = replayHistory({
      rules: [candidate],
      accounts,
      transactions,
      watchlistCandidates: ctx.world.get().watchlistCandidates,
      firstDayStartMs: config.firstDayStartMs,
      lastDayStartMs,
      lookbackDays: 14,
    });
    await insertAlerts(branchPool, shadowAlerts);
    const volume = await alertVolume(branchPool, 'structuring');
    const [branchAlerts, nonPlanted, branchRules] = await Promise.all([
      readAlerts(branchPool),
      nonPlantedTransactionCount(branchPool),
      readActiveRules(branchPool),
    ]);
    emitter.flow('what-if-queries', 3);
    const result = compareRuleVersions({
      ruleId: 'structuring',
      baselineVersion: 'v1',
      candidateVersion: 'v2',
      alerts: branchAlerts,
      groundTruth: truth,
      nonPlantedTransactionCount: nonPlanted,
    });
    const delta = (volume.get('v2') ?? 0) - (volume.get('v1') ?? 0);
    emitter.metric('rule-change-alert-delta', delta);
    emitter.log(
      delta === result.alertDelta ? 'info' : 'warn',
      `branch alert counts: v1 ${volume.get('v1') ?? 0}, v2 ${volume.get('v2') ?? 0}; decision ${result.decision} (${result.reason}); branch holds ${branchRules.length} active rules`,
      'investigation-branch',
    );
    const [production, onBranch] = await Promise.all([probeIsolation(pool), probeIsolation(branchPool)]);
    const isolation = evaluateIsolation({ production, branch: onBranch });
    emitter.check('investigation-branch-isolated', isolation.isolated ? 'pass' : 'fail', isolation.observed);
    await appendCaseJournal({
      caseId: record.caseId,
      type: 'rule.what-if.completed',
      summary: `structuring v1 ${result.baselineAlerts} to v2 ${result.candidateAlerts} alerts, decision ${result.decision}`,
    });
    emitter.flow('audit-entries', 1);
    upsertCase(ctx, { ...record, whatIf: result, shadowAlerts });
    emitter.node('investigation-branch', 'done', 'what-if complete');
  } catch (error) {
    emitter.log('error', `rule test failed: ${errorMessage(error)}`, 'investigation-branch');
    emitter.node('investigation-branch', 'degraded', errorMessage(error));
    throw error;
  } finally {
    await Promise.race([branchPool.end(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
};
```

`demos/agent-aml/runner/src/live/learn.ts`:

```typescript
import { tiFs } from '@lab/agent-stack-kit';
import { timed } from '@lab/runner-kit';
import type { Alert } from '../domain';
import { buildExportWhere } from '../exportPlan';
import { composeLesson } from '../lesson';
import { journalIdFor, skillsPath } from '../journal';
import { buildRecallQuery } from '../recallSql';
import { countHistoryUpTo, buildPlantedRecallSql, parsePlantedRecall, parseRuleEval, ruleEvalSql, type LakeRuleEval } from '../lakeSql';
import { candidateStructuring, baselineRules } from '../rules';
import { simulateVerdict } from '../scorer';
import { distillSkill, describeRuleChange, lintSkill, type SkillEvidence } from '../skills';
import { flagRow, runEventRow, type FlagScope } from '../sinkRows';
import { skillFileFor } from '../fixtures';
import {
  execute,
  awaitRecallOf,
  maxTxnId,
  readAlerts,
  readTruth,
  recall,
  transactionCountUpTo,
} from '../starter';
import { episodicInsert } from '../starterSql';
import type { CaseRecord, Context } from './context';
import { appendCaseJournal, readBaseFile, writeLayerFile } from './filesystem';
import { awaitRowCount, timedQuery } from './lake';
import { runTransactionExport } from './exports';

const replaceCase = (ctx: Context, record: CaseRecord): void => {
  ctx.cases.update((current) => [...current.filter((item) => item.caseId !== record.caseId), record]);
};

const latestCase = (ctx: Context): CaseRecord | undefined => ctx.cases.get().at(-1);

const emitRunEvent = (ctx: Context, caseId: string, kind: string, detail: string): void => {
  const world = ctx.world.update((current) => ({ ...current, runEventSeq: current.runEventSeq + 1 }));
  ctx.sinks.run.emit(runEventRow({ runId: ctx.runId, seq: world.runEventSeq, kind, caseId, detail, atMs: Date.now() }));
};

const emitFlags = (ctx: Context, alerts: readonly Alert[], scope: FlagScope, truth: Awaited<ReturnType<typeof readTruth>>): number => {
  alerts.forEach((alert) =>
    ctx.sinks.flags.emit(flagRow({ runId: ctx.runId, alert, scope, verdict: simulateVerdict(alert, truth) })),
  );
  return alerts.length;
};

export const recordVerdicts = async (ctx: Context): Promise<void> => {
  const { emitter, pool } = ctx;
  const record = latestCase(ctx);
  if (record === undefined) return;
  emitter.phase('analyst-verdict');
  emitter.node('agent-harness', 'busy', 'simulated analyst verdicts');
  const [production, truth] = await Promise.all([readAlerts(pool), readTruth(pool)]);
  const productionFlags = emitFlags(ctx, production.filter((alert) => alert.ruleVersion === 'v1'), 'production', truth);
  const shadowFlags = emitFlags(ctx, record.shadowAlerts, 'branch-shadow', truth);
  const confirmed = production.filter((alert) => simulateVerdict(alert, truth) === 'confirmed').length;
  emitRunEvent(ctx, record.caseId, 'verdicts.recorded', `${productionFlags} production flags, ${shadowFlags} branch shadow flags`);
  await ctx.sinks.flags.flush();
  await ctx.sinks.run.flush();
  ctx.world.update((current) => ({ ...current, flagsEmitted: current.flagsEmitted + productionFlags + shadowFlags }));
  emitter.flow('run-events', productionFlags + shadowFlags + 1);
  emitter.log(
    'info',
    `simulated analyst verdicts (derived from planted ground truth, labeled simulated): ${confirmed} confirmed, ${production.length - confirmed} false positives`,
    'agent-harness',
  );
  await appendCaseJournal({ caseId: record.caseId, type: 'verdict.recorded', summary: 'simulated verdicts from ground truth' });
  emitter.flow('audit-entries', 1);
};

const precisionOf = (rows: readonly LakeRuleEval[], scope: string, version: string): number | undefined =>
  rows.find((row) => row.ruleId === 'structuring' && row.scope === scope && row.ruleVersion === version)?.precision;

export type LakeEvidence = {
  readonly baselinePrecision: number | undefined;
  readonly candidatePrecision: number | undefined;
  readonly candidateRecall: number | undefined;
};

export const evaluateInLake = async (ctx: Context): Promise<LakeEvidence> => {
  const { emitter, pool, config, lake } = ctx;
  emitter.phase('lake-eval');
  emitter.node('s3-bucket', 'busy', 'second Parquet export');
  const cutoff = await maxTxnId(pool);
  const world = ctx.world.get();
  const exported = await runTransactionExport({
    config,
    database: ctx.database,
    batch: 2,
    afterTxnId: world.exportedUpToTxnId,
    upToTxnId: cutoff,
    log: (message) => emitter.log('info', `${message} [${buildExportWhere({ afterTxnId: world.exportedUpToTxnId, upToTxnId: cutoff })}]`, 's3-bucket'),
  });
  emitter.flow('parquet-export', 1);
  emitter.check('lake-history-matches-export', 'pending');
  emitter.node('lake', 'busy', 'loading exports and events');
  const expected = await transactionCountUpTo(pool, cutoff);
  const loaded = await awaitRowCount({
    lake,
    countSql: countHistoryUpTo(cutoff),
    expected,
    timeoutMs: 8 * 60_000,
    pollMs: 5000,
    kickEveryMs: 45_000,
  });
  const flagsLoaded = await awaitRowCount({
    lake,
    countSql: 'SELECT COUNT(*) AS n FROM harbor.flag_log',
    expected: ctx.world.get().flagsEmitted,
    timeoutMs: 5 * 60_000,
    pollMs: 5000,
    kickEveryMs: 45_000,
  });
  emitter.flow('lake-load', loaded.observed + flagsLoaded.observed);
  emitter.metric('lake-load-seconds', loaded.seconds);
  emitter.check(
    'lake-history-matches-export',
    loaded.reached && loaded.observed === expected ? 'pass' : 'fail',
    `Lake ${loaded.observed} rows, Starter ${expected} rows up to txn_id ${cutoff} (export ${exported.exportId}); flag_log ${flagsLoaded.observed} of ${ctx.world.get().flagsEmitted}`,
  );
  ctx.world.update((current) => ({ ...current, exportedUpToTxnId: cutoff }));

  const evalQuery = await timedQuery(lake, ruleEvalSql);
  const rows = parseRuleEval(evalQuery.value);
  const recallV2 = parsePlantedRecall(await lake.query(buildPlantedRecallSql('v2'))).find((row) => row.pattern === 'structuring');
  emitter.flow('lookback-queries', 2);
  const baselinePrecision = precisionOf(rows, 'production', 'v1');
  const candidatePrecision = precisionOf(rows, 'branch-shadow', 'v2');
  if (baselinePrecision !== undefined) emitter.metric('precision-v1-simulated', baselinePrecision * 100);
  if (candidatePrecision !== undefined) emitter.metric('precision-v2-simulated', candidatePrecision * 100);
  emitter.log(
    'info',
    `Lake eval in ${evalQuery.ms.toFixed(0)} ms: ${rows.map((row) => `${row.ruleId} ${row.ruleVersion} ${row.scope} flags ${row.flags} confirmed ${row.confirmed}`).join('; ')}`,
    'lake',
  );
  emitter.node('s3-bucket', 'healthy');
  emitter.node('lake', 'healthy');
  return { baselinePrecision, candidatePrecision, candidateRecall: recallV2?.recall };
};

export const stageSkillUpdate = async (ctx: Context, lakeEvidence: LakeEvidence): Promise<void> => {
  const { emitter, config } = ctx;
  const record = latestCase(ctx);
  if (record?.whatIf === undefined) {
    emitter.log('warn', 'run the rule test before distilling a skill', 'agent-harness');
    return;
  }
  emitter.phase('distill-commit-skill');
  emitter.node('skills-base', 'busy', 'distilling a skill update in a layer');
  const skillPath = `${skillsPath}/${skillFileFor(record.alert.ruleId)}`;
  const baseline = baselineRules(config.thresholdCents).find((rule) => rule.ruleId === 'structuring');
  const candidate = candidateStructuring(config.thresholdCents);
  if (baseline?.ruleId !== 'structuring' || candidate.ruleId !== 'structuring') throw new Error('structuring rules not found');
  const evidence: SkillEvidence = {
    ruleId: 'structuring',
    baselineVersion: 'v1',
    candidateVersion: 'v2',
    changeSummary: describeRuleChange(baseline.params, candidate.params),
    baselineAlerts: record.whatIf.baselineAlerts,
    candidateAlerts: record.whatIf.candidateAlerts,
    baselinePrecision: lakeEvidence.baselinePrecision,
    candidatePrecision: lakeEvidence.candidatePrecision,
    candidateRecall: lakeEvidence.candidateRecall,
  };
  const current = await readBaseFile(skillPath);
  const distilled = distillSkill({ skillText: current, evidence });
  const layer = await tiFs.createLayer({
    baseRootPath: skillsPath,
    layerName: `skill-${record.caseId.toLowerCase()}`,
    tags: { case: record.caseId },
  });
  await writeLayerFile({ layerId: layer.layerId, remotePath: skillPath, content: distilled.text });
  emitter.flow('evidence-writes', 1);
  const diff = await tiFs.diffLayer({ layerId: layer.layerId });
  emitter.log(
    distilled.lintErrors.length === 0 ? 'info' : 'warn',
    `skill update staged in layer ${layer.layerId}: ${diff.length} change, lint ${distilled.lintErrors.length === 0 ? 'clean' : distilled.lintErrors.join('; ')}. Press Promote skill to commit it to the base file system.`,
    'skills-base',
  );
  await appendCaseJournal({ caseId: record.caseId, type: 'skill.staged', summary: `${skillPath} staged in layer ${layer.layerId}` });
  emitter.flow('audit-entries', 1);
  replaceCase(ctx, { ...record, skillLayerId: layer.layerId, distilled, skillPath, lakeRecallV2: lakeEvidence.candidateRecall });
  emitter.node('skills-base', 'degraded', 'awaiting human approval to promote');
};

const describeChange = (ctx: Context): string => {
  const baseline = baselineRules(ctx.config.thresholdCents).find((rule) => rule.ruleId === 'structuring');
  const candidate = candidateStructuring(ctx.config.thresholdCents);
  if (baseline?.ruleId !== 'structuring' || candidate.ruleId !== 'structuring') return 'no parameter change';
  return describeRuleChange(baseline.params, candidate.params);
};

export const promoteSkill = async (ctx: Context): Promise<void> => {
  const { emitter, pool } = ctx;
  const record = latestCase(ctx);
  if (record?.skillLayerId === undefined || record.distilled === undefined || record.skillPath === undefined || record.whatIf === undefined) {
    emitter.log('warn', 'no staged skill update to promote', 'skills-base');
    return;
  }
  const recallHeld = (record.lakeRecallV2 ?? 0) >= (record.whatIf.baseline.recall ?? 0);
  const lintErrors = lintSkill(record.distilled.text);
  if (record.whatIf.decision !== 'adopt' || !recallHeld || lintErrors.length > 0) {
    emitter.log('warn', `promotion blocked: decision ${record.whatIf.decision}, recall held ${recallHeld}, lint ${lintErrors.join('; ') || 'clean'}`, 'skills-base');
    return;
  }
  emitter.check('skill-commit-lands-on-base', 'pending');
  const skillLayerId = record.skillLayerId;
  const { ms } = await timed(() => tiFs.commitLayer({ layerId: skillLayerId }));
  const onBase = await readBaseFile(record.skillPath);
  const landed = onBase.trim() === record.distilled.text.trim();
  emitter.flow('skill-commits', 1);
  emitter.check(
    'skill-commit-lands-on-base',
    landed ? 'pass' : 'fail',
    `commit-layer took ${ms.toFixed(0)} ms; base ${record.skillPath} ${landed ? 'matches' : 'does not match'} the staged skill`,
  );
  emitter.node('skills-base', 'healthy', 'skill committed by a human decision');
  await appendCaseJournal({ caseId: record.caseId, type: 'skill.promoted', summary: `${record.skillPath} committed to the base file system` });
  emitter.flow('audit-entries', 1);
  emitRunEvent(ctx, record.caseId, 'skill.promoted', record.skillPath);

  emitter.phase('lesson-to-memory');
  emitter.node('episodic-memory', 'busy', 'writing the lesson');
  const lesson = composeLesson({
    caseId: record.caseId,
    pattern: record.alert.ruleId,
    whatIf: record.whatIf,
    changeSummary: describeChange(ctx),
  });
  await execute(pool, episodicInsert([lesson]));
  emitter.flow('lesson-written', 1);
  const queryText = buildRecallQuery({
    pattern: record.alert.ruleId,
    accountKind: record.workingSet?.accountKind ?? 'retail',
    distinctBranches: record.workingSet?.distinctBranches ?? 3,
  });
  const hits = await awaitRecallOf(pool, queryText, record.caseId);
  const recallTiming = await timed(() => recall(pool, queryText));
  emitter.metric('hybrid-recall-ms', recallTiming.ms);
  emitter.flow('recall-queries', 1);
  const rank = hits.findIndex((hit) => hit.caseId === record.caseId) + 1;
  emitter.log('info', rank > 0 ? `the new lesson is retrievable: rank ${rank} of ${hits.length}` : 'the new lesson is not in the top results yet', 'episodic-memory');
  emitter.node('episodic-memory', 'healthy');

  await appendCaseJournal({ caseId: record.caseId, type: 'lesson.recorded', summary: `lesson stored for ${record.caseId}` });
  emitter.flow('audit-entries', 1);
  await ctx.sinks.run.flush();
  const verified = await tiFs.verifyJournal({ journalId: journalIdFor(record.caseId) });
  emitter.check('journal-verifies', verified.ok ? 'pass' : 'fail', verified.ok ? 'hash chain verified' : 'verify-journal reported a problem');
  emitter.node('agent-harness', 'done', `${record.caseId} complete`);
};
```

Run:

```bash
pnpm --filter @lab/demo-agent-aml typecheck
```

Expected: exit 0.

Commit:

```bash
git add demos/agent-aml/runner/src/live/investigate.ts demos/agent-aml/runner/src/live/learn.ts
git commit -m "agent-aml demo: investigation and learning flows"
```

### Task 24: Entry point, teardown and the emitted-ids guard

- [ ] Not started

`demos/agent-aml/test/emitted-ids.test.ts` reads `runner/main.ts` and every `runner/src/live/*.ts` and proves that every emitted metric, edge, node, phase, check and log node id exists in the manifest, and that every manifest edge, metric, phase and check is emitted somewhere. It is the guard that caught an unemitted edge in Plan 06.

```typescript
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifestJson from '../manifest.json';

const manifest = DemoManifestSchema.parse(manifestJson);
const runnerDirectory = fileURLToPath(new URL('../runner/', import.meta.url));
const liveDirectory = `${runnerDirectory}src/live/`;
const sourceFiles = [
  `${runnerDirectory}main.ts`,
  ...readdirSync(liveDirectory)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `${liveDirectory}${file}`),
];
const source = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

const manifestIdSets = {
  metric: new Set(manifest.metrics.map((item) => item.id)),
  flow: new Set(manifest.edges.map((item) => item.id)),
  node: new Set(manifest.nodes.map((item) => item.id)),
  phase: new Set(manifest.phases.map((item) => item.id)),
  check: new Set(manifest.checks.map((item) => item.id)),
};

const findCallBodies = (text: string, method: string): readonly string[] => {
  const marker = `emitter.${method}(`;
  const bodies: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(marker, searchFrom);
    if (start === -1) break;
    let depth = 1;
    let index = start + marker.length;
    let quote: '"' | "'" | '`' | undefined;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (quote !== undefined) {
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      index += 1;
    }
    bodies.push(text.slice(start + marker.length, index - 1));
    searchFrom = index;
  }
  return bodies;
};

const splitTopLevelArgs = (body: string): readonly string[] => {
  const args: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote !== undefined) {
      current += char;
      if (char === '\\') {
        current += body[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
};

const literalStringId = (arg: string | undefined): string | undefined => {
  if (arg === undefined) return undefined;
  const match = /^'([a-z0-9-]+)'$/.exec(arg) ?? /^"([a-z0-9-]+)"$/.exec(arg);
  return match?.[1];
};

const literalIdsAtArgIndex = (method: string, argIndex: number): readonly string[] =>
  findCallBodies(source, method)
    .map((body) => literalStringId(splitTopLevelArgs(body)[argIndex]))
    .filter((id): id is string => id !== undefined);

describe('every emitted id exists in manifest.json', () => {
  it('emitter.metric ids are known metrics', () => {
    const ids = literalIdsAtArgIndex('metric', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.metric.has(id)).toBe(true));
  });

  it('emitter.flow edge ids are known edges', () => {
    const ids = literalIdsAtArgIndex('flow', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.flow.has(id)).toBe(true));
  });

  it('emitter.node ids are known nodes', () => {
    const ids = literalIdsAtArgIndex('node', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.node.has(id)).toBe(true));
  });

  it('emitter.phase ids are known phases', () => {
    const ids = literalIdsAtArgIndex('phase', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.phase.has(id)).toBe(true));
  });

  it('emitter.check ids are known checks', () => {
    const ids = literalIdsAtArgIndex('check', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.check.has(id)).toBe(true));
  });

  it('emitter.log node ids (third argument) are known nodes', () => {
    const ids = literalIdsAtArgIndex('log', 2);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.node.has(id)).toBe(true));
  });
});

describe('every manifest id is emitted somewhere', () => {
  it('every manifest edge is emitted by at least one emitter.flow call', () => {
    const emitted = new Set(literalIdsAtArgIndex('flow', 0));
    manifest.edges.forEach((edge) => expect(emitted.has(edge.id)).toBe(true));
  });

  it('every manifest metric is emitted by at least one emitter.metric call', () => {
    const emitted = new Set(literalIdsAtArgIndex('metric', 0));
    manifest.metrics.forEach((metric) => expect(emitted.has(metric.id)).toBe(true));
  });

  it('every manifest phase is emitted by at least one emitter.phase call', () => {
    const emitted = new Set(literalIdsAtArgIndex('phase', 0));
    manifest.phases.forEach((phase) => expect(emitted.has(phase.id)).toBe(true));
  });

  it('every manifest check is emitted by at least one emitter.check call', () => {
    const emitted = new Set(literalIdsAtArgIndex('check', 0));
    manifest.checks.forEach((check) => expect(emitted.has(check.id)).toBe(true));
  });
});
```

Run before `main.ts` exists:

```bash
cd demos/agent-aml && pnpm vitest run test/emitted-ids.test.ts
```

Expected FAIL: `ENOENT: no such file or directory, open '.../runner/main.ts'`.

`demos/agent-aml/runner/main.ts` is the impure shell. Pure decisions live in `runner/src`; this file wires them. Two serial queues keep traffic (ticks and injections) and case work (investigation, rule test, promotion) from racing on their own state while still letting traffic continue during a case. The module-level `let ready` and the stores hold orchestration state the way any long-running process must; the values they hold are replaced wholesale, never mutated.

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createS3EventSink } from '@lab/agent-stack-kit';
import { createEmitter, createTidbPool, every, onControl, sleep } from '@lab/runner-kit';
import { loadConfig } from './src/config';
import { PastCasesSchema, PlaybookSchema, WatchlistFixtureSchema } from './src/fixtures';
import { createSerialQueue } from './src/queue';
import { createStore } from './src/store';
import { errorMessage, type CaseRecord, type Context, type World } from './src/live/context';
import { evaluateInLake, promoteSkill, recordVerdicts, stageSkillUpdate } from './src/live/learn';
import { openInvestigation, testRuleOnBranch } from './src/live/investigate';
import { connectLake } from './src/live/lake';
import { createRowSink } from './src/live/sinks';
import { runSetup } from './src/live/setup';
import { baselineTick, injectStructuringRing, injectWatchlistNearMatch } from './src/live/traffic';

const fixturesDirectory = fileURLToPath(new URL('./fixtures', import.meta.url));
const readJson = (name: string): unknown => JSON.parse(readFileSync(`${fixturesDirectory}/${name}`, 'utf8'));

const config = loadConfig(process.env);
const watchlist = WatchlistFixtureSchema.parse(readJson('watchlist.json'));
const emitter = createEmitter();
const controller = new AbortController();
const trafficQueue = createSerialQueue();
const caseQueue = createSerialQueue();
const runId = `run-${Date.now().toString(36)}`;
const pool = createTidbPool(process.env);

const emptyWorld = (): World => ({
  population: { accounts: [], lookAlikeIds: [] },
  accounts: [],
  truth: [],
  watchlistEntries: 0,
  watchlistCandidates: new Map(),
  nextTxnId: 1,
  lastDayStartMs: config.firstDayStartMs,
  dayCounter: 0,
  ringCount: 0,
  ringAccountCount: 0,
  nearMatchCount: 0,
  exportedUpToTxnId: 0,
  lastAlertCommitWallMs: Date.now(),
  runEventSeq: 0,
  flagsEmitted: 0,
  coverageStatus: 'pending',
});

const sinkFor = (kind: string) =>
  createRowSink(createS3EventSink({ bucket: config.bucket, prefix: `lake/events/${kind}`, region: config.region }));

const ctx: Context = {
  config,
  database: process.env.TIDB_DATABASE ?? 'harbor_core',
  runId,
  emitter,
  pool,
  lake: connectLake(process.env),
  sinks: { truth: sinkFor('truth'), flags: sinkFor('flags'), run: sinkFor('run') },
  fixtures: {
    directory: fixturesDirectory,
    watchlistNames: watchlist.entries,
    watchlistTag: watchlist.listTag,
    pastCases: PastCasesSchema.parse(readJson('past-cases.json')),
    playbook: PlaybookSchema.parse(readJson('playbook.json')),
  },
  world: createStore<World>(emptyWorld()),
  cases: createStore<readonly CaseRecord[]>([]),
};

let ready = false;

const guarded = (queue: ReturnType<typeof createSerialQueue>, label: string, task: () => Promise<void>): void => {
  if (!ready) {
    emitter.log('warn', `${label} ignored: setup is still running`);
    return;
  }
  queue.enqueue(task).catch((error: unknown) => emitter.log('error', `${label} failed: ${errorMessage(error)}`));
};

const runRuleTest = async (): Promise<void> => {
  await testRuleOnBranch(ctx);
  await recordVerdicts(ctx);
  const evidence = await evaluateInLake(ctx);
  await stageSkillUpdate(ctx, evidence);
};

onControl((id) => {
  if (id === 'inject-structuring-ring') guarded(trafficQueue, id, () => injectStructuringRing(ctx));
  if (id === 'inject-watchlist-near-match') guarded(trafficQueue, id, () => injectWatchlistNearMatch(ctx));
  if (id === 'open-investigation') guarded(caseQueue, id, () => openInvestigation(ctx));
  if (id === 'test-rule-on-branch') guarded(caseQueue, id, runRuleTest);
  if (id === 'promote-skill') guarded(caseQueue, id, () => promoteSkill(ctx));
});

const shutdown = async (): Promise<void> => {
  controller.abort();
  await Promise.race([pool.end(), sleep(3000)]);
  process.exit(process.exitCode ?? 0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const main = async (): Promise<void> => {
  await runSetup(ctx);
  ready = true;
  emitter.phase('baseline-traffic');
  await every({
    intervalMs: config.tickMs,
    task: () =>
      trafficQueue.enqueue(() => baselineTick(ctx)).catch((error: unknown) => {
        emitter.log('error', `traffic tick failed: ${errorMessage(error)}`, 'txn-generator');
      }),
    signal: controller.signal,
  });
};

main().catch(async (error: unknown) => {
  emitter.log('error', errorMessage(error));
  process.exitCode = 1;
  await shutdown();
});
```

`demos/agent-aml/runner/teardown.ts`:

```typescript
import { branches, tiFs } from '@lab/agent-stack-kit';
import { createTidbPool } from '@lab/runner-kit';
import { loadConfig } from './src/config';
import { FILE_SYSTEM_ROOT } from './src/journal';
import { teardownStatements } from './src/lakeSql';
import { errorMessage } from './src/live/context';
import { runOrThrow } from './src/live/cli';
import { connectLake } from './src/live/lake';
import { rowsOf } from './src/starter';

const config = loadConfig(process.env);
const pool = createTidbPool(process.env);

const attempt = async (label: string, task: () => Promise<unknown>): Promise<void> => {
  try {
    await task();
    console.log(`ok      ${label}`);
  } catch (error) {
    console.log(`skipped ${label}: ${errorMessage(error)}`);
  }
};

const run = async (): Promise<void> => {
  const cases = await rowsOf(pool, 'SELECT case_id, layer_id, branch_id FROM cases ORDER BY case_id DESC').catch(() => []);
  await cases.reduce(async (previous, row) => {
    await previous;
    await attempt(`delete branch ${String(row.branch_id)}`, () =>
      branches.remove({ clusterId: config.clusterId, branchId: String(row.branch_id) }),
    );
    await attempt(`delete layer ${String(row.layer_id)}`, () =>
      tiFs.deleteLayer({ layerRef: String(row.layer_id), cascade: true }),
    );
  }, Promise.resolve());
  const remaining = await branches.list({ clusterId: config.clusterId }).catch(() => []);
  await remaining.reduce(async (previous, branch) => {
      await previous;
      await attempt(`delete leftover branch ${branch.branchId}`, () =>
        branches.remove({ clusterId: config.clusterId, branchId: branch.branchId }),
      );
    }, Promise.resolve());
  await attempt(`delete ${FILE_SYSTEM_ROOT}`, () =>
    runOrThrow({ bin: 'ti', args: ['fs', 'delete-file', '--path', FILE_SYSTEM_ROOT, '--recursive'] }),
  );
  const lake = connectLake(process.env);
  await teardownStatements.reduce(async (previous, sql) => {
    await previous;
    await attempt(sql, () => lake.query(sql));
  }, Promise.resolve());
  console.log('Next: empty and delete the S3 bucket, revoke the IAM user, stop the Lake warehouse, delete the Starter instance and the file system.');
};

run()
  .catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(() => {
    void Promise.race([pool.end(), new Promise((resolve) => setTimeout(resolve, 3000))]).then(() =>
      process.exit(process.exitCode ?? 0),
    );
  });
```

Run:

```bash
cd demos/agent-aml && pnpm vitest run test/emitted-ids.test.ts
pnpm --filter @lab/demo-agent-aml typecheck
pnpm --filter @lab/demo-agent-aml test
```

Expected PASS: the emitted-ids file reports 10 passed; typecheck exits 0; the full suite reports 21 test files and 175 tests passed.

Commit:

```bash
git add demos/agent-aml/runner/main.ts demos/agent-aml/runner/teardown.ts demos/agent-aml/test/emitted-ids.test.ts
git commit -m "agent-aml demo: runner entry, teardown, emitted-ids guard"
```

### Task 25: End-to-end live run through the relay

- [ ] Not started

From `integrations/`, with `AML_RESET=true` in `demos/agent-aml/.env`:

```bash
pnpm lab validate agent-aml
pnpm lab run agent-aml --port 7070
```

Expected for `validate`: `agent-aml: manifest ok, no featured trace yet`. Expected for `run`: `lab relay for agent-aml on http://localhost:7070`, then `open http://localhost:5173/#/demo/agent-aml?relay=http://localhost:7070`.

In a second terminal:

```bash
curl http://localhost:7070/health
curl -N http://localhost:7070/events
```

Expected: `{"ok":true,"demo":"agent-aml"}`. The event stream shows `{"type":"phase","phase":"setup",...}` first, then within several minutes `{"type":"check","id":"lake-history-matches-export","status":"pass",...}` with `observed` like `Lake 10198 rows, Starter 10198 rows up to txn_id 10198`, then `{"type":"phase","phase":"baseline-traffic",...}` and a `metric` line for `alerts-per-minute`, `planted-recall` (100) and `false-positives-per-1000` every two seconds.

Then exercise each control and look for the quoted lines in the stream:

```bash
curl -X POST http://localhost:7070/control/inject-structuring-ring
```

Expected: 2xx; `{"type":"control","id":"inject-structuring-ring",...}`, `{"type":"phase","phase":"inject-pattern",...}`, `{"type":"phase","phase":"alert",...}`, and `{"type":"check","id":"every-planted-case-flagged","status":"pass","observed":"4 of 4 planted accounts flagged by their own rule"}`.

```bash
curl -X POST http://localhost:7070/control/open-investigation
```

Expected: `{"type":"phase","phase":"open-investigation",...}`, `layer-open-seconds`, then `{"type":"phase","phase":"recall-similar-cases",...}` with `hybrid-recall-ms` and `lake-lookback-ms`, and some minutes later `branch-create-seconds`, `investigation-open-time` and `{"type":"node","node":"investigation-branch","status":"healthy",...}`.

```bash
curl -X POST http://localhost:7070/control/test-rule-on-branch
```

Expected, in order: phase `test-rule-on-branch`, `{"type":"check","id":"investigation-branch-isolated","status":"pass",...}`, `rule-change-alert-delta` below zero, phase `analyst-verdict`, phase `lake-eval`, `{"type":"check","id":"lake-history-matches-export","status":"pass",...}`, `precision-v1-simulated` below 10 and `precision-v2-simulated` equal to 100, phase `distill-commit-skill`, and a log that a skill update is staged.

```bash
curl -X POST http://localhost:7070/control/promote-skill
```

Expected: `{"type":"check","id":"skill-commit-lands-on-base","status":"pass",...}`, phase `lesson-to-memory`, a log `the new lesson is retrievable: rank` followed by a number, and `{"type":"check","id":"journal-verifies","status":"pass",...}`.

```bash
curl -X POST http://localhost:7070/control/inject-watchlist-near-match
```

Expected: phase `inject-pattern`, phase `alert`, and `every-planted-case-flagged` back to `pass` with 5 of 5 planted accounts. Stop with Ctrl-C.

Commit: nothing (this task only proves the wiring; no new files).

### Task 26: Public-content gate

- [ ] Not started

```bash
pnpm lab check-public
```

Expected: passes with no denylisted terms or internal URLs under `demos/agent-aml/` or this plan. If it flags anything, fix the flagged file and rerun before section 8.

### Task 27: README and TALK-TRACK

- [ ] Not started

`demos/agent-aml/README.md`:

````markdown
# TiDB Cloud agent stack: anti-money-laundering agent (Filesystem + TiDB X + Lake)

## What this proves

A scripted investigation agent for a fictional bank, Harbor Mutual, works a
synthetic alert queue on three TiDB Cloud products at once, and the replay
shows each claim as a measured number or a check:

- TiDB Cloud Starter (the architecture behind it is TiDB X) holds the
  transactions, rules, alerts and the agent's episodic memory. One SQL
  statement fuses a vector search and a full-text search over past cases.
- Every alert gets a TiDB Cloud Filesystem layer for evidence, notes and a
  draft, plus a hash-chained journal and a time-limited vault grant. Nothing
  reaches the shared folders until a human promotes it.
- Every alert also gets a copy-on-write Starter branch, where a candidate rule
  is tried without touching production rules or alerts. The demo proves the
  isolation with a check.
- TiDB Cloud Lake holds the transaction history, every flag and every verdict.
  One query measures precision per rule version and recall on planted cases.
- The agent distills a skill file in a layer and commits it to the base file
  system only after a human decision, then writes a lesson to memory.

Everything is synthetic. The agent is a deterministic script, not a language
model, so the demo measures the data infrastructure and not model quality.
Analyst verdicts are simulated from planted ground truth and labeled that way.
The demo makes no compliance, certification or legal claims about any product.

See `docs/plans/13-agent-aml.md` for the design, the verified facts and the
open items.

## Prerequisites

- Plans 00 and 12 built (the platform and `@lab/agent-stack-kit`).
- A TiDB Cloud Starter instance in aws-us-east-1 (full-text search on Starter
  runs only in some AWS regions, including N. Virginia).
- A TiDB Cloud Filesystem file system in aws-us-east-1 and its token.
- A TiDB Cloud Lake warehouse in the same region as the S3 bucket.
- One S3 bucket in aws-us-east-1 and a dedicated IAM user limited to it.
- The `ti`, `ticloud` and `aws` CLIs (the first two change between releases), Node 22, pnpm.

## One-time setup

1. `cp .env.example .env` and fill in every value. Set `TIDB_DATABASE=harbor_core`
   and `TIDB_TLS=true`.
2. From `integrations/`: `pnpm install` and `pnpm lab db-init agent-aml`.
3. Set `AML_RESET=true` for the first run and for every re-record. It wipes the
   Starter tables, clears `s3://<bucket>/lake/` and truncates the Lake tables
   before loading, so a second recording never double counts rows.

## Run

```bash
pnpm lab run agent-aml --port 7070
```

Setup takes several minutes: it seeds data, exports history to S3 as Parquet
and waits for the Lake load task. Then drive it from the UI or headless:

```bash
curl -X POST http://localhost:7070/control/inject-structuring-ring
curl -X POST http://localhost:7070/control/open-investigation
curl -X POST http://localhost:7070/control/test-rule-on-branch
curl -X POST http://localhost:7070/control/promote-skill
curl -X POST http://localhost:7070/control/inject-watchlist-near-match
```

Branch creation takes minutes. The agent keeps working while it finishes, and
the rule test only runs once the branch is active.

## Record

```bash
pnpm lab run agent-aml --record --port 7070
```

Stop with Ctrl-C, promote the newest file under `traces/` to
`traces/featured.json`. The choreography is in section 8 of the plan.

## Cost

Starter bills Request Units and storage, Filesystem bills storage, requests and
egress, Lake bills warehouse running seconds, storage and API requests, and S3
bills storage and requests. Formulas and pricing pages are in section 5 of the
plan. Suspend the Lake load task and the warehouse as soon as you stop.

## Teardown

```bash
pnpm --filter @lab/demo-agent-aml teardown
```

Then empty and delete the S3 bucket, revoke the IAM user, stop the Lake
warehouse and delete the Starter instance and the file system. Section 5 of
the plan lists every command.
````

`demos/agent-aml/TALK-TRACK.md`:

````markdown
# Talk track: TiDB Cloud agent stack, anti-money-laundering agent

## What this proves

An investigation agent needs four things from its data layer: isolation per
case, a safe place to test a change, memory that carries over between cases,
and a way to measure whether it is improving. This demo shows all four on
three TiDB Cloud products with synthetic data, and every number on screen is
either measured or labeled simulated.

Say this early: the agent is a script, the verdicts are simulated, and nothing
here is a compliance claim.

## Phase-by-phase script

**Setup.** "Harbor Mutual is made up. We seed customers, a synthetic watchlist
and ninety days of transactions into a Starter instance, export the history to
S3 as Parquet, and let a Lake task load it. The check you see turn green
compares Lake's row count with Starter's for the same cutoff."

**Baseline Traffic.** "Normal traffic is flowing and our version 1 rules keep
firing. Look at false positives per thousand: the generator planted the real
cases, so we can count what is wrong exactly."

**Inject a Pattern.** "Now I plant a structuring ring: three accounts making
cash deposits just under a reporting threshold, spread across branches. We
know the answer because we planted it."

**Alert.** "The rule engine flags it. Planted recall has to be one hundred
percent, and the first check proves every planted case was flagged."

**Open an Investigation.** "Each alert gets a file system layer for the case,
a journal that is hash chained, a ten minute vault grant, and a copy-on-write
branch of the database. Branching takes minutes, so the agent carries on while
it finishes."

**Recall Similar Cases.** "One SQL statement runs a vector search and a
full-text search over past case summaries and fuses them. Then Lake looks back
over months of history. The agent writes notes and a draft report into the
layer. It never files anything: a human decides."

**Test a Rule on the Branch.** "The agent tries a tighter rule, requiring at
least two branches. It runs on the branch only. The check shows the candidate
rule exists on the branch and nowhere in production."

**Analyst Verdict (simulated).** "These verdicts come from the planted ground
truth, so they stand in for an analyst and are labeled simulated."

**Lake Evaluation.** "Flags and verdicts land in Lake. One query gives precision
per rule version, and recall on the planted cases."

**Distill and Commit a Skill.** "The agent writes what it learned into a skill
file inside a layer. Only when I press promote does that layer commit to the
shared skills folder. The next check reads the file back from the base."

**Lesson to Memory.** "The lesson goes into episodic memory, so the next
similar case recalls it. Finally the journal's hash chain verifies the whole
investigation."

## Discovery questions

1. "How do your investigators keep one case's working files from leaking into
   another, and who can see a draft before it is final?"
2. "When someone proposes a rule change, how do you test it against real data
   without touching production?"
3. "How does what one investigator learns end up helping the next one?"
4. "How do you measure whether a rule change made alerts better, not just fewer?"
5. "How much history do you keep online for lookbacks, and where does it live?"
6. "Who has to approve a change to the guidance your analysts or agents follow?"

## Objections and honest answers

1. **"Is this compliant or certified for anti-money-laundering work?"** No
   claim is made. The data is synthetic, the reporting threshold is a named
   configurable constant for illustration, and nothing here is legal or
   regulatory advice. Your compliance team decides what is acceptable.
2. **"Branch creation takes minutes. Is that fast enough?"** It is documented
   as usually finishing within a few minutes, and the demo shows the real
   number. We hide it by overlapping it with other work, not by pretending it
   is instant. If you need an answer in seconds, test on a layer or read-only
   queries instead.
3. **"Is the agent an AI model?"** No. It follows a scripted playbook so the
   run is repeatable and the demo measures the data layer. A model-driven mode
   would change the decisions, not the data infrastructure behind them.
4. **"Are the analyst verdicts real?"** No. They are derived from the planted
   ground truth and labeled simulated everywhere they appear.
5. **"Are these products production ready?"** Filesystem, branching and Lake
   are in preview, and the `ti` command line is a public preview whose flags
   can change. Starter itself is generally available. Plan accordingly.
6. **"Why keep history in Lake and not just in Starter?"** The operational
   store should stay lean and fast for the live path. Lake separates compute
   from storage and bills warehouse seconds, which suits lookbacks and
   evaluation over months of data.
7. **"Does Starter stream changes to Lake?"** Not in this demo. Starter has no
   changefeed, so the default path is a periodic Parquet export to S3 loaded by
   a Lake task. The Essential plan has a preview changefeed sink to Lake, and
   that variant is optional.
8. **"Does the agent ever write to our shared files on its own?"** Not in this
   design. The case layer is never committed. The skill layer commits only
   after a human presses promote, and the commit is checked by reading the
   file back from the base.
````

Run:

```bash
grep -c "$(printf '\342\200\224')" demos/agent-aml/README.md demos/agent-aml/TALK-TRACK.md
```

Expected: `0` for both files. Read both back once to confirm the fenced blocks render as intended.

Commit:

```bash
git add demos/agent-aml/README.md demos/agent-aml/TALK-TRACK.md
git commit -m "agent-aml demo: README and talk track"
```

## 8. Recording the featured trace

1. **Pre-flight, off camera.** The preview services have real latency, so remove surprises first:
   - Start the Lake warehouse and the Starter instance, and confirm no leftover branches: `ticloud serverless branch list -c "$AML_CLUSTER_ID"` shows none (the organization quota is shared by every Starter instance, and the demo needs two).
   - Run the four smoke subcommands from Task 21 (`recall`, `fs`, `lake`, `branch`) and confirm each prints its expected lines. Run `branch` last and note `branch-create-seconds`, which is roughly what the recording will wait.
   - Set `AML_RESET=true` in `demos/agent-aml/.env`. Setup then wipes the Starter tables, clears `s3://$S3_BUCKET/lake/` and truncates the Lake tables, so a re-record never double counts.
2. **Set the trace environment values honestly** in `demos/agent-aml/.env` before starting:
   ```
   LAB_ENV_TIDB=TiDB Cloud Starter (aws-us-east-1), <version from SELECT VERSION()>
   LAB_ENV_NOTES=Synthetic data only. Seed <AML_SEED>, <AML_HISTORY_DAYS> days of history, one tick is one simulated day of <AML_TICK_MS> ms. Analyst verdicts are simulated. Branch creation and Lake loads include real preview-service latency.
   LAB_ENV_COMPONENT_TI_CLI=<output of ti --version>
   LAB_ENV_COMPONENT_TICLOUD_CLI=<output of ticloud --version>
   LAB_ENV_COMPONENT_FILESYSTEM=TiDB Cloud Filesystem (public preview), aws-us-east-1
   LAB_ENV_COMPONENT_LAKE=TiDB Cloud Lake (preview), <warehouse size>, <region>
   LAB_ENV_COMPONENT_S3=Amazon S3, us-east-1
   ```
3. **Record:**
   ```bash
   cd integrations
   pnpm lab run agent-aml --record --port 7070
   ```
4. In the UI (`packages/ui`, pointed at `localhost:7070`):
   - Let setup finish (several minutes: seeding, the first Parquet export and the Lake load). Wait for the first `lake-history-matches-export` pass, then let `baseline-traffic` run 30 to 60 seconds so the false-positive tile has a visible value.
   - Click **Inject structuring ring** and wait for the `alert` phase and the `every-planted-case-flagged` pass.
   - Click **Open investigation**. Let the recall and evidence steps complete; the branch keeps building for a few minutes. Do not click anything until `investigation-open-time` appears.
   - Click **Test rule on branch**. This runs the rule test, the simulated verdicts, the second export, the Lake loads and the evaluation, then stages the skill. It takes several minutes; wait for the log that a skill update is staged.
   - Click **Promote skill** and wait for the lesson log and the `journal-verifies` pass.
   - Click **Inject watchlist near-match** to show the second pattern and the full-text screening, and wait for the `alert` phase. Do not open a second investigation.
   - The whole recording is typically 15 to 30 minutes of wall clock because of branch creation and the Lake loads. The replay supports speed and scrub, so present waits at 4x to 8x and say so; do not trim the waits out, they are part of the honest numbers.
5. Stop with **Ctrl-C** in the `pnpm lab run` terminal. The runner aborts its tick loop, gives the pool three seconds to close and exits, and the relay writes `demos/agent-aml/traces/<ISO timestamp>.json`.
6. **A good run looks like:**
   - All five checks end `pass`, with `lake-history-matches-export` having passed twice.
   - `planted-recall` is 100 after every injection; `false-positives-per-1000` is clearly above 0 during baseline.
   - `precision-v1-simulated` is below 10 and `precision-v2-simulated` is 100; `rule-change-alert-delta` is negative.
   - `branch-create-seconds` and `lake-load-seconds` carry real, unedited values.
   - Every edge has a nonzero flow total, every metric has at least one sample, all eleven phases appear in order and all five controls appear once.
   - There is no `log` event at level `error`.
7. Promote the recording:
   ```bash
   cd demos/agent-aml/traces
   cp "$(ls -t *.json | head -1)" featured.json
   ```
8. Validate and gate:
   ```bash
   cd ../../..
   pnpm lab validate agent-aml
   pnpm lab check-public
   ```
   Expected: `agent-aml: manifest ok, featured trace ok (N events)` and `check-public: ... 0 findings`.
9. Commit only `traces/featured.json` (every other file in `traces/` is gitignored per the platform contract):
   ```bash
   git add demos/agent-aml/traces/featured.json
   git commit -m "agent-aml demo: record featured trace"
   ```
10. Run the section 5 teardown immediately and confirm it.

## 9. Risks and gotchas

- **Kit drift.** Plan 12's kit API is final and restated in section 4. Every kit call is an options-object call confined to `runner/src/live`, `main.ts`, `smoke.ts` and `teardown.ts`. Packet 13-V0 diffs the real signatures and 13-P21b changes call sites only; the pure modules never import the kit.
- **Preview CLIs change.** `ti` and `ticloud` are previews. All arguments live in the kit, `runner/src/exportPlan.ts` and `runner/src/live/filesystem.ts`. Record both CLI versions in `LAB_ENV_COMPONENT_*` every time.
- **Branch creation takes minutes and the quota is five per organization.** The runner starts creation first and overlaps it with the layer, recall and evidence work; the rule test refuses to run until the branch is active. Leftover branches from failed runs eat the quota, so teardown deletes every branch named `aml-case-*` and the recording opens one investigation only.
- **A new branch has no TiFlash replicas for a while.** The branch is used only for plain SQL (rules, alerts, counts). Never run the hybrid recall on the branch.
- **How to reach a branch is unconfirmed.** `testRuleOnBranch` builds a pool from the endpoint the kit returns plus `AML_BRANCH_PASSWORD` (or the instance password). Packet 13-V2 settles it; the `smoke branch` subcommand is the quick check.
- **Point in time races the alert write.** Both clocks come from the database (`SELECT UTC_TIMESTAMP(3)` through `serverNowMs`), as in Plan 12, so laptop clock skew cannot matter. The branch is created at `committed + 1 s` capped at `now - 2 s` (`pointInTimeMs`). If the branch lacks the ring's alerts, the what-if still compares v1 against v2 from transactions, but `rule-change-alert-delta` would be off; the runner logs a warning when the SQL delta and the in-memory delta differ.
- **Full-text and vector freshness.** A just-inserted watchlist entry or lesson may not be searchable for a few seconds. The runner polls (up to 60 seconds and about 30 seconds); if the warning log appears, wait and rerun the control.
- **Export layout and types are guesses until 13-V3.** `parseExportId`, `exportState`, the stage `PATTERN` and the `TIMESTAMP` columns may need the workarounds recorded there (STRING columns with casts, or a transforming `COPY INTO`).
- **Lake double counting.** `COPY INTO` skips already loaded files, but a re-run with new export folders reloads identical seeded data. `AML_RESET=true` clears the S3 prefix and truncates the tables; never re-record without it, or `lake-history-matches-export` will fail on extra rows (the check requires equality, not at-least).
- **Lake cost and API requests.** The minute load task keeps the warehouse running and every poll is an API request. The runner polls every 5 seconds only while waiting; suspend the task (`ALTER TASK harbor_load SUSPEND`, done by teardown) and the warehouse after recording.
- **Credentials.** The S3 keys are passed to `ticloud serverless export create` as arguments and to Lake in `CREATE CONNECTION`. Use the dedicated bucket-scoped IAM user, log only through `redactArgs`, and revoke the keys at teardown. The vault secret is a synthetic placeholder string.
- **`pool.end()` can hang on Cloud pools.** Plan 06 saw it; `main.ts` and `teardown.ts` race it against a three second timer and then `process.exit`, so a recording always ends and the relay always writes the trace.
- **Simulated numbers must stay labeled.** Never add a tile or caption that shows precision without the word simulated; the manifest test enforces it for the two precision metrics.
- **No compliance claims.** Do not add wording about regulations, filings or certifications to the README, talk track, captions or any recorded log line. The draft report says nothing was filed and makes no determination.
- **Optional Essential variant.** The Essential changefeed sink to Lake (preview, AWS only, API only) could replace the Parquet export. It is not built, is not in the manifest, and must not appear in the recording.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. These packets are hand-written with a real dependency graph, like Plan 04's; do not regenerate them with `tools/packets.py`, which would flatten the graph and merge the verify packets. Plan 00 and Plan 12's kit packets must be complete first. Cloud packets share the one set of resources from Task 19, so they run one at a time; each `smoke` subcommand removes what it creates, and the full section 5 teardown is confirmed after 13-R. Pure packets that name no common file may run in parallel: after 13-P2, packets 13-P3, 13-P6, 13-P9, 13-P16 and 13-P18 are independent.

### Packet 13-V0: Verify the kit surface and the Lake driver
- Tasks: none (docs only)
- Depends on: 00-P10 and the Plan 12 packets that create `integrations/packages/agent-stack-kit`   Shared runtime: none
- Files owned: `integrations/docs/plans/13-agent-aml.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (read `integrations/packages/agent-stack-kit/src/index.ts` and its tests):
  - the barrel matches Plan 12's "Kit API reference" as restated in section 4: names, argument objects and returns, including `runCli` returning `{ code, stdout, stderr }`, `diffLayer` returning paths, `createGrant` returning the token, `waitActive` returning `BranchInfo`, and the S3 sink's `write(lines)`
  - the Lake environment variable names and the Node driver the kit uses, recorded in `LAB_ENV_COMPONENT_LAKE_DRIVER`
  - record any difference as an adapter note under section 4 for 13-P21
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/13-agent-aml.md` -> lower than before, and every remaining row says why it cannot be checked yet
  - `pnpm --filter @lab/agent-stack-kit typecheck` -> exit 0
- Done when: every call site in Tasks 21 to 23 matches the built kit or has a recorded adapter.

### Packet 13-P1: Scaffold the demo package
- Tasks: 1
- Depends on: 13-V0   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/package.json`, `integrations/demos/agent-aml/tsconfig.json`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm install` -> links `@lab/contract`, `@lab/runner-kit` and `@lab/agent-stack-kit` from the workspace
- Done when: Task 1's steps are checked off.

### Packet 13-P2: Domain types, seeded random source, time helpers, state box
- Tasks: 2
- Depends on: 13-P1   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/domain.ts`, `integrations/demos/agent-aml/runner/src/time.ts`, `integrations/demos/agent-aml/runner/src/prng.ts`, `integrations/demos/agent-aml/runner/src/store.ts`, `integrations/demos/agent-aml/runner/test/foundations.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/foundations.test.ts` -> 10 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 2's steps are checked off and the gate output matches.

### Packet 13-P3: Name cleaning and fuzzy similarity
- Tasks: 3
- Depends on: 13-P1   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/names.ts`, `integrations/demos/agent-aml/runner/test/names.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/names.test.ts` -> 7 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 3's steps are checked off and the gate output matches.

### Packet 13-P4: Seeded generator with planted patterns
- Tasks: 4
- Depends on: 13-P2, 13-P3   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/generator.ts`, `integrations/demos/agent-aml/runner/test/generator.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/generator.test.ts` -> 14 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 4's steps are checked off and the gate output matches.

### Packet 13-P5: Versioned rule engine
- Tasks: 5
- Depends on: 13-P2, 13-P3   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/rules.ts`, `integrations/demos/agent-aml/runner/test/rules.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/rules.test.ts` -> 13 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 5's steps are checked off and the gate output matches.

### Packet 13-P6: Ground-truth scorer and simulated verdicts
- Tasks: 6
- Depends on: 13-P2   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/scorer.ts`, `integrations/demos/agent-aml/runner/test/scorer.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/scorer.test.ts` -> 8 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 6's steps are checked off and the gate output matches.

### Packet 13-P7: Rule what-if comparator and isolation evaluator
- Tasks: 7
- Depends on: 13-P6   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/whatIf.ts`, `integrations/demos/agent-aml/runner/test/whatIf.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/whatIf.test.ts` -> 6 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 7's steps are checked off and the gate output matches.

### Packet 13-P8: Seeded scenario guard
- Tasks: 8
- Depends on: 13-P4, 13-P5, 13-P7   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/test/scenario.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/scenario.test.ts` -> 3 passed
- Done when: the planted story holds under v1 and v2 in memory.

### Packet 13-P9: Hybrid recall SQL builder
- Tasks: 9
- Depends on: 13-P2   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/sqlLiteral.ts`, `integrations/demos/agent-aml/runner/src/recallSql.ts`, `integrations/demos/agent-aml/runner/test/recallSql.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/recallSql.test.ts` -> 8 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 9's steps are checked off and the gate output matches.

### Packet 13-P10: Starter schema, statement builders and row mappers
- Tasks: 10
- Depends on: 13-P5, 13-P9   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/schema.ts`, `integrations/demos/agent-aml/runner/src/rowMappers.ts`, `integrations/demos/agent-aml/runner/src/starterSql.ts`, `integrations/demos/agent-aml/runner/test/schema.test.ts`, `integrations/demos/agent-aml/runner/test/starterSql.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/schema.test.ts runner/test/starterSql.test.ts` -> 18 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 10's steps are checked off and the gate output matches.

### Packet 13-P11: Case working set builder and renderers
- Tasks: 11
- Depends on: 13-P9   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/format.ts`, `integrations/demos/agent-aml/runner/src/workingSet.ts`, `integrations/demos/agent-aml/runner/test/workingSet.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/workingSet.test.ts` -> 11 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 11's steps are checked off and the gate output matches.

### Packet 13-P12: Skill lint and distiller
- Tasks: 12
- Depends on: 13-P5, 13-P11   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/fixtures/skills/structuring-triage.md`, `integrations/demos/agent-aml/runner/src/skills.ts`, `integrations/demos/agent-aml/runner/test/skills.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/skills.test.ts` -> 8 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 12's steps are checked off and the gate output matches.

### Packet 13-P13: Lesson composer and journal helpers
- Tasks: 13
- Depends on: 13-P7, 13-P9, 13-P11   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/journal.ts`, `integrations/demos/agent-aml/runner/src/lesson.ts`, `integrations/demos/agent-aml/runner/test/lessonAndJournal.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/lessonAndJournal.test.ts` -> 7 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 13's steps are checked off and the gate output matches.

### Packet 13-P14: Lake SQL builders
- Tasks: 14
- Depends on: 13-P9   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/lakeSql.ts`, `integrations/demos/agent-aml/runner/test/lakeSql.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/lakeSql.test.ts` -> 12 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 14's steps are checked off and the gate output matches.

### Packet 13-P15: Export arguments, sink rows, branch time, tick math
- Tasks: 15
- Depends on: 13-P6   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/exportPlan.ts`, `integrations/demos/agent-aml/runner/src/sinkRows.ts`, `integrations/demos/agent-aml/runner/src/branchPlan.ts`, `integrations/demos/agent-aml/runner/src/tickMath.ts`, `integrations/demos/agent-aml/runner/test/exportAndSink.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/exportAndSink.test.ts` -> 10 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 15's steps are checked off and the gate output matches.

### Packet 13-P16: Config, serial queue, retry, export parsing, branch environment
- Tasks: 16
- Depends on: 13-P2   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/config.ts`, `integrations/demos/agent-aml/runner/src/queue.ts`, `integrations/demos/agent-aml/runner/src/retry.ts`, `integrations/demos/agent-aml/runner/src/exportParse.ts`, `integrations/demos/agent-aml/runner/src/branchEnv.ts`, `integrations/demos/agent-aml/runner/test/configAndQueue.test.ts`, `integrations/demos/agent-aml/runner/test/retry.test.ts`, `integrations/demos/agent-aml/runner/test/branchEnv.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/configAndQueue.test.ts runner/test/retry.test.ts runner/test/branchEnv.test.ts` -> 17 passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 16's steps are checked off and the gate output matches.

### Packet 13-P17: Fixtures and their loader
- Tasks: 17
- Depends on: 13-P3, 13-P4, 13-P12   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/fixtures.ts`, `integrations/demos/agent-aml/fixtures/watchlist.json`, `integrations/demos/agent-aml/fixtures/past-cases.json`, `integrations/demos/agent-aml/fixtures/playbook.json`, `integrations/demos/agent-aml/fixtures/skills/rapid-movement-review.md`, `integrations/demos/agent-aml/fixtures/skills/watchlist-review.md`, `integrations/demos/agent-aml/runner/test/fixtures.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run runner/test/fixtures.test.ts` -> 6 passed
  - `grep -c $(printf '\342\200\224') integrations/demos/agent-aml/fixtures/watchlist.json integrations/demos/agent-aml/fixtures/past-cases.json` -> 0 for every file
- Done when: Task 17's steps are checked off and the gate output matches.

### Packet 13-P18: Manifest
- Tasks: 18
- Depends on: 13-P1   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/manifest.json`, `integrations/demos/agent-aml/test/manifest.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run test/manifest.test.ts` -> 7 passed
  - `pnpm lab validate agent-aml` -> `agent-aml: manifest ok, no featured trace yet`
- Done when: Task 18's steps are checked off and the gate output matches.

### Packet 13-P19: Environment file and one-time cloud setup
- Tasks: 19
- Depends on: 13-P18, 13-V0   Shared runtime: cloud-account
- Files owned: `integrations/demos/agent-aml/.env.example`
- Model: coordinator   Effort: M
- Gate:
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/agent-aml/.env.example` -> 8
  - `pnpm lab db-init agent-aml` -> `database harbor_core ready (TiDB v` followed by the version
  - the resources created in Task 19 are listed in the packet report so 13-R can tear them down
- Done when: Task 19's steps are checked off and the gate output matches.

### Packet 13-P20: Starter pool helpers
- Tasks: 20
- Depends on: 13-P10, 13-P16, 13-P19   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/starter.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 20's steps are checked off and the gate output matches.

### Packet 13-P21: Filesystem, Lake and export adapters with smoke script
- Tasks: 21 (typecheck only; the live smoke commands run in the verify packets)
- Depends on: 13-P11, 13-P13, 13-P14, 13-P15, 13-P17, 13-P20   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/live/cli.ts`, `integrations/demos/agent-aml/runner/src/live/sinks.ts`, `integrations/demos/agent-aml/runner/src/live/context.ts`, `integrations/demos/agent-aml/runner/src/live/filesystem.ts`, `integrations/demos/agent-aml/runner/src/live/lake.ts`, `integrations/demos/agent-aml/runner/src/live/exports.ts`, `integrations/demos/agent-aml/runner/smoke.ts`
- Model: sonnet   Effort: L
- Gate:
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: the adapters and `smoke.ts` compile against the real kit.

### Packet 13-V1: Verify Filesystem behavior live
- Tasks: none (docs only; runs `smoke fs`)
- Depends on: 13-P21   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/13-agent-aml.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run `pnpm --filter @lab/demo-agent-aml smoke fs`, paste the real output into section 4):
  - the `ti fs` output the kit parses, and the quote of each value the plan reads (layer id, diff changes, verify result)
  - limits on layers and checkpoints and the measured `create-layer` and `commit-layer` times (create ten small layers in a loop and delete them; record any limit error)
  - that `copy-file --layer-id --overwrite` on an existing base file shows in `diff-layer` and lands on the base after `commit-layer` (edit the smoke to overwrite `/harbor/skills/structuring-triage.md` in a layer, then restore it)
  - that a vault grant's delegated token reads `watchlist-api/KEY` and nothing else
- Gate:
  - `pnpm --filter @lab/demo-agent-aml smoke fs` -> the seven lines quoted in Task 21
  - `grep -c UNVERIFIED integrations/docs/plans/13-agent-aml.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed Filesystem fact without a recorded workaround.

### Packet 13-V2: Verify branch behavior live
- Tasks: none (docs only; runs `smoke branch`)
- Depends on: 13-V1   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/13-agent-aml.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm:
  - how to reach a branch: host, port, user and password source, from the kit's `waitActive` result or the console (run `pnpm --filter @lab/demo-agent-aml smoke branch`)
  - that a branch created with `parentTimestamp` two seconds before now contains a row written one second earlier (write a marker row to the instance, wait one second, create the branch, count the marker on it, then delete the branch)
  - the real branch creation seconds
  - how branch usage bills, from the Starter pricing page, recorded as a formula in section 5
- Gate:
  - `pnpm --filter @lab/demo-agent-aml smoke branch` -> `branch-created`, `branch-create-seconds`, `branch-tables`, `branch-removed` lines
  - `ticloud serverless branch list -c "$AML_CLUSTER_ID"` -> no branches left
  - `grep -c UNVERIFIED integrations/docs/plans/13-agent-aml.md` -> lower than before
- Done when: `testRuleOnBranch` has a confirmed way to connect, or a recorded workaround.

### Packet 13-V3: Verify the export to Lake path live
- Tasks: none (docs only; runs `smoke lake` and one manual export)
- Depends on: 13-V2   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/13-agent-aml.md` (section 4 only)
- Model: sonnet   Effort: M
- Items to confirm:
  - run one `ticloud serverless export create` for a 100 row `transactions` table (use the printed, redacted arguments from `buildExportArgs`) and paste the real create output, the `export describe` output while running and when done, and the S3 key listing (`aws s3 ls --recursive`); correct `parseExportId`, `exportState` and the stage `PATTERN` in `13-P21b`
  - the Parquet types written for `DATETIME(3)` and `BIGINT` and whether `COPY INTO ... FILE_FORMAT = (TYPE = PARQUET)` loads them into the `harbor.txn_history` `TIMESTAMP` and `BIGINT` columns; same for the NDJSON `YYYY-MM-DD HH:MM:SS` strings into `TIMESTAMP`
  - that `EXECUTE TASK harbor_load` works while the minute schedule is running
  - which Lake regions pair with an aws-us-east-1 bucket and the Starter instance
  - that the kit's Lake `query` returns rows as objects keyed by column name
- Gate:
  - `pnpm --filter @lab/demo-agent-aml smoke lake` -> `lake-setup-ok` and four `lake-<table> 0` lines
  - `grep -c UNVERIFIED integrations/docs/plans/13-agent-aml.md` -> lower than before
- Done when: the setup phase's export, load and count check has confirmed real behavior or a recorded workaround.

### Packet 13-V4: Verify hybrid recall and index freshness live
- Tasks: none (docs only; runs `smoke recall`)
- Depends on: 13-V3   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/13-agent-aml.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm:
  - `pnpm --filter @lab/demo-agent-aml smoke recall` returns three `PAST-` ids including at least one structuring case, and `EXPLAIN` on the generated SQL shows `annIndex:` and `textSearch:` operators
  - the delay between inserting a watchlist row or an `episodic_memory` row and `fts_match_word` or the vector index returning it (insert, then poll once a second); record the seconds and adjust the poll counts in `awaitWatchlistEntry` and `awaitRecallOf` in `13-P21b` if needed
- Gate:
  - `pnpm --filter @lab/demo-agent-aml smoke recall` -> `recall-ms` then `recall-top` with three ids
  - `grep -c UNVERIFIED integrations/docs/plans/13-agent-aml.md` -> lower than before
- Done when: recall and rescreening have measured freshness numbers.

### Packet 13-P21b: Apply verify findings to the adapters
- Tasks: amendments to Tasks 14, 16, 20 and 21 recorded by 13-V0 to 13-V4
- Depends on: 13-V0, 13-V1, 13-V2, 13-V3, 13-V4   Shared runtime: cloud-account
- Files owned: `integrations/demos/agent-aml/runner/src/live/filesystem.ts`, `integrations/demos/agent-aml/runner/src/live/lake.ts`, `integrations/demos/agent-aml/runner/src/live/exports.ts`, `integrations/demos/agent-aml/runner/src/exportParse.ts`, `integrations/demos/agent-aml/runner/src/lakeSql.ts`, `integrations/demos/agent-aml/runner/src/starter.ts`, `integrations/demos/agent-aml/runner/test/configAndQueue.test.ts`, `integrations/demos/agent-aml/runner/test/lakeSql.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml test` -> every test file passes
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
  - all four smoke commands print the lines quoted in Task 21
- Done when: every workaround recorded in section 4 is in code with a test for the pure part.

### Packet 13-P22: Setup and traffic flows
- Tasks: 22
- Depends on: 13-P21b   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/live/setup.ts`, `integrations/demos/agent-aml/runner/src/live/traffic.ts`
- Model: sonnet   Effort: L
- Gate:
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 22's steps are checked off and the gate output matches.

### Packet 13-P23: Investigation and learning flows
- Tasks: 23
- Depends on: 13-P22   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/src/live/investigate.ts`, `integrations/demos/agent-aml/runner/src/live/learn.ts`
- Model: sonnet   Effort: L
- Gate:
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 23's steps are checked off and the gate output matches.

### Packet 13-P24: Entry point, teardown and the emitted-ids guard
- Tasks: 24
- Depends on: 13-P23   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/runner/main.ts`, `integrations/demos/agent-aml/runner/teardown.ts`, `integrations/demos/agent-aml/test/emitted-ids.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-agent-aml exec vitest run test/emitted-ids.test.ts` -> 10 passed
  - `pnpm --filter @lab/demo-agent-aml test` -> 21 test files and 175 tests passed
  - `pnpm --filter @lab/demo-agent-aml typecheck` -> exit 0
- Done when: Task 24's steps are checked off and the gate output matches.

### Packet 13-P25: End-to-end live run through the relay
- Tasks: 25
- Depends on: 13-P24   Shared runtime: cloud-account
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: L
- Gate:
  - every command in Task 25 produces the output the task quotes; the coordinator pastes that output into the packet report
  - `ticloud serverless branch list -c "$AML_CLUSTER_ID"` -> shows the case branch only until teardown
- Done when: Task 25's steps are checked off and all five checks reached `pass` in the live stream.

### Packet 13-V5: Verify the teardown commands
- Tasks: none (docs only; runs section 5 steps 1 to 6)
- Depends on: 13-P25   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/13-agent-aml.md` (sections 4 and 5 only)
- Model: coordinator   Effort: S
- Items to confirm:
  - run `pnpm --filter @lab/demo-agent-aml teardown` and paste its output
  - the flags of `ticloud serverless branch delete`, the command that deletes a Starter instance, and whether a Lake warehouse can be suspended from SQL; otherwise record the console path in section 5
  - that `ti fs list-file-systems` no longer shows the deleted file system
- Gate:
  - `pnpm --filter @lab/demo-agent-aml teardown` -> one `ok` or `skipped` line per object and the closing reminder
  - `grep -c UNVERIFIED integrations/docs/plans/13-agent-aml.md` -> 0, or every remaining item says why it cannot be checked
- Done when: section 5 lists commands that were actually run.

### Packet 13-P26: Public-content gate
- Tasks: 26
- Depends on: 13-V5   Shared runtime: none
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - `pnpm lab check-public` -> `0 findings`
- Done when: the command passes.

### Packet 13-P27: README and TALK-TRACK
- Tasks: 27
- Depends on: 13-P26   Shared runtime: none
- Files owned: `integrations/demos/agent-aml/README.md`, `integrations/demos/agent-aml/TALK-TRACK.md`
- Model: sonnet   Effort: M
- Gate:
  - `grep -c $(printf '\342\200\224') integrations/demos/agent-aml/README.md integrations/demos/agent-aml/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
- Done when: Task 27's steps are checked off and the gate output matches.

### Packet 13-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 13-P27   Shared runtime: cloud-account
- Files owned: `integrations/demos/agent-aml/traces/featured.json`
- Model: coordinator   Effort: L
- Gate:
  - `pnpm lab validate agent-aml` -> `agent-aml: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story at 4x to 8x playback, every number carries its simulated or measured label, and nothing is left billing.
