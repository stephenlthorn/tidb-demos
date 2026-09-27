# Talk track: Kafka + TiDB

One line per phase, in the order the manifest plays them. Say the line, then
point at the metric or check named alongside it.

## warm-up - "Warming up"

"We're standing up a normal Kafka-to-TiDB pipeline: nothing custom, just a
consumer doing upserts."

## steady-state - "Steady state"

"At steady state every payment event becomes a row in TiDB, and TiCDC
re-publishes that row change within milliseconds. Watch the end-to-end
latency series (`e2e-latency-p50`, `e2e-latency-p99`) - that's produce time
to CDC-consume time, measured, not modeled."

## burst - "10x burst"

Control: `burst` ("Burst 10x for 30s").

"Now we 10x the load. Watch `ingest-rate` and `ticdc-checkpoint-lag` - TiDB
absorbs it, TiCDC catches up."

## ingester-restart - "Ingester restart"

Control: `restart-ingester` ("Kill ingester").

"We kill the ingester consumer. Kafka holds its committed offset, so when it
reconnects it resumes exactly where it left off - watch `consumer-lag-payments`
drain back down, and no duplicate rows land in TiDB, because the upsert is
idempotent on `payment_id`."

## changefeed-pause-resume - "Pause and resume the changefeed"

Controls: `pause-changefeed`, `resume-changefeed`.

"We pause the changefeed itself. TiDB keeps taking writes. When we resume,
TiCDC catches up from its checkpoint - and this is exactly where Kafka's
at-least-once delivery shows up as visible duplicates downstream. Watch
`duplicates-observed` tick up on purpose."

## wrap-up - "Wrap-up"

"`produced-equals-tidb-rows` and `tidb-rows-equals-cdc-distinct` both pass,
and `zero-duplicate-rows-in-tidb` holds throughout. Produced count equals
rows in TiDB equals distinct CDC events. Duplicates happened downstream, and
we caught every one of them."

## Discovery questions

1. "What do you use Kafka for today, and where does the database sit in
   that pipeline?"
2. "When a downstream consumer needs to react to a database change, how do
   you get that change into Kafka today?"
3. "How do you handle a consumer crash mid-batch today - do you have an
   idempotency key on the write side?"
4. "Have you measured how long it takes a change to reach your downstream
   consumers today, or is that a blind spot?"
5. "What's your tolerance for duplicate events downstream - do your
   consumers already dedupe, or would this be new?"

## Objections and honest answers

1. "Doesn't this add another moving part (TiCDC) to our architecture?"

   Yes. It's one more component, and it's optional - you only add it if you
   need the second Kafka topic. If you just need Kafka-in, TiDB-out, you
   don't need TiCDC at all.

2. "Kafka's at-least-once - doesn't that mean we can get duplicate rows in
   our downstream systems?"

   Yes, and this demo shows it happening on purpose during the
   `changefeed-pause-resume` phase: TiCDC guarantees at-least-once delivery
   to its Kafka sink, not exactly-once, and PingCAP's own documentation
   says consumers must filter duplicates. The fix is the same fix you'd use
   with any at-least-once system: dedupe on a stable key, which is what the
   risk consumer does here (the `duplicates-observed` metric is that dedupe
   set catching the repeats).

3. "What happens if TiCDC itself falls behind permanently, not just during
   a burst?"

   This demo doesn't test that; it tests recoverable lag under a bounded
   burst and a bounded pause (`ticdc-checkpoint-lag` recovering after the
   `burst` and `changefeed-pause-resume` phases). Sustained lag under
   sustained load is a capacity-planning question, not something this demo
   measures.

4. "Can we point this at our existing Kafka cluster instead of the local
   one?"

   Yes - change `KAFKA_BROKERS` and the sink-uri host list. The Kafka ACLs
   TiCDC needs are Topic Create/Write/Describe and Cluster DescribeConfig
   for the user TiCDC connects as (Describe/Create can be dropped if the
   topic already exists).

5. "Does TiDB Cloud support this, or is it self-managed only?"

   TiDB Cloud Dedicated supports changefeeds to Kafka; Starter does not;
   Essential's changefeed support is request-only, not self-serve. See the
   README's "TiDB Cloud variant" section and cost notes for the current
   tier page rather than trusting a number quoted here.
