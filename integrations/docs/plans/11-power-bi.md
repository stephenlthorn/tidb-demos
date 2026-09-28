# Plan 11: Power BI + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a business team that one TiDB cluster can serve a live order pipeline and a Power BI dashboard at the same time, with no nightly ETL job and no separate warehouse, and prove it with side-by-side TiKV vs TiFlash query latency, write isolation under dashboard load, and measured write-to-dashboard freshness.

**Architecture:** A TypeScript runner writes a continuous stream of synthetic orders into a TiDB `orders` table, adds a TiFlash replica live, then replays the exact SQL a Power BI report's three visuals use, once forced to TiKV and once forced to TiFlash, timing both paths every tick. The same runner measures order-write p99 with and without that dashboard load, and measures freshness by timing how long a "heartbeat" order takes to become visible in a TiFlash-routed query after it commits. A real Power BI Desktop report, running in a Windows environment because Power BI Desktop is Windows-only, connects to the same TiDB cluster using the identical SQL (via the MySQL connector's Native SQL statement option) and is screen-recorded separately; that recording is not part of the runner's event stream, only its companion video.

**Tech Stack:** Node 22, TypeScript strict, `@lab/runner-kit`, `mysql2`, Vitest. Windows environment for Power BI Desktop only (Azure Windows VM, primary path; Windows 365 Cloud PC or a local Parallels/UTM Windows VM as alternatives).

**Depends on:** Plan 00 (platform).

---

## 1. Why this demo

- **The question customers ask:** "Our dashboards run off last night's warehouse copy. Can we point Power BI straight at the operational database instead, without the analytics queries slowing down checkout?"
- **Pattern:** Business teams that want live dashboards on operational data without a nightly ETL job into a separate warehouse.
- **What TiDB proves here:**
  - The same rows a customer just wrote are queryable by an analytical (TiFlash-routed) query within a measured, small number of milliseconds - no overnight batch required.
  - Dashboard-shaped aggregation queries (`GROUP BY` revenue by category, orders by region, orders over time) run measurably faster against the TiFlash replica than against TiKV row storage, on the same data.
  - Order-write latency (p99) stays flat while the dashboard query set runs continuously against TiFlash, but visibly degrades when the same query set is forced onto TiKV instead - because TiFlash is a separate storage engine, not a shared read replica of the row store.
  - A single connection string works for both the OLTP application and a standard BI tool, because TiDB speaks the MySQL wire protocol.
- **What this demo does not claim:**
  - Power BI does not stream live - see the Honesty note in section 2. Its native MySQL connector only supports Import mode (section 4), so what is "live" is the *database*, not Power BI's in-memory model, until the report is refreshed.
  - This does not replace a warehouse for heavy historical/BI workloads across many subject areas; it targets the class of dashboard that today waits on a nightly copy for no reason other than "that's how the pipeline works."
  - TiFlash replication lag is measured, not asserted to be zero. Whatever the heartbeat check reports on the day of recording is the number reported.

## 2. What the audience sees

### Flow diagram

```
[order-workload] ──writes──────▶ [tidb: TiKV rows] ──replication──▶ [tiflash: columnar replica]
    (source)                            │                                    │
                                 tikv-dashboard                      tiflash-dashboard
                                        │                                    │
                                        └──────────────▶ [power-bi] ◀────────┘
                                                     (Power BI report)
```

**Honesty note (per the platform's global rule #2):** Power BI cannot push events into this lab UI - there is no hook for that in Power BI Desktop or the Service. So the runner replays the *exact* SQL text the Power BI report is configured to send (the three queries in `runner/src/dashboardQueries.ts`, pinned into the report via the MySQL connector's "Native SQL statement" advanced option - verified in section 4) on a timer, against the same cluster, and labels every one of those metrics **"Power BI query set, replayed by runner."** A screen recording of the actual Power BI Desktop report, refreshing against the same cluster, is a separate video file that accompanies the replay on the website (see section 8); it is not decoded into trace events.

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | `intro` | Why this demo | Order workload starts; all nodes shown idle/healthy. | A business team wants a live dashboard on operational orders, not a copy that is a day old. One TiDB cluster is about to serve both the checkout writes and the report. |
| 2 | `seed-baseline` | Baseline writes | Orders flow in with no dashboard load; write p99 baseline is captured. | Orders are flowing into TiDB now, no dashboard load yet. This write p99 is the baseline we compare against once the dashboard starts querying. |
| 3 | `tiflash-replica` | Add the TiFlash replica | Runner issues `ALTER TABLE orders SET TIFLASH REPLICA`; sync progress climbs live. | Adding a TiFlash replica to the orders table live: this is the columnar copy the dashboard will read from, syncing from the same rows being written right now. |
| 4 | `dashboard-on-tikv` | Dashboard load on TiKV | Dashboard load control fires automatically, routed to TiKV; write p99 degrades. | Routing the dashboard's query set at TiKV, the same engine handling the writes. Watch the write p99 line: this is what a warehouse-free dashboard used to cost you. |
| 5 | `dashboard-on-tiflash` | Dashboard load on TiFlash | Routing flips to TiFlash; write p99 recovers; snapshot-totals check runs. | Same dashboard queries, same concurrency, now routed to TiFlash. Write p99 comes back down: the analytical load is isolated on its own replica. |
| 6 | `freshness-check` | Freshness check | A heartbeat order is written; the runner times until it is visible via TiFlash. | A heartbeat order just committed. Watch how many milliseconds until it is visible in a TiFlash-routed dashboard query - that is the real replication lag, not a marketing number. |
| 7 | `power-bi-live` | The real Power BI report | Cue to cut to the external Power BI Desktop screen recording. | Cutting to a real Power BI Desktop report connected to this same cluster. Refreshing it pulls in the orders written during this run. |
| 8 | `wrap-up` | Recap | Final metrics and checks are recapped on screen. | No nightly ETL job, one cluster, a dashboard that is current to the second, and writes that never noticed the analytics running next to them. |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `start-dashboard-load` | Start dashboard load | Begins the heavier concurrent replay (`DASHBOARD_LOAD_CONCURRENCY` workers per tick) of the 3-query dashboard set against whichever engine is currently routed. Fires automatically at phase `dashboard-on-tikv` if not pressed manually first. |
| `route-to-tikv` | Route dashboard to TiKV | Points the heavier dashboard load at TiKV, the same engine serving writes. |
| `route-to-tiflash` | Route dashboard to TiFlash | Points the heavier dashboard load at the TiFlash replica, isolated from the write path. |
| `write-burst` | Write burst | Multiplies the order write rate by `WRITE_BURST_FACTOR` for `WRITE_BURST_DURATION_MS`. |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `tiflash-replica-available` | TiFlash replica available | `information_schema.tiflash_replica.AVAILABLE = 1` for the `orders` table. |
| `snapshot-totals-match` | TiKV and TiFlash totals match at a snapshot | `SELECT SUM(amount) FROM orders AS OF TIMESTAMP <snapshot>` returns the identical value whether the session is forced to read TiKV or TiFlash. |
| `write-p99-within-threshold` | Write p99 stays within threshold under dashboard load | `write-p99-degradation <= WRITE_P99_DEGRADATION_THRESHOLD_PCT` while the dashboard is routed to TiFlash. |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `dashboard-p50-tikv` | Dashboard query p50 (TiKV) | ms | series | lower | Each tick: dedicated connection runs `SET SESSION tidb_isolation_read_engines = 'tikv'`, then each of the 3 queries in `DASHBOARD_QUERIES` is timed with `timed()`; `summarize()` over the tick's samples gives p50. |
| `dashboard-p99-tikv` | Dashboard query p99 (TiKV) | ms | series | lower | Same measurement, `p99` field of the same `summarize()` result. |
| `dashboard-p50-tiflash` | Dashboard query p50 (TiFlash) | ms | series | lower | Same measurement with `tidb_isolation_read_engines = 'tiflash'`. |
| `dashboard-p99-tiflash` | Dashboard query p99 (TiFlash) | ms | series | lower | Same measurement with `tidb_isolation_read_engines = 'tiflash'`, `p99` field. |
| `write-p99` | Order write p99 | ms | series | lower | Every order `INSERT` timed with `timed()`, pushed into a `createSampleWindow()`; `summarize()` per tick. |
| `write-p99-degradation` | Write p99 degradation under dashboard load | % | tile | lower | `degradationPct({ baselineP99Ms, currentP99Ms })` from `src/metrics.ts`; baseline is `write-p99` captured during `seed-baseline`. |
| `freshness-ms` | Data freshness (write to visible) | ms | both | lower | `freshnessMs({ committedAtMs, visibleAtMs })` from `src/metrics.ts`: `committedAtMs` is `emitter.elapsedMs()` right after a heartbeat order's `INSERT` commits; `visibleAtMs` is `emitter.elapsedMs()` at the first tick a TiFlash-forced probe query returns that row. |
| `tiflash-replica-progress` | TiFlash replica sync progress | % | tile | higher | `SELECT AVAILABLE, PROGRESS FROM information_schema.tiflash_replica WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'`, `PROGRESS` (0.0-1.0) times 100. |
| `orders-written-total` | Orders written | rows | tile | neutral | Cumulative count of committed `INSERT`s against `orders`, incremented once per successful write. |

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| Power BI's MySQL database connector requires the Oracle MySQL Connector/NET package installed on the Power BI Desktop machine (and on the on-premises gateway machine, if a gateway is used) | https://learn.microsoft.com/en-us/power-query/connectors/mysql-database | Verified |
| The MySQL database connector's only supported capability is Import; DirectQuery is not listed or supported | https://learn.microsoft.com/en-us/power-query/connectors/mysql-database | Verified |
| The MySQL connector's advanced options include "Native SQL statement," letting a query be pinned to exact SQL text instead of Power Query auto-generating it | https://learn.microsoft.com/en-us/power-query/connectors/mysql-database | Verified. This is why the plan pins the report's 3 visuals to the exact text in `dashboardQueries.ts` instead of guessing what Power Query would auto-generate or fold. |
| An on-premises data gateway is only required for Power BI Service when the MySQL-compatible server "isn't cloud accessible"; Power BI Desktop itself never needs a gateway | https://learn.microsoft.com/en-us/power-query/connectors/mysql-database | Verified for Desktop (used in this demo). **UNVERIFIED**: whether Power BI Service reliably classifies a TiDB Cloud public endpoint as cloud-accessible without a gateway - only relevant if this demo is later extended to publish to the Service; confirm by adding the data source in the Power BI Service UI and watching whether it prompts for a gateway. |
| The MySQL connector is supported only on the on-premises data gateway's standard mode, not personal mode | https://learn.microsoft.com/en-us/power-query/connectors/mysql-database | Verified (not exercised by this plan, which uses Power BI Desktop only). |
| docs.pingcap.com has no dedicated Power BI connection guide; the closest official material is the general JDBC/ODBC "Connect to TiDB" developer guide | https://docs.pingcap.com/tidb/stable/dev-guide-connect-to-tidb/ | Verified absence as of this writing. **UNVERIFIED**: search docs.pingcap.com for "Power BI" again immediately before publishing, in case a dedicated guide has since been added. |
| TiFlash replicas are added with `ALTER TABLE <table> SET TIFLASH REPLICA <count>` | https://docs.pingcap.com/tidb/stable/create-tiflash-replicas/ | Verified |
| `information_schema.tiflash_replica` has an `AVAILABLE` column (1 once at least one replica has finished syncing) and a `PROGRESS` column (0.0-1.0) | https://docs.pingcap.com/tidbcloud/information-schema-tiflash-replica/ | Verified |
| The `READ_FROM_STORAGE(TIFLASH[t1], TIKV[t2])` optimizer hint forces specific tables to specific storage engines | https://docs.pingcap.com/tidb/stable/use-tidb-to-read-tiflash/ and https://docs.pingcap.com/tidb/stable/optimizer-hints/ | Verified. This plan uses the session-variable form instead (below) because it applies uniformly to the whole dashboard query set without editing each query's hint list. |
| `tidb_isolation_read_engines` is a session variable, set with `SET SESSION tidb_isolation_read_engines = '<engines>'`, default `tikv,tiflash,tidb` (optimizer picks) | https://docs.pingcap.com/tidb/stable/use-tidb-to-read-tiflash/ | Verified |
| TiDB Cloud Starter supports TiFlash/columnar storage: "Columnar storage in TiDB Cloud Starter acts as an additional replica of row-based storage, ensuring strong consistency," backed by "a separate elastic TiFlash engine." Starter's free quota is 5 GiB row + 5 GiB columnar storage. | https://docs.pingcap.com/tidbcloud/select-cluster-tier/ and https://docs.pingcap.com/tidbcloud/serverless-faqs/ | Re-verified 2026-09-28. This demo's `ALTER TABLE orders SET TIFLASH REPLICA 1` (task 22/`tidbAdapters.ts`) works unmodified on Starter - no infra change needed for the plan's TiFlash-adding phase. |
| For a TiDB Cloud Starter cluster the TiFlash replica count can only be 2: "If you set it to 1, it will be automatically adjusted to 2 for execution. If you set it to a number larger than 2, you will get an error." | https://docs.pingcap.com/tidbcloud/create-tiflash-replicas/ | Verified 2026-09-28. Not a blocker: the runner requests replica count 1, Starter silently upgrades it to 2, and `information_schema.tiflash_replica.AVAILABLE`/`PROGRESS` still report correctly against whatever count TiDB actually created. |
| `AS OF TIMESTAMP '<literal>'` (or `TIDB_BOUNDED_STALENESS(...)`) reads historical data as of a point in time, bounded by the GC safe point (`tidb_gc_life_time`) | https://docs.pingcap.com/tidb/stable/as-of-timestamp/ and https://docs.pingcap.com/tidb/stable/garbage-collection-overview/ | Verified. The snapshot used by `snapshot-totals-match` is taken only a few seconds in the past, comfortably inside any default GC retention window, so this plan does not depend on a specific retention duration. |
| `information_schema.statements_summary` (and `statements_summary_history`) expose `DIGEST_TEXT`, `QUERY_SAMPLE_TEXT`, `EXEC_COUNT`, and latency columns per statement digest, controlled by `tidb_enable_stmt_summary` | https://docs.pingcap.com/tidb/stable/statement-summary-tables/ | Verified. Used in task 22 only to *confirm* Power BI sent the pinned SQL verbatim, not to discover it. |
| `ticloud serverless create --region <region>` and `ticloud serverless delete --cluster-id <id>` manage TiDB Cloud Starter/Essential clusters from the CLI; `ticloud` is in public preview and does not cover Dedicated clusters | https://docs.pingcap.com/tidbcloud/get-started-with-cli/ and https://docs.pingcap.com/tidbcloud/ticloud-cluster-delete/ | Verified |
| TiDB Cloud's IP access list supports an explicit "allow access from anywhere" option in addition to scoped IP entries | https://docs.pingcap.com/tidbcloud/configure-ip-access-list/ | Verified |
| Power BI Desktop is Windows-only; Microsoft added support for Windows on Arm (via x86 emulation) as of a 2025-09 cumulative update, which is why it can run inside an Apple Silicon Mac's Windows VM | https://community.fabric.microsoft.com/t5/Desktop/Power-BI-Native-ARM-on-Windows-11-ARM-edition/m-p/5177718 and https://www.parallels.com/apps/power-bi/ | Verified |
| Azure Windows VMs can be created and torn down from the CLI, and expose RDP by default | https://learn.microsoft.com/en-us/azure/virtual-machines/windows/quick-create-cli | Verified |
| Windows 365 Cloud PC gives a full Windows desktop reachable from a Mac browser or the Remote Desktop app, billed per seat per month regardless of hours used | General Windows 365 product documentation | **UNVERIFIED** - confirm current plans and whether an hourly/short-term option exists at the Windows 365 pricing page before choosing it over the Azure VM path for a one-off recording. |
| Power BI Desktop is a free download and does not require a paid Power BI license to connect to a live data source and build a report locally | Not confirmed against an official source in this pass | **UNVERIFIED** - confirm on the Power BI Desktop download/licensing page before relying on it; if a license turns out to be required, use whatever Power BI license PingCAP already provides. |

