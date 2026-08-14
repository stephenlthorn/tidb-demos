# Week 6 - DDL, DML, Metadata Locks, and What CDC Does With Them (tutor lesson)

Objective: the trainee can explain why a schema change on TiDB does not take the customer's
application down, can distinguish a metadata lock from a table lock without bluffing, and knows
which schema changes will break a downstream changefeed.

This lesson exists because "we got burned by an `ALTER TABLE` that locked production for four
hours" is one of the most common pains a MySQL shop brings to the first call. It is a buying
trigger, and most SEs fumble it.

Teach one task per sitting. Run every check yourself with `verify.py`.

---

## Start here: the two words, in plain language

The trainee may not have these cold. Define them before anything else and do not assume.

- **DML - Data Manipulation Language.** Statements that change *rows*: `INSERT`, `UPDATE`,
  `DELETE`, and reads with `SELECT`. This is what the application does all day.
- **DDL - Data Definition Language.** Statements that change the *shape* of the data:
  `CREATE TABLE`, `ALTER TABLE`, `ADD INDEX`, `DROP COLUMN`. This is what happens on deploy day.

**Why the distinction is commercial, not academic:** DML is continuous and DDL is occasional, but
DDL is the one that causes outages. In a classic MySQL deployment, an `ALTER TABLE` on a large
table can hold a lock that stalls the application for as long as the alter runs. Whole industries
of tooling exist to work around this (`pt-online-schema-change`, `gh-ost`). When a customer says
"we schedule schema changes for 2am on Sundays," they are telling you their database makes DDL
dangerous, and they have organized their calendar around that fact.

The one-sentence pitch: **TiDB does schema changes online, so DDL stops being an outage window
and becomes a deploy step.**

---

## Task 1 - Watch an online schema change happen

**Framing:** TiDB's DDL is asynchronous. Rather than locking the table and rewriting it, TiDB
moves the schema object through a sequence of intermediate states, and every node in the cluster
converges on each state before the next one starts. During that whole process, reads and writes
keep working.

The states a schema object passes through: `none` → `delete only` → `write only` →
`write reorganization` / `delete reorganization` → `public`. `write reorganization` on an index
job means the index data is actively being backfilled.

**Assign:** "Create a table with a few thousand rows on your cluster, add an index to it, and
then show me the DDL job history. Tell me which state the job passed through that proves the
index was backfilled rather than locked."

Let them write it. Hint ladder:
1. "There is an `ADMIN` statement for inspecting DDL jobs."
2. "`ADMIN SHOW DDL JOBS`. Look at the `SCHEMA_STATE` and `STATE` columns."
3. Worked fragment: `ADMIN SHOW DDL JOBS 5`

**Check (run these):**
```
python verify.py "ADMIN SHOW DDL JOBS 5"
```
The result has 13 columns: `JOB_ID, DB_NAME, TABLE_NAME, JOB_TYPE, SCHEMA_STATE, SCHEMA_ID,
TABLE_ID, ROW_COUNT, CREATE_TIME, START_TIME, END_TIME, STATE, COMMENTS`.

Pass when the trainee can point at a completed job and read it back: the `JOB_TYPE`, the
`ROW_COUNT` backfilled, and a terminal `STATE` of `synced` (finished and propagated to all
instances) as opposed to `done` (executed on the owner node only). Make them say the difference
between `done` and `synced` out loud - it is a small thing that sounds expert.

**If `ADMIN SHOW DDL JOBS` is restricted on the trainee's tier**, do not fake it. Report the
actual error and use it to reinforce `lessons/week-02-planes-and-tiers.md`: operator-level
introspection is part of what a shared data plane withholds. Then teach the state machine from
this lesson text instead.

**Socratic:** "The job passed through `write only` before `write reorganization`. Why does a
correct online schema change need an intermediate state where writes are applied but the object
is not yet readable?" (Every node must agree the new schema element is being maintained before
anyone is allowed to depend on it; skipping the intermediate state would let one node read
something another node is not yet writing.)

**SE drill:** "Prospect: 'we do our schema migrations at 2am with gh-ost.' Two sentences."
Grade for: names online DDL, does not claim zero cost (backfill still consumes resources and
takes time on a huge table), and asks what their largest table is rather than promising a number.

---

