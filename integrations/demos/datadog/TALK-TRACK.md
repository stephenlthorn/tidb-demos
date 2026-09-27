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
   UNVERIFIED, since DBM's documented supported databases are Postgres, MySQL,
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