**Note (2026-09-28): this recording used AWS, not Azure, for the Windows box.** Sections 1, 5, 8, and 9 above describe an Azure Windows VM path; the actual Terraform for this recording is `demos/power-bi/infra/windows/` (a single EC2 Windows Server instance in us-west-2), driven over RDP, with teardown by `terraform destroy`. The Azure text is left as a documented alternative, not updated line-by-line, to keep this edit scoped; treat `infra/windows/` and the README's "Record" section as the source of truth for how this demo was actually run. Facts verified for the AWS path:

| Fact | Source | Status |
|---|---|---|
| AWS publishes the latest Windows Server 2022 English Full Base AMI ID as a public SSM parameter at `/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base`, consumable from Terraform via `data "aws_ssm_parameter"` | https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/finding-an-ami-parameter-store.html | Verified 2026-09-28 |
| `aws_instance` exposes `get_password_data` (bool) and, if true, an exported `password_data` (still-encrypted, base64) attribute; the actual decrypt step is the separate `aws ec2 get-password-data --instance-id <id> --priv-launch-key <pem>` CLI call, which needs the PEM matching the key pair the instance was launched with | https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/instance (`get_password_data`/`password_data` arguments) | Verified 2026-09-28. This plan's Terraform does not set `get_password_data = true` on the instance (avoids storing even the encrypted blob in state); it instead outputs the exact `aws ec2 get-password-data` command for the coordinator to run directly. |
| Power BI Desktop's current x64 installer direct download (version-specific URL, rotates per release) | https://www.microsoft.com/en-us/download/details.aspx?id=58494 -> `https://download.microsoft.com/download/8/8/0/880bca75-79dd-466a-927d-1abf1f5454b0/PBIDesktopSetup_x64.exe` (v2.157.1354.0 as of this check) | Verified 2026-09-28. **Re-check before applying**: this URL's GUID segment changes with each Power BI Desktop release; `infra/windows/variables.tf`'s `power_bi_installer_url` default will go stale. |
| The Power BI Desktop x64 `.exe` installer (a bootstrapper, not a bare MSI) accepts silent switches `-quiet -norestart ACCEPT_EULA=1`, plus optional `INSTALLDESKTOPSHORTCUT=0`/`DISABLE_UPDATE_NOTIFICATION=1` | Community-documented switches (Microsoft Fabric/Power BI community threads); no first-party CLI reference page found | Verified against multiple independent community sources 2026-09-28; not an official Microsoft doc page. `infra/windows/user_data.ps1.tpl` uses this exact switch set. |
| MySQL Connector/NET's current version (26.7.0) and its direct MSI download URL, reached via the download page's "No thanks, just start my download" link | https://dev.mysql.com/downloads/connector/net/ -> https://dev.mysql.com/get/Downloads/Connector-Net/mysql-connector-net-26.7.0.msi | Verified 2026-09-28. **Re-check before applying**: this URL is version-specific and will go stale as Oracle ships new Connector/NET releases; `infra/windows/variables.tf`'s `mysql_connector_net_url` default will need bumping. |
| `msiexec /i <path> /quiet /norestart` installs an MSI unattended with no dialog | https://dev.mysql.com/doc/connectors/en/connector-net-installation-binary-windows-installer.html | Verified. `infra/windows/user_data.ps1.tpl` uses this exact form for the MySQL Connector/NET MSI. |

## 5. Prerequisites, cost, and teardown

- **Accounts and access:**
  - A TiDB Cloud account able to create a cluster on the Starter or Essential tier (whichever the account can create; re-confirm TiFlash support and tier names at the section 4 URL first), with the `ticloud` CLI authenticated (`ticloud auth login`).
  - Either an Azure subscription (primary path, scriptable teardown) or a Windows 365 Cloud PC license or an existing licensed Windows VM under Parallels Desktop/UTM (alternatives - see task 19).
  - A Microsoft account to download and run Power BI Desktop.
- **Local tools:** macOS, tiup, Node 22, pnpm, the `ticloud` CLI, the `az` CLI (only if using the Azure VM path). Docker Desktop is not required for this specific demo (no container-based infra).
- **Cost model:**
  - TiDB Cloud cluster: bills per the selected tier's own pricing page (linked from the tier-selection doc in section 4); no price is hardcoded here. Delete the cluster right after recording (below).
  - Azure Windows VM: bills per vCPU-hour for the chosen VM size while running; see the Azure Windows VM pricing page for the current rate. Deallocate and delete it right after recording (below).
  - Windows 365 Cloud PC (alternative): bills per seat per month regardless of hours used; see the Windows 365 pricing page. For a single recording session, the Azure VM path is cheaper because it can be destroyed the same day.
- **Teardown (exact commands):**

```bash
# TiDB Cloud cluster (Starter/Essential, created via ticloud)
ticloud serverless delete --cluster-id <cluster-id>
ticloud serverless list                          # expect: <cluster-id> no longer listed

# Azure Windows VM
az vm deallocate --resource-group lab-power-bi-rg --name lab-power-bi-vm
az group delete --name lab-power-bi-rg --yes --no-wait
az group show --name lab-power-bi-rg             # expect: ResourceGroupNotFound once deletion completes

# Local tiup playground (if used for day-to-day development instead of TiDB Cloud)
tiup clean lab
```

## 6. File structure

```
demos/power-bi/
  manifest.json              diagram, metrics, phases, controls, checks for this demo; validated by DemoManifestSchema
  package.json                @lab/demo-power-bi workspace package
  tsconfig.json                extends ../../tsconfig.base.json
  .env.example                 standard TiDB env block plus write-rate/burst/threshold config
  README.md                    what it proves, prerequisites, run/record/teardown, cost notes
  TALK-TRACK.md                 presenter script per phase, discovery questions, objections and honest answers
  test/
    manifest.test.ts            parses manifest.json against DemoManifestSchema
  runner/
    main.ts                     orchestrates the live run: connects to TiDB, drives the tick loop, wires controls, emits every event type
    setup.ts                    one-time schema creation + baseline seed, run once before a recording
    src/
      routing.ts                 pure: routing engine -> isolation-engines SQL text
      metrics.ts                 pure: freshness and write-p99-degradation math
      orderGenerator.ts           pure: deterministic order and heartbeat-order builders
      writeLoadPlan.ts            pure: orders-per-tick under baseline/burst
      timeline.ts                 pure: elapsed ms -> phase id
      dashboardQueries.ts          the exact 3 SQL statements the dashboard replays (and that Power BI Desktop is configured with, verbatim)
      schema.ts                   the orders table DDL
    test/
      routing.test.ts
      metrics.test.ts
      orderGenerator.test.ts
      writeLoadPlan.test.ts
      timeline.test.ts
      dashboardQueries.test.ts
      schema.test.ts
  traces/
    featured.json                the committed recording the website plays back (added in section 8)
```

## 7. Tasks

All commands below run from the `integrations/` repository root unless a task says otherwise. Vitest commands target this demo's own workspace package.

### Pure logic (TDD)

- [ ] **Task 1 - `routing.ts`: engine to isolation-engine list.**

  Write the failing test `demos/power-bi/runner/test/routing.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { isolationEnginesFor } from '../src/routing';

  describe('isolationEnginesFor', () => {
    it('returns only tikv for the tikv engine', () => {
      expect(isolationEnginesFor('tikv')).toEqual(['tikv']);
    });

    it('returns only tiflash for the tiflash engine', () => {
      expect(isolationEnginesFor('tiflash')).toEqual(['tiflash']);
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/routing.test.ts`
  Expected: FAIL - `Cannot find module '../src/routing'`.

  Add the minimal implementation, `demos/power-bi/runner/src/routing.ts`:

  ```ts
  export type RoutingEngine = 'tikv' | 'tiflash';

  export const isolationEnginesFor = (engine: RoutingEngine): readonly string[] => {
    if (engine === 'tikv') return ['tikv'];
    return ['tiflash'];
  };
  ```

  Run the same command again.
  Expected: PASS - 2 tests passed.

  Commit: `git add demos/power-bi/runner/src/routing.ts demos/power-bi/runner/test/routing.test.ts && git commit -m "power-bi: add isolationEnginesFor routing"`