## Task 2 - Metadata lock: what it actually is

This is the part trainees get wrong. Slow down.

**The problem it solves:** if a transaction starts, and then a DDL changes the table's schema
mid-flight, that transaction is now holding a stale picture of the table. Historically TiDB would
resolve this by killing the transaction with an `Information schema is changed` error. Annoying,
and it surfaces in the customer's application as random failures during deploys.

**What metadata lock does:** it coordinates the priority of DML and DDL during a metadata change
by **making the DDL wait for transactions holding old metadata to commit.** The invariant it
maintains: the metadata versions in use by all transactions across the cluster differ by at most
one version.

**Say this precisely, because the direction matters:** metadata lock does **not** block DML. It
makes the DDL wait. The application keeps running; the deploy waits a moment for in-flight
transactions to finish. That is exactly the priority order a customer wants, and it is the
opposite of the MySQL experience they are complaining about.

Controlled by `tidb_enable_metadata_lock`. Introduced in v6.3.0 and enabled by default from
v6.5.0, so on any current cluster the trainee should expect it on.

**Assign:** "Confirm metadata lock is enabled on your cluster, and tell me what would go wrong
if you turned it off."

**Check:**
```
python verify.py "SHOW VARIABLES LIKE 'tidb_enable_metadata_lock'"
```
Pass when they read the value correctly and can state the failure mode without it: transactions
that span a DDL get killed with `Information schema is changed` rather than the DDL waiting.

**Socratic:** "A long-running transaction is open. You submit an `ALTER TABLE`. Who waits, and
what is the risk to the person who submitted the DDL?" (The DDL waits. The risk is that a very
long or abandoned transaction stalls the schema change - so a customer with 20-minute analytical
transactions needs to know their deploys can block behind them. This is a genuine operational
caveat, not a flaw to hide.)

**SE drill:** "Prospect's DBA asks 'so DDL never blocks anything?' Two sentences." Grade for:
correcting the premise honestly - DDL waits on old transactions, and a pathological long
transaction can delay a schema change - while keeping the headline that the application is not
blocked.

---

## Task 3 - Table locks, and why the answer is usually "don't"

**The distinction to drill, in one line each:**

- A **metadata lock** is internal, automatic, and about *correctness during schema change*.
  Nobody asks for it; TiDB applies it. It protects the customer.
- A **table lock** is explicit, user-issued (`LOCK TABLES` / `UNLOCK TABLES`), and about
  *coarse exclusive access to a whole table*. A developer asks for it, and it is almost always
  the wrong tool in a distributed database.

**The facts on TiDB's table locks, which the trainee must not overstate:**
- Enabled by the `enable-table-lock` **config file** parameter, not a SQL variable.
- **Disabled by default**, and **experimental**: the documentation explicitly says it is not
  recommended for production.
- Cannot lock tables in `INFORMATION_SCHEMA`, `PERFORMANCE_SCHEMA`, `METRICS_SCHEMA`, or `mysql`.
- Lock types: `READ`, `READ LOCAL`, `WRITE`, `WRITE LOCAL` - but `READ LOCAL` exists only for
  MySQL syntax compatibility and is **not supported**.
- Behavioral differences from MySQL that will bite a migrating app:
  - Write requests from other sessions **return an error immediately** instead of blocking and
    waiting, which is what MySQL does.
  - `LOCK TABLES` itself errors rather than waiting when another session holds the lock.
  - The feature works **cluster-wide**, not per-server.
  - Starting a transaction with `BEGIN` does **not** implicitly release held table locks, unlike
    MySQL.

**Assign (no SQL needed if the parameter is off, which it will be on Cloud):** "A customer's
legacy application issues `LOCK TABLES` before a batch job. Walk me through what you tell them."

Grade the answer for these beats: the feature is off by default and experimental so it is not a
path you recommend; the semantics differ from MySQL in ways that will change their app's error
handling; the real question is what the batch job is trying to guarantee, because the right
answer is almost always a transaction rather than a table lock.

**Check (run it to show the parameter is not SQL-settable):**
```
python verify.py "SHOW VARIABLES LIKE '%table_lock%'"
```
Report what actually returns. On a managed tier the trainee cannot enable this, which is the
practical answer to the customer question.

