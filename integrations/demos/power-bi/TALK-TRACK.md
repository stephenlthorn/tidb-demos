# Talk track: Power BI + TiDB

## Presenter script, per phase

**Intro (`intro`).** "A business team wants a live dashboard on operational
orders, not a copy that is a day old. One TiDB cluster is about to serve
both the checkout writes and the report."

**Baseline writes (`seed-baseline`).** "Orders are flowing into TiDB now,
no dashboard load yet. This write p99 is the baseline we compare against
once the dashboard starts querying." Point at the `write-p99` line.

**Add the TiFlash replica (`tiflash-replica`).** "Adding a TiFlash replica
to the orders table live: this is the columnar copy the dashboard will
read from, syncing from the same rows being written right now." Point at
the `tiflash-replica-progress` tile climbing to 100% and the
`tiflash-replica-available` check turning green.

**Dashboard load on TiKV (`dashboard-on-tikv`).** "Routing the dashboard's
query set at TiKV, the same engine handling the writes. Watch the write
p99 line: this is what a warehouse-free dashboard used to cost you." Let
`write-p99` visibly rise before moving on.

**Dashboard load on TiFlash (`dashboard-on-tiflash`).** "Same dashboard
queries, same concurrency, now routed to TiFlash. Write p99 comes back
down: the analytical load is isolated on its own replica." Point at the
`write-p99-within-threshold` check turning green and the
`snapshot-totals-match` check confirming TiKV and TiFlash agree on the
same snapshot.

**Freshness check (`freshness-check`).** "A heartbeat order just
committed. Watch how many milliseconds until it is visible in a
TiFlash-routed dashboard query - that is the real replication lag, not a
marketing number." Read the actual `freshness-ms` value off the tile; do
not round it up or down.

**The real Power BI report (`power-bi-live`).** "Cutting to a real Power
BI Desktop report connected to this same cluster. Refreshing it pulls in
the orders written during this run." Let the screen recording play; do
not talk over the Refresh click.

**Recap (`wrap-up`).** "No nightly ETL job, one cluster, a dashboard that
is current to the second, and writes that never noticed the analytics
running next to them."

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
   that the *database* layer is current to the second; a refreshed Power
   BI Import model reflects that on each refresh, manual or scheduled. We
   do not claim Power BI streams live.
2. **"Our BI team won't give up their warehouse for this."** This demo
   does not ask them to. It targets the class of dashboard that currently
   waits on a nightly batch for no reason other than "that's how the
   pipeline works," not a wholesale warehouse replacement.
3. **"TiFlash is another engine to operate - what does that cost us?"**
   On TiDB Cloud, TiFlash nodes are managed by the platform per the
   selected tier. Self-managed, it is an additional node type in the
   cluster topology - real, but there is no separate ETL pipeline or
   warehouse to build and maintain instead.
4. **"How much replication lag does TiFlash really have under load?"**
   Whatever this run measured on the `freshness-ms` tile - that is the
   number we show, with the exact measurement method documented in the
   manifest. We do not assert "near zero" as a marketing claim.
5. **"Won't heavy Power BI dashboard traffic slow down my checkout
   writes?"** That is exactly what `write-p99-degradation` and the
   `write-p99-within-threshold` check measure, with a numeric threshold,
   so the isolation claim is falsifiable rather than asserted.