- [ ] **Task 2 - `routing.ts`: exact SQL to force an engine.**

  Extend the failing test in `demos/power-bi/runner/test/routing.test.ts` by adding:

  ```ts
  import { isolationEnginesFor, setIsolationEnginesStatement } from '../src/routing';

  describe('setIsolationEnginesStatement', () => {
    it('builds the exact SQL to force tikv', () => {
      expect(setIsolationEnginesStatement('tikv')).toBe(
        "SET SESSION tidb_isolation_read_engines = 'tikv'",
      );
    });

    it('builds the exact SQL to force tiflash', () => {
      expect(setIsolationEnginesStatement('tiflash')).toBe(
        "SET SESSION tidb_isolation_read_engines = 'tiflash'",
      );
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/routing.test.ts`
  Expected: FAIL - `setIsolationEnginesStatement is not exported`.

  Add to `demos/power-bi/runner/src/routing.ts`:

  ```ts
  export const setIsolationEnginesStatement = (engine: RoutingEngine): string =>
    `SET SESSION tidb_isolation_read_engines = '${isolationEnginesFor(engine).join(',')}'`;
  ```

  Run again. Expected: PASS - 4 tests passed.

  Commit: `git add demos/power-bi/runner/src/routing.ts demos/power-bi/runner/test/routing.test.ts && git commit -m "power-bi: add setIsolationEnginesStatement"`

- [ ] **Task 3 - `metrics.ts`: freshness math.**

  Write the failing test `demos/power-bi/runner/test/metrics.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { freshnessMs } from '../src/metrics';

  describe('freshnessMs', () => {
    it('returns the gap between commit and visibility', () => {
      expect(freshnessMs({ committedAtMs: 1_000, visibleAtMs: 1_340 })).toBe(340);
    });

    it('never returns a negative number if visibility is observed before the recorded commit time', () => {
      expect(freshnessMs({ committedAtMs: 1_000, visibleAtMs: 900 })).toBe(0);
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/metrics.test.ts`
  Expected: FAIL - `Cannot find module '../src/metrics'`.

  Add `demos/power-bi/runner/src/metrics.ts`:

  ```ts
  export type FreshnessInput = {
    readonly committedAtMs: number;
    readonly visibleAtMs: number;
  };

  export const freshnessMs = (input: FreshnessInput): number => {
    if (input.visibleAtMs < input.committedAtMs) return 0;
    return input.visibleAtMs - input.committedAtMs;
  };
  ```

  Run again. Expected: PASS - 2 tests passed.

  Commit: `git add demos/power-bi/runner/src/metrics.ts demos/power-bi/runner/test/metrics.test.ts && git commit -m "power-bi: add freshnessMs"`

- [ ] **Task 4 - `metrics.ts`: write p99 degradation math.**

  Extend `demos/power-bi/runner/test/metrics.test.ts`:

  ```ts
  import { degradationPct, freshnessMs } from '../src/metrics';

  describe('degradationPct', () => {
    it('computes the percentage increase over baseline', () => {
      expect(degradationPct({ baselineP99Ms: 20, currentP99Ms: 25 })).toBe(25);
    });

    it('returns 0 when there is no baseline yet', () => {
      expect(degradationPct({ baselineP99Ms: 0, currentP99Ms: 25 })).toBe(0);
    });

    it('returns a negative number when latency improves over baseline', () => {
      expect(degradationPct({ baselineP99Ms: 20, currentP99Ms: 10 })).toBe(-50);
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/metrics.test.ts`
  Expected: FAIL - `degradationPct is not exported`.

  Add to `demos/power-bi/runner/src/metrics.ts`:

  ```ts
  export type DegradationInput = {
    readonly baselineP99Ms: number;
    readonly currentP99Ms: number;
  };

  export const degradationPct = (input: DegradationInput): number => {
    if (input.baselineP99Ms <= 0) return 0;
    return ((input.currentP99Ms - input.baselineP99Ms) / input.baselineP99Ms) * 100;
  };
  ```

  Run again. Expected: PASS - 5 tests passed.

  Commit: `git add demos/power-bi/runner/src/metrics.ts demos/power-bi/runner/test/metrics.test.ts && git commit -m "power-bi: add degradationPct"`

- [ ] **Task 5 - `orderGenerator.ts`: deterministic order builder.**

  Write the failing test `demos/power-bi/runner/test/orderGenerator.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { createOrder } from '../src/orderGenerator';

  const fixedSource = (values: readonly number[]): (() => number) => {
    let index = 0;
    return () => {
      const value = values[index % values.length];
      index += 1;
      return value;
    };
  };

  describe('createOrder', () => {
    it('builds a deterministic order from a fixed random source', () => {
      const order = createOrder({ sequence: 7, randomSource: fixedSource([0, 0, 0.5]) });
      expect(order).toEqual({
        orderId: 'ord-7',
        region: 'us-east',
        productCategory: 'electronics',
        amount: 255,
        isHeartbeat: false,
      });
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/orderGenerator.test.ts`
  Expected: FAIL - `Cannot find module '../src/orderGenerator'`.

  Add `demos/power-bi/runner/src/orderGenerator.ts`:

  ```ts
  export type Order = {
    readonly orderId: string;
    readonly region: string;
    readonly productCategory: string;
    readonly amount: number;
    readonly isHeartbeat: boolean;
  };

  export type RandomSource = () => number;

  const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'] as const;
  const CATEGORIES = ['electronics', 'home', 'outdoor', 'apparel'] as const;

  export type CreateOrderOptions = {
    readonly sequence: number;
    readonly randomSource: RandomSource;
  };

  export const createOrder = (options: CreateOrderOptions): Order => {
    const regionIndex = Math.floor(options.randomSource() * REGIONS.length);
    const categoryIndex = Math.floor(options.randomSource() * CATEGORIES.length);
    const amount = Math.round((10 + options.randomSource() * 490) * 100) / 100;
    return {
      orderId: `ord-${options.sequence}`,
      region: REGIONS[regionIndex],
      productCategory: CATEGORIES[categoryIndex],
      amount,
      isHeartbeat: false,
    };
  };
  ```

  Run again. Expected: PASS - 1 test passed.

  Commit: `git add demos/power-bi/runner/src/orderGenerator.ts demos/power-bi/runner/test/orderGenerator.test.ts && git commit -m "power-bi: add createOrder"`

- [ ] **Task 6 - `orderGenerator.ts`: heartbeat order builder.**

  Extend `demos/power-bi/runner/test/orderGenerator.test.ts`:

  ```ts
  import { createHeartbeatOrder, createOrder } from '../src/orderGenerator';

  describe('createHeartbeatOrder', () => {
    it('builds a marked heartbeat order with a distinct id prefix', () => {
      expect(createHeartbeatOrder({ sequence: 3 })).toEqual({
        orderId: 'hb-3',
        region: 'us-east',
        productCategory: 'heartbeat',
        amount: 0,
        isHeartbeat: true,
      });
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/orderGenerator.test.ts`
  Expected: FAIL - `createHeartbeatOrder is not exported`.

  Add to `demos/power-bi/runner/src/orderGenerator.ts`:

  ```ts
  export type CreateHeartbeatOrderOptions = {
    readonly sequence: number;
  };

  export const createHeartbeatOrder = (options: CreateHeartbeatOrderOptions): Order => ({
    orderId: `hb-${options.sequence}`,
    region: 'us-east',
    productCategory: 'heartbeat',
    amount: 0,
    isHeartbeat: true,
  });
  ```

  Run again. Expected: PASS - 2 tests passed.

  Commit: `git add demos/power-bi/runner/src/orderGenerator.ts demos/power-bi/runner/test/orderGenerator.test.ts && git commit -m "power-bi: add createHeartbeatOrder"`

- [ ] **Task 7 - `writeLoadPlan.ts`: orders per tick under baseline/burst.**

  Write the failing test `demos/power-bi/runner/test/writeLoadPlan.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { ordersPerTick } from '../src/writeLoadPlan';

  describe('ordersPerTick', () => {
    it('writes the base rate when no burst is active', () => {
      expect(ordersPerTick({ baseRatePerSec: 5, burstActive: false, burstFactor: 8 })).toBe(5);
    });

    it('multiplies by the burst factor while a burst is active', () => {
      expect(ordersPerTick({ baseRatePerSec: 5, burstActive: true, burstFactor: 8 })).toBe(40);
    });

    it('never returns fewer than 1 order per tick', () => {
      expect(ordersPerTick({ baseRatePerSec: 0, burstActive: false, burstFactor: 8 })).toBe(1);
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/writeLoadPlan.test.ts`
  Expected: FAIL - `Cannot find module '../src/writeLoadPlan'`.

  Add `demos/power-bi/runner/src/writeLoadPlan.ts`:

  ```ts
  export type OrdersPerTickOptions = {
    readonly baseRatePerSec: number;
    readonly burstActive: boolean;
    readonly burstFactor: number;
  };

  export const ordersPerTick = (options: OrdersPerTickOptions): number => {
    const rate = options.burstActive ? options.baseRatePerSec * options.burstFactor : options.baseRatePerSec;
    return Math.max(1, Math.round(rate));
  };
  ```

  Run again. Expected: PASS - 3 tests passed.

  Commit: `git add demos/power-bi/runner/src/writeLoadPlan.ts demos/power-bi/runner/test/writeLoadPlan.test.ts && git commit -m "power-bi: add ordersPerTick"`

- [ ] **Task 8 - `timeline.ts`: elapsed time to phase id.**

  Write the failing test `demos/power-bi/runner/test/timeline.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { phaseForElapsed } from '../src/timeline';

  describe('phaseForElapsed', () => {
    it('starts in intro', () => {
      expect(phaseForElapsed(0)).toBe('intro');
    });

    it('moves to seed-baseline at 15s', () => {
      expect(phaseForElapsed(15_000)).toBe('seed-baseline');
    });

    it('moves to tiflash-replica at 45s', () => {
      expect(phaseForElapsed(46_000)).toBe('tiflash-replica');
    });

    it('reaches wrap-up by 225s and stays there past the end of the schedule', () => {
      expect(phaseForElapsed(225_000)).toBe('wrap-up');
      expect(phaseForElapsed(999_000)).toBe('wrap-up');
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/timeline.test.ts`
  Expected: FAIL - `Cannot find module '../src/timeline'`.

  Add `demos/power-bi/runner/src/timeline.ts`:

  ```ts
  export type PhaseId =
    | 'intro'
    | 'seed-baseline'
    | 'tiflash-replica'
    | 'dashboard-on-tikv'
    | 'dashboard-on-tiflash'
    | 'freshness-check'
    | 'power-bi-live'
    | 'wrap-up';

  export type PhaseSchedule = {
    readonly phase: PhaseId;
    readonly startsAtMs: number;
  };

  export const PHASE_SCHEDULE: readonly PhaseSchedule[] = [
    { phase: 'intro', startsAtMs: 0 },
    { phase: 'seed-baseline', startsAtMs: 15_000 },
    { phase: 'tiflash-replica', startsAtMs: 45_000 },
    { phase: 'dashboard-on-tikv', startsAtMs: 75_000 },
    { phase: 'dashboard-on-tiflash', startsAtMs: 115_000 },
    { phase: 'freshness-check', startsAtMs: 155_000 },
    { phase: 'power-bi-live', startsAtMs: 195_000 },
    { phase: 'wrap-up', startsAtMs: 225_000 },
  ];

  export const phaseForElapsed = (elapsedMs: number): PhaseId => {
    const reached = PHASE_SCHEDULE.filter((entry) => entry.startsAtMs <= elapsedMs);
    const last = reached[reached.length - 1];
    return last === undefined ? 'intro' : last.phase;
  };
  ```

  Run again. Expected: PASS - 4 tests passed.

  Commit: `git add demos/power-bi/runner/src/timeline.ts demos/power-bi/runner/test/timeline.test.ts && git commit -m "power-bi: add phaseForElapsed timeline"`

