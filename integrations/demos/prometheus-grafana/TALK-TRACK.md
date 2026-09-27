# Talk track: Prometheus, Grafana, and Alertmanager

## Per-phase script

- **Steady state:** "This TiDB cluster is running a normal OLTP mix. Prometheus is
  already scraping it and Grafana is already showing it, the same way your Node
  Exporter and Postgres Exporter dashboards work today."
- **Slow query storm:** "I'm about to run a query that forces a full table scan.
  Watch the p99 latency panel. This is the exact `TiDB_query_duration` alert rule
  PingCAP ships in its docs, not something we wrote for this demo."
- **Write hot spot:** "Sequential primary keys are a classic anti-pattern in any
  sharded or Raft-replicated system. Watch one TiKV instance's CPU spike while its
  peers stay idle."
- **TiKV store outage:** "This is the question every platform review asks: what
  happens when a node dies. I'm stopping one TiKV process outright."
- **Connection surge:** "A leaking connection pool in a client library is one of
  the most common pages an on-call engineer gets. Here it is happening live."
- **Recovery:** "I'm clearing every fault. No dashboard edits, no alert
  acknowledgements, just clean signal."
- **Wrap-up:** "Four faults, four PromQL alerts, one Alertmanager route to a
  webhook, and every one of them resolved without help."

## Discovery questions

1. "What Prometheus and Grafana version are you running today, and is Alertmanager
   already part of that stack?"
2. "Do your DBA and platform teams share one alerting pipeline, or does the database
   team run a separate one?"
3. "What's your current mean time to detect a hot-spot or a node failure in your
   existing database?"
4. "Who owns writing and maintaining alert rules for a new database today?"
5. "Would TiDB Cloud's metrics need to land in this same Prometheus, or would a
   native Datadog or cloud-console view be acceptable for some teams?"

## Objections and honest answers

1. **"We don't want to run yet another Prometheus."** You don't have to; this demo's
   demo-local Prometheus stands in for the one you already run. In production you'd
   point your existing Prometheus at TiDB's status ports directly, no federation
   layer needed.
2. **"Alertmanager routing here looks too simple for our on-call rotation."** It is
   intentionally minimal. The point is that the alert rules and PromQL are unchanged
   from what PingCAP documents; your existing Alertmanager routing tree, silences,
   and inhibition rules apply exactly as they do for any other Prometheus target.
3. **"How do we know these alert thresholds are right for our workload?"** They
   aren't tuned for you. They're PingCAP's documented defaults, meant as a starting
   point (see `docs.pingcap.com/tidb/stable/alert-rules/`); every team retunes
   thresholds during onboarding.
4. **"Does TiDB Cloud expose the same metrics?"** For Dedicated clusters, yes,
   through a Prometheus-compatible scrape endpoint with a different metric
   namespace (`tidbcloud_*`); Starter and Essential do not currently support this
   integration.
5. **"What happens to alerts if Prometheus itself goes down?"** Out of scope for
   this demo; that's a general Prometheus high-availability question (for example
   Thanos or a second replica), not specific to TiDB.