**Socratic:** "Why would a distributed database make other sessions error immediately instead of
queueing behind a table lock?" (Queueing behind a cluster-wide exclusive lock across nodes turns
a lock into a distributed availability problem; failing fast is the safer default. Let them
reason toward it.)

**SE drill:** "Prospect: 'our app uses LOCK TABLES, is that supported?' Two sentences." Grade
for: honest that it exists but is experimental and off by default, honest that semantics differ,
immediately pivots to what they are trying to protect. Do **not** let the trainee answer a flat
"yes, supported" - that answer causes a failed migration later.

---

## Task 4 - The part that surprises people: DDL and CDC

**Framing:** the customer's schema change does not stop at the database. If they run a changefeed
into a warehouse or a Kafka topic, a DDL is an event in that stream too. This is where an
otherwise clean migration falls over, and knowing it makes an SE look like they have done this
before.

**What TiCDC does with DDL:**
- TiCDC uses an **allow list** of DDL statements. DDLs on the list replicate downstream; others
  are ignored.
- Whether a table replicates at all depends on it having a **valid index**, and on the
  `force-replicate` setting. With `force-replicate=true`, TiCDC will attempt to replicate tables
  without a valid index.
- **The trap:** a DDL that drops the last valid index - including `DROP INDEX` and
  `DROP PRIMARY KEY` - is **not replicated, and subsequent data replication fails.** A developer
  cleaning up an unused index can break the pipeline.
- `RENAME TABLE` that swaps two table names in one statement is **not supported**.
- A `RENAME TABLE` where the old name does not match the changefeed's filter but the new name
  does will **error and exit replication.**
- When the downstream is TiDB, TiCDC executes create-index and add-index DDLs
  **asynchronously** - it returns without waiting for completion, which can leave later DDLs
  queued indefinitely and eventually failing on retry timeout.

**Assign (whiteboard, no cluster):** "A customer has TiDB replicating to Snowflake via a
changefeed. Their team wants to drop an unused index next sprint. What do you warn them about,
and what question do you ask first?"

Pass when they get to: is that the last valid index on the table, because if so the changefeed
breaks and replication fails after the DDL, not during it.

**Socratic:** "Why is 'replication fails *after* the DDL' worse than the DDL simply being
rejected?" (Silent divergence. The upstream succeeded and the pipeline is broken, so the failure
shows up as stale downstream data, potentially noticed much later.)

**SE drill:** "Prospect: 'does your CDC handle schema changes automatically?' Two sentences."
Grade for: yes for allow-listed DDLs, honest about the specific traps (last valid index, table
name swaps, filter-crossing renames), and offers to review their schema-change process rather
than claiming it is all automatic.

---

## Week 6 (DDL/DML/locks/CDC) done when

The trainee can, unprompted:
1. Define DDL and DML in customer language and say why DDL is the dangerous one.
2. Name the online DDL intermediate states and explain why the intermediate states exist.
3. State correctly that metadata lock makes **DDL wait for old transactions**, not the reverse,
   and name the long-transaction caveat.
4. Give the metadata lock vs table lock distinction in one sentence each.
5. Name at least two DDLs that break a TiCDC changefeed.

Most common failures to record in `progress.json`: getting the metadata lock direction backwards
(saying it blocks DML), and answering "yes, supported" on `LOCK TABLES` without the experimental
and semantics caveats. Both cause real damage on a call - re-drill them.

---

## Sources used for this lesson

- `docs.pingcap.com/tidb/stable/metadata-lock/` - purpose, DDL waits for old-metadata DMLs,
  one-version invariant, `tidb_enable_metadata_lock`, v6.3.0 introduced / v6.5.0 default on
- `docs.pingcap.com/tidb/stable/sql-statement-admin-show-ddl/` - 13 columns, `STATE` and
  `SCHEMA_STATE` values, `done` vs `synced`
- `docs.pingcap.com/tidb/stable/sql-statement-lock-tables-and-unlock-tables/` -
  `enable-table-lock` config parameter, experimental, default off, excluded schemas, lock types,
  MySQL behavioral differences
- `docs.pingcap.com/tidb/stable/ticdc-ddl/` - allow list, valid-index requirement,
  `force-replicate`, last-valid-index failure, rename restrictions, async index DDL downstream

Re-verify before teaching. Lock semantics and TiCDC restrictions are version-specific.