- [ ] **Task 9 - `dashboardQueries.ts`: the exact dashboard query set.**

  Write the failing test `demos/power-bi/runner/test/dashboardQueries.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { DASHBOARD_QUERIES } from '../src/dashboardQueries';

  describe('DASHBOARD_QUERIES', () => {
    it('has exactly the 3 queries the Power BI report is pinned to', () => {
      expect(DASHBOARD_QUERIES.map((query) => query.id)).toEqual([
        'revenue-by-category',
        'orders-by-region',
        'orders-last-hour',
      ]);
    });

    it('excludes heartbeat rows from every query', () => {
      DASHBOARD_QUERIES.forEach((query) => {
        expect(query.sql).toContain('is_heartbeat = 0');
      });
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/dashboardQueries.test.ts`
  Expected: FAIL - `Cannot find module '../src/dashboardQueries'`.

  Add `demos/power-bi/runner/src/dashboardQueries.ts`:

  ```ts
  export type DashboardQuery = {
    readonly id: string;
    readonly label: string;
    readonly sql: string;
  };

  export const DASHBOARD_QUERIES: readonly DashboardQuery[] = [
    {
      id: 'revenue-by-category',
      label: 'Revenue by category',
      sql: 'SELECT product_category, SUM(amount) AS revenue, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 GROUP BY product_category',
    },
    {
      id: 'orders-by-region',
      label: 'Orders by region',
      sql: 'SELECT region, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 GROUP BY region',
    },
    {
      id: 'orders-last-hour',
      label: 'Orders per minute (last hour)',
      sql: "SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS minute_bucket, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 AND created_at >= NOW() - INTERVAL 60 MINUTE GROUP BY minute_bucket ORDER BY minute_bucket",
    },
  ];
  ```

  Run again. Expected: PASS - 2 tests passed.

  Commit: `git add demos/power-bi/runner/src/dashboardQueries.ts demos/power-bi/runner/test/dashboardQueries.test.ts && git commit -m "power-bi: add the dashboard query set"`

