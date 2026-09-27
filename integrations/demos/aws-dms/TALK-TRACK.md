# Talk track: AWS DMS + TiDB

Pattern: a fintech evaluating a move from Aurora PostgreSQL to TiDB, testing
AWS DMS full load plus CDC as the migration path. Present this as the
anonymized pattern - no customer or prospect name, no internal ticket or
document links.

## provision - Provision and verify

"Aurora PostgreSQL, AWS DMS, and TiDB Cloud are up. This is the same DMS you
already use for other migrations."

Point at the diagram: `app-writer` is already writing to `aurora-pg`, and
the runner has just confirmed `DescribeReplicationInstances` and a TiDB
`SELECT 1` both succeed before anything else happens.

## schema - Schema conversion

"DMS creates tables and primary keys. Everything else in the type
conversion is explicit, and we show you exactly what changed - look at the
mapping table, nothing here is a black box."

Show the PostgreSQL source types next to the hand-written TiDB DDL:
`SERIAL`/`BIGSERIAL`, `JSONB`, `BOOLEAN`, `TIMESTAMPTZ`, `UUID`, `NUMERIC`,
and arrays each have a documented target type. The `schema-parity` check is
a static design check, reported once at demo start, not a runtime measurement.

## full-load - Full load

"DMS full-loads the existing orders and accounts tables while the app keeps
taking traffic. Watch the per-table completion percentage."

Narrate `full-load-rows-sec` (throughput) and `full-load-pct` (completion)
as they climb per table.

## cdc-live - CDC under live load

"Now every insert, update, and delete on Aurora flows through logical
replication into TiDB, live. We can burst the write rate and DMS keeps up."

Press **Burst writes** here. Call out `cdc-apply-rows-sec` rising to match,
and `cdc-latency-source-s` / `cdc-latency-target-s` staying low under the
burst rather than climbing unbounded.

## validate - Validate

"We don't just trust DMS's validation state, we recompute row counts and
checksums ourselves on both databases, with a canonical row encoding so
formatting differences between PostgreSQL and TiDB never cause a false
mismatch."

Press **Run validation** here. `row-count-diff` should read zero, and the
`row-count-match` / `checksum-match` checks should both pass.

## cutover - Cutover

"Writes stop, CDC drains to zero lag, we verify one more time, then the app
points at TiDB. That whole window is the downtime we measure - seconds, not
an estimate."

Press **Start cutover** here. Narrate the latency series draining to zero,
the `cutover-clean` check passing immediately before the flip, and the
final `cutover-downtime-s` tile as the number to write down.

## Discovery questions

1. "You're on Aurora PostgreSQL today - what's driving the evaluation of TiDB?"
2. "Have you used AWS DMS for a migration before, and what went wrong or right?"
3. "What's your tolerance for a cutover downtime window - seconds, minutes, longer?"
4. "How do you validate a migration today - do you trust the vendor's validation state, or recompute it yourself?"
5. "Which PostgreSQL-specific features (arrays, JSONB, custom types) does your schema depend on?"

## Objections and honest answers

1. "Doesn't DMS just handle schema conversion for us?"
   No - DMS creates tables and primary keys only. Secondary indexes, foreign
   keys, sequences, and check constraints are hand-written, and this demo
   shows exactly which ones and why (`schema-parity`).
2. "Is this zero-downtime?"
   No. There is a real cutover window while writes are stopped and the
   final checks run. This demo measures that window in seconds
   (`cutover-downtime-s`) rather than assuming it away.
3. "PostgreSQL to a MySQL-compatible target - what data types actually survive?"
   The mapping table documents every column: `UUID` becomes a 36-char
   string, arrays become text, `JSONB` becomes native JSON, `NUMERIC` keeps
   explicit precision and scale to avoid DMS's default-precision truncation.
4. "What if our tables don't have primary keys?"
   DMS CDC requires one - UPDATE/DELETE without a primary key are otherwise
   silently ignored. This is a hard constraint to flag early with a
   customer, not something to discover mid-migration.
5. "Does this work with DMS Serverless instead of a replication instance?"
   Unverified end to end against TiDB Cloud specifically at the time of
   writing - this demo defaults to a classic replication instance because
   that is the path the vendor's own documented guide verifies.
