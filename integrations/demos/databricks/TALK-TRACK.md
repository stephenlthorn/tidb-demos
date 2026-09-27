# Talk track: TiDB + Databricks

## Phase-by-phase script

**Steady-State Writes.** "This is just an app writing to TiDB - purchases,
refunds, chargebacks, one row at a time, like any OLTP workload. Nothing
Databricks-specific here yet; this is the system of record most teams
already have."

**Databricks Reads TiDB Live.** "Now watch the right side. Databricks is
querying TiDB directly, through a read-only Lakehouse Federation connection
in Unity Catalog. No export job ran, no file landed in a bucket first - this
is a live JDBC read against the same TiDB cluster the app is writing to
right now."

**Reverse ETL: Scores Back to TiDB.** "Databricks just computed a risk score
per customer from that data. Those scores are landing back in TiDB, in a
table the app already knows how to query. This is the reverse-ETL half of
the loop - lakehouse compute, operational serving."

**Serving Fresh Scores.** "The app is reading those scores right now, at
single-digit-millisecond p50, while new events keep landing in the
background. That's the point: analytical compute happened on Databricks,
but nobody has to stand up a second serving database to use the result."

**Ad Hoc Analytics on Fresh Data.** "Same fresh data, same cluster - now
answered by the columnar engine instead of the row store. One button, no
second database, no separate ETL to keep an analytics replica in sync."

**Changing the Rule Live.** "Swapping the scoring rule from velocity-weighted
to amount-weighted is a SQL change on the Databricks side. Nothing in TiDB
or the app redeploys."

## Discovery questions

1. "Where does your team currently store the operational data Databricks
   reads for training or scoring - and how does it get there today?"
2. "When a Databricks job produces a score or a feature, what serves it back
   to your application, and how fresh does that have to be?"
3. "Have you had to build or maintain a CDC pipeline just to get operational
   data into the lakehouse? What did that cost to build and to keep running?"
4. "If your operational database and your analytics store are different
   systems today, how do you reconcile them when they disagree?"
5. "What's your tolerance for the lag between an event happening and a
   Databricks-computed feature being usable by an application?"

## Objections and honest answers

1. **"We already have a CDC pipeline into our lakehouse; why would we
   change it?"** If it works and meets your freshness bar, keep it. This
   demo's federated-read path is for the read side of the loop and doesn't
   require replacing an existing ingestion pipeline; it's most compelling
   when the missing piece is the *reverse* direction - getting a
   Databricks-computed result back into a low-latency serving store, which a
   one-way CDC pipeline usually doesn't do for you.
2. **"Isn't querying an operational database from an analytics engine going
   to slow down our OLTP traffic?"** In this demo, the federated read is a
   scoped, time-windowed aggregate, not a full scan, and TiDB's TiFlash
   replica exists specifically so analytical reads don't compete with OLTP
   reads/writes on the row store. We show writes continuing throughout the
   scoring window as a check, not just a claim - but a much larger federated
   query against the row store on a small cluster can still add load; index
   and window the query at production scale the same way we did here.
3. **"Why not just batch-export to S3 and use Auto Loader like everyone
   else?"** That's a legitimate, cheaper-at-scale pattern, and this plan
   documents it as an alternative (path (c) in Section 4 of the design doc).
   It trades the "seconds" loop time this demo shows for cheaper, batch-cadence
   freshness. Pick it if your use case tolerates minutes-to-hours of lag;
   pick the federated-read path if it doesn't.
4. **"TiDB Cloud Starter is a free tier - does any of this hold up on a
   production cluster?"** The read path (Lakehouse Federation) and the
   reverse-ETL write path (a normal SQL upsert) work the same way on
   Dedicated or Premium; what changes at that tier is that TiCDC-to-Kafka and
   export-to-S3 also become available as additional, complementary paths
   (Section 4), and you get dedicated compute instead of shared multi-tenant
   capacity.
5. **"What happens if the Databricks warehouse is slow or down when we need
   a fresh score?"** The app keeps serving whatever score is already in
   TiDB - staleness is visible (the freshness-lag metric would climb), but
   there's no outage in the serving path, because TiDB is not blocked
   waiting on Databricks. That's a direct benefit of decoupling the serving
   store from the compute engine that feeds it.