- [ ] **Task 10 - `schema.ts`: the orders table DDL.**

  Write the failing test `demos/power-bi/runner/test/schema.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { ORDERS_TABLE_DDL } from '../src/schema';

  describe('ORDERS_TABLE_DDL', () => {
    it('creates the columns every dashboard query and check depends on', () => {
      expect(ORDERS_TABLE_DDL).toContain('order_id VARCHAR(32) NOT NULL');
      expect(ORDERS_TABLE_DDL).toContain('is_heartbeat TINYINT NOT NULL DEFAULT 0');
      expect(ORDERS_TABLE_DDL).toContain('PRIMARY KEY (order_id)');
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run runner/test/schema.test.ts`
  Expected: FAIL - `Cannot find module '../src/schema'`.

  Add `demos/power-bi/runner/src/schema.ts`:

  ```ts
  export const ORDERS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS orders (
    order_id VARCHAR(32) NOT NULL,
    region VARCHAR(32) NOT NULL,
    product_category VARCHAR(32) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    is_heartbeat TINYINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (order_id),
    KEY idx_created_at (created_at)
  )`;
  ```

  Run again. Expected: PASS - 1 test passed.

  Commit: `git add demos/power-bi/runner/src/schema.ts demos/power-bi/runner/test/schema.test.ts && git commit -m "power-bi: add orders table DDL"`

- [ ] **Task 11 - manifest.**

  Write the failing test `demos/power-bi/test/manifest.test.ts`:

  ```ts
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { describe, expect, it } from 'vitest';
  import { DemoManifestSchema } from '@lab/contract';

  const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));

  describe('power-bi manifest', () => {
    it('parses against DemoManifestSchema', () => {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const result = DemoManifestSchema.safeParse(raw);
      expect(result.success).toBe(true);
    });

    it('is numbered 11 and published', () => {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const manifest = DemoManifestSchema.parse(raw);
      expect(manifest.number).toBe(11);
      expect(manifest.publish).toBe(true);
    });
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi exec vitest run test/manifest.test.ts`
  Expected: FAIL - `ENOENT: no such file or directory, open '.../demos/power-bi/manifest.json'`.

  Add `demos/power-bi/manifest.json` in full:

  ```json
  {
    "id": "power-bi",
    "number": 11,
    "title": "Live Dashboards on Operational Data: TiDB HTAP with Power BI",
    "tagline": "One TiDB cluster feeds the order pipeline and the Power BI report at the same time, with no nightly ETL job in between.",
    "integrations": ["Power BI", "TiFlash"],
    "pattern": "Business teams that want live dashboards on operational data without a nightly ETL job into a separate warehouse.",
    "publish": true,
    "runner": {
      "command": ["node", "--import", "tsx", "runner/main.ts"],
      "cwd": "."
    },
    "nodes": [
      { "id": "order-workload", "label": "Order workload", "kind": "source", "x": 10, "y": 50 },
      { "id": "tidb", "label": "TiDB (TiKV rows)", "kind": "tidb", "x": 45, "y": 22 },
      { "id": "tiflash", "label": "TiFlash (columnar replica)", "kind": "tidb", "x": 45, "y": 78 },
      { "id": "power-bi", "label": "Power BI report", "kind": "client", "x": 88, "y": 50 }
    ],
    "edges": [
      { "id": "writes", "from": "order-workload", "to": "tidb", "label": "order writes", "unit": "rows/s" },
      { "id": "replication", "from": "tidb", "to": "tiflash", "label": "TiFlash replication", "unit": "rows/s" },
      { "id": "tikv-dashboard", "from": "tidb", "to": "power-bi", "label": "dashboard queries (TiKV)", "unit": "req/s" },
      { "id": "tiflash-dashboard", "from": "tiflash", "to": "power-bi", "label": "dashboard queries (TiFlash)", "unit": "req/s" }
    ],
    "metrics": [
      { "id": "dashboard-p50-tikv", "label": "Dashboard query p50 (TiKV)", "unit": "ms", "display": "series", "better": "lower", "group": "dashboard-latency", "howMeasured": "Once per tick, a dedicated connection runs SET SESSION tidb_isolation_read_engines='tikv', then each of the 3 queries in DASHBOARD_QUERIES is timed with timed(); summarize() over that tick's samples gives p50." },
      { "id": "dashboard-p99-tikv", "label": "Dashboard query p99 (TiKV)", "unit": "ms", "display": "series", "better": "lower", "group": "dashboard-latency", "howMeasured": "Same measurement as dashboard-p50-tikv; this is the p99 field of the same summarize() result for the tick." },
      { "id": "dashboard-p50-tiflash", "label": "Dashboard query p50 (TiFlash)", "unit": "ms", "display": "series", "better": "lower", "group": "dashboard-latency", "howMeasured": "Once per tick, a dedicated connection runs SET SESSION tidb_isolation_read_engines='tiflash', then each of the 3 queries in DASHBOARD_QUERIES is timed with timed(); summarize() over that tick's samples gives p50." },
      { "id": "dashboard-p99-tiflash", "label": "Dashboard query p99 (TiFlash)", "unit": "ms", "display": "series", "better": "lower", "group": "dashboard-latency", "howMeasured": "Same measurement as dashboard-p50-tiflash; this is the p99 field of the same summarize() result for the tick." },
      { "id": "write-p99", "label": "Order write p99", "unit": "ms", "display": "series", "better": "lower", "group": "write-path", "howMeasured": "Every order INSERT is timed with timed() and pushed into a createSampleWindow(); summarize() over that tick's drained samples gives write-p99." },
      { "id": "write-p99-degradation", "label": "Write p99 degradation under dashboard load", "unit": "%", "display": "tile", "better": "lower", "group": "write-path", "howMeasured": "degradationPct({ baselineP99Ms, currentP99Ms }) from src/metrics.ts; baseline is the write-p99 value captured during the seed-baseline phase." },
      { "id": "freshness-ms", "label": "Data freshness (write to visible)", "unit": "ms", "display": "both", "better": "lower", "group": "tiflash", "howMeasured": "freshnessMs({ committedAtMs, visibleAtMs }) from src/metrics.ts: committedAtMs is emitter.elapsedMs() right after a heartbeat order's INSERT commits; visibleAtMs is emitter.elapsedMs() at the first tick a TiFlash-forced probe query returns that row." },
      { "id": "tiflash-replica-progress", "label": "TiFlash replica sync progress", "unit": "%", "display": "tile", "better": "higher", "group": "tiflash", "howMeasured": "SELECT AVAILABLE, PROGRESS FROM information_schema.tiflash_replica WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders', once per tick; PROGRESS (0.0-1.0) times 100." },
      { "id": "orders-written-total", "label": "Orders written", "unit": "rows", "display": "tile", "better": "neutral", "group": "throughput", "howMeasured": "Cumulative count of committed INSERTs against orders since the runner started, incremented once per successful write." }
    ],
    "phases": [
      { "id": "intro", "label": "Why this demo", "narration": "A business team wants a live dashboard on operational orders, not a copy that is a day old. One TiDB cluster is about to serve both the checkout writes and the report." },
      { "id": "seed-baseline", "label": "Baseline writes", "narration": "Orders are flowing into TiDB now, no dashboard load yet. This write p99 is the baseline we compare against once the dashboard starts querying." },
      { "id": "tiflash-replica", "label": "Add the TiFlash replica", "narration": "Adding a TiFlash replica to the orders table live: this is the columnar copy the dashboard will read from, syncing from the same rows being written right now." },
      { "id": "dashboard-on-tikv", "label": "Dashboard load on TiKV", "narration": "Routing the dashboard's query set at TiKV, the same engine handling the writes. Watch the write p99 line: this is what a warehouse-free dashboard used to cost you." },
      { "id": "dashboard-on-tiflash", "label": "Dashboard load on TiFlash", "narration": "Same dashboard queries, same concurrency, now routed to TiFlash. Write p99 comes back down: the analytical load is isolated on its own replica." },
      { "id": "freshness-check", "label": "Freshness check", "narration": "A heartbeat order just committed. Watch how many milliseconds until it is visible in a TiFlash-routed dashboard query - that is the real replication lag, not a marketing number." },
      { "id": "power-bi-live", "label": "The real Power BI report", "narration": "Cutting to a real Power BI Desktop report connected to this same cluster. Refreshing it pulls in the orders written during this run." },
      { "id": "wrap-up", "label": "Recap", "narration": "No nightly ETL job, one cluster, a dashboard that is current to the second, and writes that never noticed the analytics running next to them." }
    ],
    "checks": [
      { "id": "tiflash-replica-available", "label": "TiFlash replica available", "description": "Passes once information_schema.tiflash_replica reports AVAILABLE = 1 for the orders table." },
      { "id": "snapshot-totals-match", "label": "TiKV and TiFlash totals match at a snapshot", "description": "Passes when SUM(amount) AS OF TIMESTAMP <snapshot> for the orders table returns the identical value whether forced to read from TiKV or TiFlash." },
      { "id": "write-p99-within-threshold", "label": "Write p99 stays within threshold under dashboard load", "description": "Passes when the write-p99-degradation metric is at or below WRITE_P99_DEGRADATION_THRESHOLD_PCT while the dashboard is routed to TiFlash." }
    ],
    "controls": [
      { "id": "start-dashboard-load", "label": "Start dashboard load", "description": "Begins the heavier concurrent replay (DASHBOARD_LOAD_CONCURRENCY workers per tick) of the dashboard query set against whichever engine is currently routed." },
      { "id": "route-to-tikv", "label": "Route dashboard to TiKV", "description": "Points the heavier dashboard load at TiKV, the same engine serving writes." },
      { "id": "route-to-tiflash", "label": "Route dashboard to TiFlash", "description": "Points the heavier dashboard load at the TiFlash replica, isolated from the write path." },
      { "id": "write-burst", "label": "Write burst", "description": "Multiplies the order write rate by WRITE_BURST_FACTOR for WRITE_BURST_DURATION_MS." }
    ]
  }
  ```

  Run the test again. Expected: PASS - 2 tests passed.

  Commit: `git add demos/power-bi/manifest.json demos/power-bi/test/manifest.test.ts && git commit -m "power-bi: add manifest"`

### Scaffolding (config, not TDD)

- [ ] **Task 12 - package scaffolding.**

  Add `demos/power-bi/package.json`:

  ```json
  {
    "name": "@lab/demo-power-bi",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
      "setup": "tsx runner/setup.ts",
      "start": "tsx runner/main.ts"
    },
    "dependencies": {
      "@lab/contract": "workspace:*",
      "@lab/runner-kit": "workspace:*",
      "mysql2": "^3.11.0"
    },
    "devDependencies": {
      "@types/node": "^22.10.0",
      "tsx": "^4.19.0",
      "typescript": "^5.9.0",
      "vitest": "^3.2.0"
    }
  }
  ```

  Add `demos/power-bi/tsconfig.json`:

  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {
      "outDir": "dist"
    },
    "include": ["runner", "test"]
  }
  ```

  Add `demos/power-bi/.env.example`:

  ```
  TIDB_HOST=127.0.0.1
  TIDB_PORT=4000
  TIDB_USER=root
  TIDB_PASSWORD=
  TIDB_DATABASE=lab
  TIDB_TLS=false
  LAB_ENV_TIDB=tiup playground (local)
  LAB_ENV_NOTES=

  WRITE_BASE_RATE_PER_SEC=5
  WRITE_BURST_FACTOR=8
  WRITE_BURST_DURATION_MS=10000
  DASHBOARD_LOAD_CONCURRENCY=8
  WRITE_P99_DEGRADATION_THRESHOLD_PCT=25
  TIFLASH_REPLICA_COUNT=1
  ```

  Run: `pnpm install`
  Expected: workspace resolves `@lab/demo-power-bi`, `pnpm -w list --depth -1` shows it in the tree.

  Commit: `git add demos/power-bi/package.json demos/power-bi/tsconfig.json demos/power-bi/.env.example && git commit -m "power-bi: scaffold package"`

### Thin I/O adapters (manual live-run steps)

- [ ] **Task 13 - provision TiDB for local development.**

  Run: `infra/tidb/playground.sh` (from the `integrations/` root, in its own terminal; leave it running).
  Expected output: tiup prints the allocated version and `Connect TiDB: mysql --host 127.0.0.1 --port 4000 -u root`.

  Copy `.env.example` to `.env` in `demos/power-bi/` (the defaults already point at this local playground).
  Run: `cp demos/power-bi/.env.example demos/power-bi/.env`
  Expected: no output; `.env` now exists (it is gitignored).

- [ ] **Task 14 - create the schema and seed baseline rows.**

  Add `demos/power-bi/runner/setup.ts`:

  ```ts
  import { createTidbPool, tidbConfigFromEnv } from '@lab/runner-kit';
  import { createOrder } from './src/orderGenerator';
  import { ORDERS_TABLE_DDL } from './src/schema';

  const SEED_ROW_COUNT = 2_000;

  const seed = async (): Promise<void> => {
    const pool = createTidbPool(tidbConfigFromEnv(process.env));
    await pool.query(ORDERS_TABLE_DDL);
    for (let sequence = 1; sequence <= SEED_ROW_COUNT; sequence += 1) {
      const order = createOrder({ sequence, randomSource: Math.random });
      await pool.execute(
        'INSERT INTO orders (order_id, region, product_category, amount, is_heartbeat) VALUES (?, ?, ?, ?, ?)',
        [order.orderId, order.region, order.productCategory, order.amount, 0],
      );
    }
    await pool.end();
    console.log(`seeded ${SEED_ROW_COUNT} orders`);
  };

  seed().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
  ```

  Run: `pnpm --filter @lab/demo-power-bi run setup`
  Expected output: `seeded 2000 orders`, process exits 0.

  Verify: `mysql --host 127.0.0.1 --port 4000 -u root lab -e "SELECT COUNT(*) FROM orders"`
  Expected output: `2000`.

- [ ] **Task 15 - implement and first-run the runner.**

  Add `demos/power-bi/runner/main.ts`:

  ```ts
  import type { RowDataPacket } from 'mysql2/promise';
  import {
    createEmitter,
    createSampleWindow,
    createTidbPool,
    every,
    onControl,
    summarize,
    tidbConfigFromEnv,
    timed,
  } from '@lab/runner-kit';
  import { DASHBOARD_QUERIES } from './src/dashboardQueries';
  import { degradationPct, freshnessMs } from './src/metrics';
  import { createHeartbeatOrder, createOrder } from './src/orderGenerator';
  import { setIsolationEnginesStatement, type RoutingEngine } from './src/routing';
  import { phaseForElapsed, type PhaseId } from './src/timeline';
  import { ordersPerTick } from './src/writeLoadPlan';

  const TICK_MS = 1_000;
  const HEARTBEAT_INTERVAL_MS = 20_000;
  const BASE_WRITE_RATE_PER_SEC = Number(process.env.WRITE_BASE_RATE_PER_SEC ?? '5');
  const BURST_FACTOR = Number(process.env.WRITE_BURST_FACTOR ?? '8');
  const BURST_DURATION_MS = Number(process.env.WRITE_BURST_DURATION_MS ?? '10000');
  const DASHBOARD_LOAD_CONCURRENCY = Number(process.env.DASHBOARD_LOAD_CONCURRENCY ?? '8');
  const DEGRADATION_THRESHOLD_PCT = Number(process.env.WRITE_P99_DEGRADATION_THRESHOLD_PCT ?? '25');
  const TIFLASH_REPLICA_COUNT = Number(process.env.TIFLASH_REPLICA_COUNT ?? '1');

  const pool = createTidbPool(tidbConfigFromEnv(process.env));
  const emitter = createEmitter();
  const controller = new AbortController();

  type RunState = {
    orderSequence: number;
    heartbeatSequence: number;
    dashboardLoadActive: boolean;
    activeEngine: RoutingEngine;
    burstUntilMs: number;
    baselineWriteP99: number | undefined;
    pendingHeartbeat: { readonly orderId: string; readonly committedAtMs: number } | undefined;
  };

  const state: RunState = {
    orderSequence: 0,
    heartbeatSequence: 0,
    dashboardLoadActive: false,
    activeEngine: 'tiflash',
    burstUntilMs: 0,
    baselineWriteP99: undefined,
    pendingHeartbeat: undefined,
  };

  let lastPhase: PhaseId = 'intro';
  let lastHeartbeatAtMs = 0;
  let ordersWrittenTotal = 0;
  let tiflashReplicaChecked = false;
  let snapshotChecked = false;

  const writeSamples = createSampleWindow();
  const tikvSamples = createSampleWindow();
  const tiflashSamples = createSampleWindow();

  const insertOrder = async (order: ReturnType<typeof createOrder>): Promise<void> => {
    await pool.execute(
      'INSERT INTO orders (order_id, region, product_category, amount, is_heartbeat) VALUES (?, ?, ?, ?, ?)',
      [order.orderId, order.region, order.productCategory, order.amount, order.isHeartbeat ? 1 : 0],
    );
  };

  const runDashboardQuerySet = async (engine: RoutingEngine): Promise<readonly number[]> => {
    const connection = await pool.getConnection();
    try {
      await connection.execute(setIsolationEnginesStatement(engine));
      const timings: number[] = [];
      for (const query of DASHBOARD_QUERIES) {
        const { ms } = await timed(() => connection.execute(query.sql));
        timings.push(ms);
      }
      return timings;
    } finally {
      connection.release();
    }
  };

  type ExistsRow = RowDataPacket & { readonly found: number };

  const probeHeartbeatVisible = async (orderId: string): Promise<boolean> => {
    const connection = await pool.getConnection();
    try {
      await connection.execute(setIsolationEnginesStatement('tiflash'));
      const [rows] = await connection.execute<ExistsRow[]>(
        'SELECT 1 AS found FROM orders WHERE order_id = ? AND is_heartbeat = 1',
        [orderId],
      );
      return rows.length > 0;
    } finally {
      connection.release();
    }
  };

  type ReplicaRow = RowDataPacket & { readonly AVAILABLE: number; readonly PROGRESS: number };

  const readTiflashReplicaStatus = async (): Promise<{ readonly available: boolean; readonly progress: number }> => {
    const [rows] = await pool.execute<ReplicaRow[]>(
      "SELECT AVAILABLE, PROGRESS FROM information_schema.tiflash_replica WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'",
    );
    const row = rows[0];
    if (row === undefined) return { available: false, progress: 0 };
    return { available: row.AVAILABLE === 1, progress: row.PROGRESS };
  };

  type TotalRow = RowDataPacket & { readonly total: string };

  const readTotalAsOf = async (engine: RoutingEngine, snapshot: Date): Promise<number> => {
    const connection = await pool.getConnection();
    try {
      await connection.execute(setIsolationEnginesStatement(engine));
      const [rows] = await connection.execute<TotalRow[]>(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM orders AS OF TIMESTAMP ? WHERE is_heartbeat = 0',
        [snapshot],
      );
      return Number(rows[0].total);
    } finally {
      connection.release();
    }
  };

  const runSnapshotCheck = async (): Promise<void> => {
    emitter.check('snapshot-totals-match', 'pending');
    const snapshot = new Date(Date.now() - 5_000);
    const [tikvTotal, tiflashTotal] = await Promise.all([
      readTotalAsOf('tikv', snapshot),
      readTotalAsOf('tiflash', snapshot),
    ]);
    const matches = tikvTotal === tiflashTotal;
    emitter.check(
      'snapshot-totals-match',
      matches ? 'pass' : 'fail',
      `tikv=${tikvTotal.toFixed(2)} tiflash=${tiflashTotal.toFixed(2)}`,
    );
  };

  const onPhaseEnter = (phase: PhaseId): void => {
    if (phase === 'intro') {
      emitter.node('order-workload', 'healthy');
      emitter.node('tidb', 'healthy');
      emitter.node('tiflash', 'idle');
      emitter.node('power-bi', 'idle');
      return;
    }
    if (phase === 'tiflash-replica') {
      emitter.node('tiflash', 'starting');
      pool.query(`ALTER TABLE orders SET TIFLASH REPLICA ${TIFLASH_REPLICA_COUNT}`).catch((error: unknown) => {
        emitter.log('error', `failed to set tiflash replica: ${String(error)}`, 'tiflash');
      });
      return;
    }
    if (phase === 'dashboard-on-tikv') {
      state.dashboardLoadActive = true;
      state.activeEngine = 'tikv';
      emitter.node('tidb', 'busy');
      return;
    }
    if (phase === 'dashboard-on-tiflash') {
      state.activeEngine = 'tiflash';
      emitter.node('tidb', 'healthy');
      emitter.node('tiflash', 'busy');
      return;
    }
    if (phase === 'power-bi-live') {
      emitter.node('power-bi', 'busy');
      return;
    }
    if (phase === 'wrap-up') {
      emitter.node('power-bi', 'done');
    }
  };

  const tick = async (): Promise<void> => {
    const elapsedMs = emitter.elapsedMs();
    const phase = phaseForElapsed(elapsedMs);
    if (phase !== lastPhase) {
      emitter.phase(phase);
      onPhaseEnter(phase);
      lastPhase = phase;
    }

    const burstActive = Date.now() < state.burstUntilMs;
    const ordersThisTick = ordersPerTick({
      baseRatePerSec: BASE_WRITE_RATE_PER_SEC,
      burstActive,
      burstFactor: BURST_FACTOR,
    });

    for (let i = 0; i < ordersThisTick; i += 1) {
      state.orderSequence += 1;
      const order = createOrder({ sequence: state.orderSequence, randomSource: Math.random });
      const { ms } = await timed(() => insertOrder(order));
      writeSamples.add(ms);
      ordersWrittenTotal += 1;
    }
    emitter.flow('writes', ordersThisTick);

    if (elapsedMs - lastHeartbeatAtMs > HEARTBEAT_INTERVAL_MS && state.pendingHeartbeat === undefined) {
      state.heartbeatSequence += 1;
      const heartbeat = createHeartbeatOrder({ sequence: state.heartbeatSequence });
      await insertOrder(heartbeat);
      state.pendingHeartbeat = { orderId: heartbeat.orderId, committedAtMs: emitter.elapsedMs() };
      lastHeartbeatAtMs = elapsedMs;
      emitter.log('info', `heartbeat ${heartbeat.orderId} committed`, 'tidb');
    }

    if (state.pendingHeartbeat !== undefined) {
      const visible = await probeHeartbeatVisible(state.pendingHeartbeat.orderId);
      if (visible) {
        const value = freshnessMs({
          committedAtMs: state.pendingHeartbeat.committedAtMs,
          visibleAtMs: emitter.elapsedMs(),
        });
        emitter.metric('freshness-ms', value);
        emitter.log('info', `heartbeat ${state.pendingHeartbeat.orderId} visible in TiFlash after ${value}ms`, 'tiflash');
        state.pendingHeartbeat = undefined;
      }
    }

    const [tikvTimings, tiflashTimings] = await Promise.all([
      runDashboardQuerySet('tikv'),
      runDashboardQuerySet('tiflash'),
    ]);
    tikvTimings.forEach((ms) => tikvSamples.add(ms));
    tiflashTimings.forEach((ms) => tiflashSamples.add(ms));
    emitter.flow('tikv-dashboard', tikvTimings.length);
    emitter.flow('tiflash-dashboard', tiflashTimings.length);

    if (state.dashboardLoadActive) {
      const load = Array.from({ length: DASHBOARD_LOAD_CONCURRENCY }, () => runDashboardQuerySet(state.activeEngine));
      await Promise.all(load);
      const edge = state.activeEngine === 'tikv' ? 'tikv-dashboard' : 'tiflash-dashboard';
      emitter.flow(edge, DASHBOARD_LOAD_CONCURRENCY * DASHBOARD_QUERIES.length);
    }

    const writeSummary = summarize(writeSamples.drain());
    if (writeSummary !== undefined) {
      emitter.metric('write-p99', writeSummary.p99);
      if (state.baselineWriteP99 === undefined && phase === 'seed-baseline') {
        state.baselineWriteP99 = writeSummary.p99;
      }
      if (state.baselineWriteP99 !== undefined && state.dashboardLoadActive) {
        const pct = degradationPct({ baselineP99Ms: state.baselineWriteP99, currentP99Ms: writeSummary.p99 });
        emitter.metric('write-p99-degradation', pct);
        if (phase === 'dashboard-on-tiflash') {
          emitter.check(
            'write-p99-within-threshold',
            pct <= DEGRADATION_THRESHOLD_PCT ? 'pass' : 'fail',
            `degradation=${pct.toFixed(1)}% threshold=${DEGRADATION_THRESHOLD_PCT}%`,
          );
        }
      }
    }

    const tikvSummary = summarize(tikvSamples.drain());
    if (tikvSummary !== undefined) {
      emitter.metric('dashboard-p50-tikv', tikvSummary.p50);
      emitter.metric('dashboard-p99-tikv', tikvSummary.p99);
    }
    const tiflashSummary = summarize(tiflashSamples.drain());
    if (tiflashSummary !== undefined) {
      emitter.metric('dashboard-p50-tiflash', tiflashSummary.p50);
      emitter.metric('dashboard-p99-tiflash', tiflashSummary.p99);
    }

    emitter.metric('orders-written-total', ordersWrittenTotal);

    const replicaStatus = await readTiflashReplicaStatus();
    emitter.metric('tiflash-replica-progress', replicaStatus.progress * 100);
    if (phase === 'tiflash-replica' && !tiflashReplicaChecked) {
      emitter.check('tiflash-replica-available', 'pending');
      if (replicaStatus.available) {
        emitter.node('tiflash', 'healthy');
        emitter.check(
          'tiflash-replica-available',
          'pass',
          `progress=${replicaStatus.progress.toFixed(2)} available=${replicaStatus.available}`,
        );
        tiflashReplicaChecked = true;
      }
    }

    if (phase === 'dashboard-on-tiflash' && !snapshotChecked) {
      await runSnapshotCheck();
      snapshotChecked = true;
    }
  };

  onControl((id) => {
    if (id === 'start-dashboard-load') {
      state.dashboardLoadActive = true;
      return;
    }
    if (id === 'route-to-tikv') {
      state.activeEngine = 'tikv';
      return;
    }
    if (id === 'route-to-tiflash') {
      state.activeEngine = 'tiflash';
      return;
    }
    if (id === 'write-burst') {
      state.burstUntilMs = Date.now() + BURST_DURATION_MS;
    }
  });

  const shutdown = (): void => {
    controller.abort();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  emitter.phase('intro');
  onPhaseEnter('intro');
  lastPhase = 'intro';

  await every({ intervalMs: TICK_MS, task: tick, signal: controller.signal });
  await pool.end();
  ```

  Run (from `integrations/` root, with the playground from task 13 already running and `.env` from task 13 in place): `pnpm lab run power-bi`
  Expected output: relay logs `demo power-bi listening on :7070` (or the configured port).

  In a second terminal, run: `curl -s http://localhost:7070/health`
  Expected output: `{"ok":true,"demo":"power-bi"}`

  Run: `curl -s http://localhost:7070/manifest | head -c 200`
  Expected output: the start of the manifest JSON, including `"id":"power-bi"`.

  Run: `curl -sN http://localhost:7070/events | head -n 20`
  Expected output: a stream of JSON lines beginning with `{"type":"phase","t":0,"phase":"intro"}` followed by `node`, `flow`, and `metric` events.

- [ ] **Task 16 - exercise the controls.**

  With the run from task 15 still active, run: `curl -s -X POST http://localhost:7070/control/write-burst`
  Expected output: `{"ok":true}` (or the relay's documented control-acknowledgement shape); the `/events` stream shows `orders-written-total` climbing faster for the next ~10 seconds, then returning to the base rate.

  Run: `curl -s -X POST http://localhost:7070/control/route-to-tikv`
  Expected: subsequent `write-p99-degradation` metric events, once the run reaches or has passed `dashboard-on-tikv`/`dashboard-on-tiflash`, rise noticeably compared to the pre-control baseline.

  Run: `curl -s -X POST http://localhost:7070/control/does-not-exist`
  Expected output: HTTP 404, per the relay protocol in Plan 00.

- [ ] **Task 17 - confirm the checks fire during a full run.**

  Let the run from task 15 continue uninterrupted for at least 225 seconds (the `wrap-up` phase start).
  Run: `curl -sN http://localhost:7070/events | grep '"type":"check"'`
  Expected output: three checks appear, each moving `pending` -> `pass` (or `fail`, if the threshold is genuinely exceeded, which is itself useful signal): `tiflash-replica-available`, `snapshot-totals-match`, `write-p99-within-threshold`.

- [ ] **Task 18 - UI smoke test.**

  Run: `pnpm --filter @lab/ui dev`
  Expected output: Vite dev server URL printed, e.g. `http://localhost:5173`.

  Open that URL, select the `power-bi` demo in live mode.
  Expected: the 4-node diagram renders per `manifest.json` (order-workload left, tidb/tiflash stacked in the middle, power-bi on the right), particles animate along `writes`/`replication`/`tikv-dashboard`/`tiflash-dashboard`, and the metric tiles for `write-p99`, `freshness-ms`, `tiflash-replica-progress`, and `orders-written-total` update roughly once per second.

### Windows environment for Power BI Desktop (manual)

- [ ] **Task 19 - provision the Windows VM.**

  Primary path (Azure, scriptable teardown):

  ```bash
  az group create --name lab-power-bi-rg --location eastus
  az vm create \
    --resource-group lab-power-bi-rg \
    --name lab-power-bi-vm \
    --image Win11-23H2-Pro \
    --size Standard_D4s_v5 \
    --admin-username labadmin \
    --admin-password '<set-a-strong-password>'
  az vm open-port --resource-group lab-power-bi-rg --name lab-power-bi-vm --port 3389
  ```

  Expected output: `az vm create` prints a JSON object including `"powerState": "VM running"` and a `publicIpAddress`.

  Connect: on macOS, use the Microsoft Remote Desktop app (Mac App Store) with that public IP, port 3389, and the admin credentials above.
  Expected: a Windows 11 desktop appears in the Remote Desktop window.

  Alternatives (both verified as real options in section 4, either works if preferred over a cloud VM): a Windows 365 Cloud PC reached from a browser or the Remote Desktop app, or a local Windows VM under Parallels Desktop/UTM using shared/bridged networking so it can reach whichever TiDB endpoint is in `.env`.

- [ ] **Task 20 - install Power BI Desktop and its connector prerequisite.**

  On the Windows VM: download Power BI Desktop from the official Microsoft download page, install it, then download and install the Oracle MySQL Connector/NET package (required per section 4's verified fact).
  Expected: Power BI Desktop launches to its start screen with no missing-driver warning.

  If Power BI still reports a missing driver when connecting in task 21 (community reports suggest it may load an ODBC driver instead - see the **UNVERIFIED** note in section 4), install MySQL Connector/ODBC 8.0.x (64-bit) as well and retry.

- [ ] **Task 21 - connect Power BI Desktop to the TiDB cluster and build the 3 visuals.**

  In Power BI Desktop: Get Data > More > Database > MySQL database. Enter the TiDB cluster's host and port (from the TiDB Cloud console's Connect dialog, or the local playground's `127.0.0.1:4000` if the VM can reach the Mac). Choose Import. Under Advanced options, set the "Native SQL statement" field to the exact text of one query from `runner/src/dashboardQueries.ts` (repeat per visual, once per query, as three separate queries/tables).
  Expected: three tables load (`revenue-by-category`, `orders-by-region`, `orders-last-hour` shaped data), each matching the row shapes those SQL statements return.

  Build one visual per table (bar chart for revenue by category, bar or map for orders by region, line chart for orders per minute), save the report as `power-bi-report.pbix`.
  Expected: three visuals render with the seeded baseline data.

- [ ] **Task 22 - verify Power BI sent the exact SQL.**

  On the TiDB cluster, immediately after clicking Refresh in Power BI Desktop, run:

  ```sql
  SELECT digest_text, exec_count
  FROM information_schema.statements_summary
  WHERE digest_text LIKE '%product_category, SUM(amount)%'
  ORDER BY last_seen DESC
  LIMIT 5;
  ```

  Expected output: one row whose `digest_text` matches the `revenue-by-category` query text from `dashboardQueries.ts`, with `exec_count` incremented by 1 since the last Refresh. Repeat for the other two queries. If `tidb_enable_stmt_summary` is off, run `SET GLOBAL tidb_enable_stmt_summary = 1` first and refresh again.

- [ ] **Task 23 - screen record the Power BI refresh.**

  On the Windows VM, use the built-in Xbox Game Bar recorder (Win+Alt+R) or any screen recorder, and record: opening the report, clicking Refresh, and the visuals updating to include orders written since the report was first loaded.
  Expected output: a video file (for example `power-bi-refresh.mp4`) a few tens of seconds long, showing the totals changing after Refresh.

  Copy it off the VM (e.g., via the Remote Desktop app's clipboard/file transfer, or upload to shared storage) to the Mac, into `demos/power-bi/traces/power-bi-refresh.mp4` (not committed - see section 8 on where the final asset lives).

- [ ] **Task 24 - tear down the Windows VM.**

  Run:

  ```bash
  az vm deallocate --resource-group lab-power-bi-rg --name lab-power-bi-vm
  az group delete --name lab-power-bi-rg --yes --no-wait
  ```

  Expected output: no error; `az group show --name lab-power-bi-rg` eventually returns a `ResourceGroupNotFound` error, confirming nothing is left billing.

- [ ] **Task 25 - tear down the TiDB Cloud cluster used for the recording.**

  Run:

  ```bash
  ticloud serverless delete --cluster-id <cluster-id>
  ticloud serverless list
  ```

  Expected output: the second command's table no longer lists `<cluster-id>`.

### Documentation (manual, no test)

- [ ] **Task 26 - write `README.md`.**

  Add `demos/power-bi/README.md` in full:

  ```markdown
  # Power BI + TiDB: live dashboards without nightly ETL

  ## What this proves

  One TiDB cluster serves a live order-writing workload and a Power BI report
  at the same time. A TiFlash replica added to the `orders` table lets the
  dashboard's query set run fast analytical queries without competing with
  order writes on TiKV. The demo measures, side by side:

  - Dashboard query p50/p99 forced to TiKV vs forced to TiFlash, on the same
    data.
  - How many milliseconds after a write commits it becomes visible to a
    TiFlash-routed dashboard query (freshness, not asserted, measured).
  - Order write p99 with the dashboard query set idle, routed to TiKV, and
    routed to TiFlash.
  - TiFlash replica sync progress, added live during the run.

  A real Power BI Desktop report, connected to the same cluster, is
  screen-recorded separately and accompanies the trace replay on the site.
  Power BI's native MySQL connector only supports Import mode (see the
  plan's section 4 for the source), so the report itself does not stream -
  the underlying data does, and a Refresh in Power BI shows that.

  ## Prerequisites

  - Node 22, pnpm, and (for local development) tiup.
  - A TiDB Cloud account for the featured recording, or the local
    `infra/tidb/playground.sh` for day-to-day development.
  - A Windows environment for Power BI Desktop only: an Azure VM, a Windows
    365 Cloud PC, or a local Parallels/UTM Windows VM. Power BI Desktop is
    Windows-only.

  See the plan (`docs/plans/11-power-bi.md`) sections 4 and 5 for the exact
  verified facts and cost/teardown commands.

  ## Run (local development)

  ```bash
  infra/tidb/playground.sh                          # separate terminal, leave running
  cp demos/power-bi/.env.example demos/power-bi/.env
  pnpm --filter @lab/demo-power-bi run setup
  pnpm lab run power-bi
  ```

  Open the UI (`pnpm --filter @lab/ui dev`) and select `power-bi` in live
  mode, or drive it headless with `curl` against `http://localhost:7070`.

  ## Record

  See the plan's section 8 for the full recording procedure, including
  pointing the same cluster at a real Power BI Desktop report and capturing
  its screen recording alongside the runner's `--record` trace.

  ## Teardown

  ```bash
  ticloud serverless delete --cluster-id <cluster-id>
  az vm deallocate --resource-group lab-power-bi-rg --name lab-power-bi-vm
  az group delete --name lab-power-bi-rg --yes --no-wait
  tiup clean lab   # if the local playground was used
  ```

  ## Cost notes

  The TiDB Cloud cluster and the Windows VM both bill by time; see the
  plan's section 5 for the pricing-page pointers (no prices are hardcoded
  here since they change). Tear both down the same day as any recording.
  ```

  Run: `pnpm lab check-public` (from the `integrations/` root, once the relay's `check-public` command exists per Plan 00).
  Expected: no denylisted terms or internal URLs found in this file.

  Commit: `git add demos/power-bi/README.md && git commit -m "power-bi: add README"`

- [ ] **Task 27 - write `TALK-TRACK.md`.**

  Add `demos/power-bi/TALK-TRACK.md` in full:

  ```markdown
  # Talk track: Power BI + TiDB

  ## Presenter script, per phase

  **Intro.** "A business team wants a live dashboard on operational orders,
  not a copy that is a day old. One TiDB cluster is about to serve both the
  checkout writes and the report."

  **Baseline writes.** "Orders are flowing into TiDB now, no dashboard load
  yet. This write p99 is the baseline we compare against once the
  dashboard starts querying."

  **Add the TiFlash replica.** "Adding a TiFlash replica to the orders
  table live: this is the columnar copy the dashboard will read from,
  syncing from the same rows being written right now." Point at the sync
  progress metric climbing to 100%.

  **Dashboard load on TiKV.** "Routing the dashboard's query set at TiKV,
  the same engine handling the writes. Watch the write p99 line: this is
  what a warehouse-free dashboard used to cost you." Let the write p99 line
  visibly rise before moving on.

  **Dashboard load on TiFlash.** "Same dashboard queries, same concurrency,
  now routed to TiFlash. Write p99 comes back down: the analytical load is
  isolated on its own replica." Point at the `write-p99-within-threshold`
  check turning green.

  **Freshness check.** "A heartbeat order just committed. Watch how many
  milliseconds until it is visible in a TiFlash-routed dashboard query -
  that is the real replication lag, not a marketing number." Read the
  actual number off the tile; do not round it up or down.

  **The real Power BI report.** "Cutting to a real Power BI Desktop report
  connected to this same cluster. Refreshing it pulls in the orders written
  during this run." Let the screen recording play; do not talk over the
  Refresh click.

  **Recap.** "No nightly ETL job, one cluster, a dashboard that is current
  to the second, and writes that never noticed the analytics running next
  to them."

  ## Discovery questions

  1. Which dashboards today run off a nightly copy of production data, and
     how many hours old is that copy by the time someone looks at it?
  2. When a report and the operational system disagree, how do you find
     out, and who gets paged?
  3. What does the ETL/ELT pipeline feeding those dashboards cost to run
     and maintain each month, in engineering time as well as
     infrastructure?
  4. If a business user could refresh a dashboard and trust the number was
     current to the second, what decision would they make differently?
  5. Do your analytical queries ever get blocked behind, or compete with,
     your transactional writes today?

  ## Objections and honest answers

  1. **"Power BI's DirectQuery isn't supported against MySQL-compatible
     sources, so this isn't really live."** Correct - Power BI's native
     MySQL connector only supports Import mode (verified against
     Microsoft's own connector documentation). What this demo proves is
     that the *database* layer is current to the second; a refreshed
     Power BI Import model reflects that on each refresh, manual or
     scheduled. We do not claim Power BI streams live.
  2. **"Our BI team won't give up their warehouse for this."** This demo
     does not ask them to. It targets the class of dashboard that
     currently waits on a nightly batch for no reason other than "that's
     how the pipeline works," not a wholesale warehouse replacement.
  3. **"TiFlash is another engine to operate - what does that cost us?"**
     On TiDB Cloud, TiFlash nodes are managed by the platform per the
     selected tier. Self-managed, it is an additional node type in the
     cluster topology - real, but there is no separate ETL pipeline or
     warehouse to build and maintain instead.
  4. **"How much replication lag does TiFlash really have under load?"**
     Whatever this run measured on the freshness tile - that is the
     number we show, with the exact measurement method documented in the
     manifest. We do not assert "near zero" as a marketing claim.
  5. **"Won't heavy Power BI dashboard traffic slow down my checkout
     writes?"** That is exactly what the write-p99-with-vs-without-load
     comparison measures, with a numeric threshold check, so the isolation
     claim is falsifiable rather than asserted.
  ```

  Run: `pnpm lab check-public`
  Expected: no denylisted terms or internal URLs found in this file.

  Commit: `git add demos/power-bi/TALK-TRACK.md && git commit -m "power-bi: add talk track"`

## 8. Recording the featured trace

1. Provision a fresh TiDB Cloud cluster on the Starter or Essential tier (re-confirm TiFlash support at the section 4 URL first) and update `demos/power-bi/.env`: `TIDB_HOST`, `TIDB_PORT=4000`, `TIDB_USER` (the cluster-specific prefixed user from the console's Connect dialog), `TIDB_PASSWORD`, `TIDB_TLS=true`, `LAB_ENV_TIDB=TiDB Cloud <tier> (<version printed in the console>)`, `LAB_ENV_NOTES=recorded for the featured trace on <date>`. Configure the IP access list to allow the Windows VM's public IP (or "allow access from anywhere" for the short recording window only, per section 4).
2. Run `pnpm --filter @lab/demo-power-bi run setup` once against this cluster.
3. Start the Windows VM (task 19), install Power BI Desktop (task 20), and open a report pointed at this same cluster (task 21), but do not click Refresh yet.
4. From the `integrations/` root, run `pnpm lab run power-bi --record`. Let it run through `intro` … `power-bi-live` (about 195 seconds) without touching the controls, so the phase-driven autopilot tells the whole story.
5. The moment the console/log shows the `power-bi-live` phase event, switch to the Windows VM, click Refresh in Power BI Desktop, and start the screen recording described in task 23. Let both run for the `power-bi-live` phase's duration, then let the runner continue into `wrap-up` and exit on its own (or Ctrl-C once `wrap-up` has been visible for a few seconds).
6. The relay writes `demos/power-bi/traces/<ISO timestamp>.json`. Confirm `durationMs` is between 180,000 and 360,000 (3-6 minutes) as required; if the run was too short or too long, adjust `PHASE_SCHEDULE` in `timeline.ts` and re-record rather than editing the trace by hand.
7. Copy the good trace to `demos/power-bi/traces/featured.json`.
8. Run `pnpm lab validate power-bi`. Expected: no errors, including no `eventReferenceErrors` for any event in the trace.
9. Run `pnpm lab check-public`. Expected: no denylisted terms or internal URLs found (this demo's manifest, README, and TALK-TRACK avoid customer/prospect names by construction; re-check after any edits).
10. Commit `demos/power-bi/traces/featured.json` (only this trace file - others under `traces/` stay gitignored) and the Power BI screen recording asset per wherever the website's hosting step expects companion videos (see Plan 00's `collect-site`; if it does not yet have a slot for a companion video, note that gap rather than inventing a location for it).
11. Run teardown (tasks 24 and 25) immediately after confirming the trace and recording are both saved.

## 9. Risks and gotchas

- **Query folding uncertainty in Power BI Import mode is real.** Power Query's MySQL connector may or may not push a drag-and-drop aggregation down as a `GROUP BY` in SQL; this plan sidesteps the ambiguity entirely by pinning each visual to the exact SQL text via the connector's "Native SQL statement" advanced option (verified in section 4), and by confirming receipt via `information_schema.statements_summary` (task 22) rather than assuming.
- **`AS OF TIMESTAMP ?` with a bound parameter may not be accepted by every driver/version.** If `mysql2` fails to bind a `Date` into that clause, fall back to formatting the snapshot as an ISO string and interpolating it directly into the SQL text server-side (safe here because the value is server-generated, not user input), e.g. `` `... AS OF TIMESTAMP '${snapshot.toISOString()}' ...` ``.
- **`SET SESSION tidb_isolation_read_engines` must run on the same connection as the query it isolates.** Using `pool.execute()` for the `SET` and a separate `pool.execute()` for the query can silently land on two different pooled connections. Always acquire one connection via `pool.getConnection()`, run both statements on it, then release it, as `main.ts` does.
- **TiFlash replication lag under the heavier concurrent load in `dashboard-on-tikv`/`dashboard-on-tiflash` could occasionally make the freshness probe take longer than one tick.** The probe loop already tolerates this (it just keeps checking on the next tick); if it regularly exceeds several ticks, that itself is useful, honestly-reported signal, not a bug to hide.
- **A Windows VM with a dynamic public IP breaks a scoped TiDB Cloud IP allowlist entry on VM restart.** Either reserve a static public IP on the VM (`az vm create --public-ip-sku Standard` plus a reserved IP resource) or use "allow access from anywhere" for the narrow recording window only, then delete the cluster immediately after (section 5).
- **Local tiup playground's single TiFlash node differs from a TiDB Cloud tier's managed TiFlash topology.** Day-to-day development against the local playground (task 13-18) is fine for iterating on the runner; only the featured recording (section 8) needs to run against the actual TiDB Cloud cluster the Power BI report is pointed at, since the acts require both to be watching the same data.
- **`tidb_enable_stmt_summary` may be off by default in some environments.** Task 22's verification step includes the `SET GLOBAL` fallback; if the account lacks privilege to set it globally, use `SHOW VARIABLES LIKE 'tidb_enable_stmt_summary'` first to check before assuming it needs changing.
- **Do not let the Windows VM or TiDB Cloud cluster outlive the recording session.** Both bill by time; tasks 24 and 25 give the exact teardown commands, and section 5 restates them - run them the same day as the recording.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 11-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/11-power-bi.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - | An on-premises data gateway is only required for Power BI Service when the MySQL-compatible server "isn't cloud accessible"; Power BI Desktop itself never needs a gateway | https://learn.microsoft.com/en-us/power-query/connectors/mysql-database | Verified for Desktop (used in this demo). **UNVERIF
  - | docs.pingcap.com has no dedicated Power BI connection guide; the closest official material is the general JDBC/ODBC "Connect to TiDB" developer guide | https://docs.pingcap.com/tidb/stable/dev-guide-connect-to-tidb/ | Verified absence as of this writing. **UNVERIFIED**: search docs.pingcap.com for
  - | TiDB Cloud Starter, Essential, and Premium tiers all support TiFlash/HTAP | https://docs.pingcap.com/tidbcloud/select-cluster-tier/ | Verified. **UNVERIFIED**: exact current tier names and any per-tier TiFlash replica-count ceilings change over time - re-confirm at that URL immediately before crea
  - | Windows 365 Cloud PC gives a full Windows desktop reachable from a Mac browser or the Remote Desktop app, billed per seat per month regardless of hours used | General Windows 365 product documentation | **UNVERIFIED** - confirm current plans and whether an hourly/short-term option exists at the Wi
  - | Power BI Desktop is a free download and does not require a paid Power BI license to connect to a live data source and build a report locally | Not confirmed against an official source in this pass | **UNVERIFIED** - confirm on the Power BI Desktop download/licensing page before relying on it; if a
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/11-power-bi.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 11-P1: `routing.ts`: engine to isolation-engine list.
- Tasks: 1
- Depends on: 11-V1   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/routing.ts`, `integrations/demos/power-bi/runner/test/routing.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 1's steps are all checked off and the gate output matches.

### Packet 11-P2: `routing.ts`: exact SQL to force an engine.
- Tasks: 2
- Depends on: 11-P1   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/routing.ts`, `integrations/demos/power-bi/runner/test/routing.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 2's steps are all checked off and the gate output matches.

### Packet 11-P3: `metrics.ts`: freshness math.
- Tasks: 3
- Depends on: 11-P2   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/metrics.ts`, `integrations/demos/power-bi/runner/test/metrics.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 3's steps are all checked off and the gate output matches.

### Packet 11-P4: `metrics.ts`: write p99 degradation math.
- Tasks: 4
- Depends on: 11-P3   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/metrics.ts`, `integrations/demos/power-bi/runner/test/metrics.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 4's steps are all checked off and the gate output matches.

### Packet 11-P5: `orderGenerator.ts`: deterministic order builder.
- Tasks: 5
- Depends on: 11-P4   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/orderGenerator.ts`, `integrations/demos/power-bi/runner/test/orderGenerator.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 5's steps are all checked off and the gate output matches.

### Packet 11-P6: `orderGenerator.ts`: heartbeat order builder.
- Tasks: 6
- Depends on: 11-P5   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/orderGenerator.ts`, `integrations/demos/power-bi/runner/test/orderGenerator.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 6's steps are all checked off and the gate output matches.

### Packet 11-P7: `writeLoadPlan.ts`: orders per tick under baseline/burst.
- Tasks: 7
- Depends on: 11-P6   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/writeLoadPlan.ts`, `integrations/demos/power-bi/runner/test/writeLoadPlan.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 7's steps are all checked off and the gate output matches.

### Packet 11-P8: `timeline.ts`: elapsed time to phase id.
- Tasks: 8
- Depends on: 11-P7   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/timeline.ts`, `integrations/demos/power-bi/runner/test/timeline.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 8's steps are all checked off and the gate output matches.

### Packet 11-P9: `dashboardQueries.ts`: the exact dashboard query set.
- Tasks: 9
- Depends on: 11-P8   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/dashboardQueries.ts`, `integrations/demos/power-bi/runner/test/dashboardQueries.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 11-P10: `schema.ts`: the orders table DDL.
- Tasks: 10
- Depends on: 11-P9   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/src/schema.ts`, `integrations/demos/power-bi/runner/test/schema.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 11-P11: manifest.
- Tasks: 11
- Depends on: 11-P10   Shared runtime: none
- Files owned: `integrations/demos/power-bi/manifest.json`, `integrations/demos/power-bi/test/manifest.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 11-P12: package scaffolding.
- Tasks: 12
- Depends on: 11-P11   Shared runtime: tidb-playground
- Files owned: `integrations/demos/power-bi/.env.example`, `integrations/demos/power-bi/package.json`, `integrations/demos/power-bi/tsconfig.json`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm install` -> workspace resolves `@lab/demo-power-bi`, `pnpm -w list --depth -1` shows it in the tree
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/power-bi/.env.example` -> 8
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 11-P13: provision TiDB for local development.
- Tasks: 13
- Depends on: 11-P12   Shared runtime: none
- Files owned: `integrations/demos/power-bi/.env.example`
- Model: sonnet   Effort: S
- Gate:
  - `infra/tidb/playground.sh` -> output: tiup prints the allocated version and `Connect TiDB: mysql --host 127.0.0.1 --port 4000 -u root`
  - `cp demos/power-bi/.env.example demos/power-bi/.env` -> no output; `.env` now exists (it is gitignored)
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/power-bi/.env.example` -> 8
- Done when: Task 13's steps are all checked off and the gate output matches.

### Packet 11-P14: create the schema and seed baseline rows.
- Tasks: 14
- Depends on: 11-P13   Shared runtime: none
- Files owned: `integrations/demos/power-bi/runner/setup.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-power-bi run setup` -> output: `seeded 2000 orders`, process exits 0
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 14's steps are all checked off and the gate output matches.

### Packet 11-P15: implement and first-run the runner.
- Tasks: 15
- Depends on: 11-P14   Shared runtime: tidb-playground
- Files owned: `integrations/demos/power-bi/runner/main.ts`
- Model: sonnet   Effort: L
- Gate:
  - `curl -s http://localhost:7070/manifest | head -c 200` -> output: the start of the manifest JSON, including `"id":"power-bi"`
  - `curl -sN http://localhost:7070/events | head -n 20` -> output: a stream of JSON lines beginning with `{"type":"phase","t":0,"phase":"intro"}` followed by `node`, `flow`, and `metric` events
  - `pnpm --filter @lab/demo-power-bi typecheck` -> exit 0
- Done when: Task 15's steps are all checked off and the gate output matches.

### Packet 11-P16: exercise the controls.
- Tasks: 16
- Depends on: 11-P15   Shared runtime: tidb-playground
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - `curl -s -X POST http://localhost:7070/control/route-to-tikv` -> subsequent `write-p99-degradation` metric events, once the run reaches or has passed `dashboard-on-tikv`/`dashboard-on-tiflash`, rise noticeably compared to the pre-control baseline
  - `curl -s -X POST http://localhost:7070/control/does-not-exist` -> output: HTTP 404, per the relay protocol in Plan 00
- Done when: Task 16's steps are all checked off and the gate output matches.

### Packet 11-P17: confirm the checks fire during a full run.
- Tasks: 17
- Depends on: 11-P16   Shared runtime: tidb-playground
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - `curl -sN http://localhost:7070/events | grep '"type":"check"'` -> output: three checks appear, each moving `pending` -> `pass` (or `fail`, if the threshold is genuinely exceeded, which is itself useful signal): `tiflash-replica-available`, `snapshot-totals-match`, `write-p99-within-threshold`
- Done when: Task 17's steps are all checked off and the gate output matches.

### Packet 11-P18: UI smoke test.
- Tasks: 18
- Depends on: 11-P17   Shared runtime: cloud-account
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - `pnpm --filter @lab/ui dev` -> output: Vite dev server URL printed, e.g. `http://localhost:5173`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 18's steps are all checked off and the gate output matches.

### Packet 11-P19: provision the Windows VM.
- Tasks: 19
- Depends on: 11-P18   Shared runtime: cloud-account
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 19 produces the output the task quotes; the coordinator pastes that output into the packet report
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 19's steps are all checked off and the gate output matches.

### Packet 11-P20: install Power BI Desktop and its connector prerequisite.
- Tasks: 20
- Depends on: 11-P19   Shared runtime: cloud-account
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 20 produces the output the task quotes; the coordinator pastes that output into the packet report
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 20's steps are all checked off and the gate output matches.

### Packet 11-P21: connect Power BI Desktop to the TiDB cluster and build the 3 visuals.
- Tasks: 21
- Depends on: 11-P20   Shared runtime: none
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 21 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 21's steps are all checked off and the gate output matches.

### Packet 11-P22: verify Power BI sent the exact SQL.
- Tasks: 22
- Depends on: 11-P21   Shared runtime: none
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 22 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 22's steps are all checked off and the gate output matches.

### Packet 11-P23: screen record the Power BI refresh.
- Tasks: 23
- Depends on: 11-P22   Shared runtime: cloud-account
- Files owned: `integrations/demos/power-bi/traces/power-bi-refresh.mp4`
- Model: sonnet   Effort: S
- Gate:
  - every command in Task 23 produces the output the task quotes; the coordinator pastes that output into the packet report
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 23's steps are all checked off and the gate output matches.

### Packet 11-P24: tear down the Windows VM.
- Tasks: 24
- Depends on: 11-P23   Shared runtime: cloud-account
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 24 produces the output the task quotes; the coordinator pastes that output into the packet report
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 24's steps are all checked off and the gate output matches.

### Packet 11-P25: tear down the TiDB Cloud cluster used for the recording.
- Tasks: 25
- Depends on: 11-P24   Shared runtime: none
- Files owned: none (manual or docs step)
- Model: coordinator   Effort: S
- Gate:
  - every command in Task 25 produces the output the task quotes; the coordinator pastes that output into the packet report
- Done when: Task 25's steps are all checked off and the gate output matches.

### Packet 11-P26: write `README.md`.
- Tasks: 26
- Depends on: 11-P25   Shared runtime: cloud-account
- Files owned: `integrations/demos/power-bi/.env.example`, `integrations/demos/power-bi/README.md`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm lab check-public` -> no denylisted terms or internal URLs found in this file
  - `grep -c $'\u2014' integrations/demos/power-bi/README.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/power-bi/.env.example` -> 8
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 26's steps are all checked off and the gate output matches.

### Packet 11-P27: write `TALK-TRACK.md`.
- Tasks: 27
- Depends on: 11-P26   Shared runtime: none
- Files owned: `integrations/demos/power-bi/TALK-TRACK.md`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm lab check-public` -> no denylisted terms or internal URLs found in this file
  - `grep -c $'\u2014' integrations/demos/power-bi/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
- Done when: Task 27's steps are all checked off and the gate output matches.

### Packet 11-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 11-P27   Shared runtime: cloud-account
- Files owned: `integrations/demos/power-bi/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate power-bi` -> `power-bi: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.
