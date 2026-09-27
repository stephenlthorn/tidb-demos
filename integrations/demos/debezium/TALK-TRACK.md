# Talk track: Debezium + TiDB

## Warming up
"This is the Debezium and Kafka Connect stack most data platform teams
already run. We're not changing anything about it - we're changing what's
on each end."

## Act A: live replication into TiDB
"Postgres is the source of truth today. Every row that lands there is in
TiDB within milliseconds, through the same JDBC sink connector you'd point
at any relational target. The lag number you're watching is a heartbeat row
we write once a second - not modeled, read back directly."

## Act B: TiDB as a Debezium source
"Now flip it: TiDB is the source. TiCDC speaks Debezium's message format,
so the exact same consumer code reads changes from TiDB. It's not a
byte-identical clone of real Debezium output - TiCDC adds a couple of its
own fields - but the shape a consumer cares about is there."

## Act C: schema change
"We add a column live, on the source. Watch how long it takes to show up as
a real column in TiDB, and watch the consumer's parse rate while the schema
is changing underneath it."

## Wrap-up
"One consumer, two topics, two very different origins - Postgres and
TiDB - both spoken in Debezium's own format."

## Discovery questions

1. "What does your Kafka Connect footprint look like today - which source
   and sink connectors are you running, and against which databases?"
2. "If you migrated your primary database to TiDB tomorrow, which of your
   existing Debezium consumers would you want to keep unchanged?"
3. "How do you handle schema changes on your source database today - is
   there a coordinated migration step, or does it just flow through?"
4. "Do you have a heartbeat mechanism today to measure replication lag, or
   is that currently a blind spot?"
5. "Is Kafka Connect itself something your team operates, or is it managed
   for you (Confluent Cloud, MSK Connect, etc.)?"

## Objections and honest answers

1. "Is TiCDC's Debezium output really compatible with our existing
   consumers?"
   It is JSON-shaped like Debezium's envelope and carries the fields a
   typical consumer reads (`op`, `after`, `source.table`, `ts_ms`), but it
   is not byte-identical - it reports `connector: "TiCDC"` and adds
   `CommitTs`/`ClusterID` fields, and (depending on your TiCDC version and
   architecture) may not carry DDL events the way real Debezium does. Test
   your actual consumer against a sample topic before committing to this.
2. "Does the JDBC sink connector really not need extra configuration for
   TiDB?"
   It needs a JDBC URL pointed at TiDB's MySQL-protocol port, same as any
   MySQL-compatible target. The exact dialect behavior against TiDB is
   something this plan explicitly calls out as needing a live check before
   it is treated as an assumption.
3. "What happens to in-flight replication if Kafka Connect itself restarts?"
   This demo does not exercise a Kafka Connect worker restart; it only
   exercises connector-level restarts. Worker-level fault tolerance is a
   Kafka Connect operational question independent of the sink target.
4. "Can this run against TiDB Cloud instead of local TiDB?"
   For Act B, yes - TiDB Cloud Dedicated v8.1.0+ supports Debezium-format
   Kafka sinks. Act A (the JDBC sink) just needs a reachable JDBC endpoint,
   which TiDB Cloud Dedicated provides.
5. "Do we lose anything by not using Confluent's own JDBC sink connector?"
   You gain not needing the `ExtractNewRecordState` SMT, because Debezium's
   own JDBC sink reads its native envelope directly. You would choose
   Confluent's version if your organization already standardizes on it for
   non-Debezium sources too; that tradeoff is organizational, not technical.
