# Week 7 (part 2) - Spanner, SingleStore, Snowflake (tutor lesson)

Teach `lessons/week-07-competitive.md` first. That file covers Aurora, RDS, MySQL, Postgres +
pgvector, DynamoDB, and Oracle. This file covers the three that were missing, and it corrects one
positioning line in the original that will get an SE caught out.

Objective: the trainee can hold a comparative conversation about these three without reaching for
a claim that a competent engineer on the other side of the table can immediately falsify.

---

## Read this first: a correction to the Week 7 positioning line

`lessons/week-07-competitive.md` opens with:

> "TiDB is the only MySQL-compatible database that does OLTP, OLAP, vector search, and full-text
> search behind one ACID boundary at horizontal scale."

**Do not let the trainee use that sentence against SingleStore, and be careful with it against
Spanner.** Here is why:

- **SingleStore is MySQL wire-protocol compatible**, has both rowstore and columnstore in one
  table type (Universal Storage), has vector search, and has full-text search. It ticks every box
  in that sentence. Stated unqualified in front of someone who knows SingleStore, that line is
  simply false and the SE loses the room.
- **Spanner** is not MySQL compatible, so the sentence is technically survivable. But Spanner now
  has vector search, full-text search, **and** a columnar engine. So the *spirit* of the claim -
  "only we consolidate all four" - is no longer a safe differentiator against Spanner either.

**The defensible version** to teach instead:

> "TiDB brings OLTP, real-time analytics, vector, and full-text search behind one ACID boundary,
> on the MySQL wire protocol, as open source you can also run yourself."

That version survives contact with all three competitors in this lesson, because the combination
of **MySQL wire + open source + self-hostable + agent-scale multi-tenancy** is the part none of
them match. Make the trainee say the corrected version until it is automatic.

Tell the trainee explicitly that you are correcting a line in their other lesson file, and why.
Learning that positioning claims decay is part of the job.

---

## SingleStore - the closest architectural rival, treat it with respect

**Be honest with the trainee up front: on a feature checklist, this is the hardest competitor in
the deck.** An SE who walks in expecting the pgvector conversation will get taken apart.

**What it is:** a distributed SQL database with **aggregator nodes** (receive queries, plan,
route) and **leaf nodes** (store a shard of the data, execute). Add nodes for horizontal scale
and fault tolerance. Presented through a **MySQL wire protocol-compatible interface** (it also
offers MongoDB wire compatibility).

**Universal Storage** is their headline: a single table type combining in-memory rowstore and
on-disk columnstore, aimed at transactional and analytical workloads in one place. Architecturally
this is the same *idea* as TiKV + TiFlash, packaged differently.

**They have:** vector search with KNN and ANN (IVF, HNSW, PQ indexes), full-text search, JSON,
time-series, geospatial, key-value.

**So where is the actual difference?** Move off the feature checklist and onto these:

1. **Open source vs proprietary.** TiDB is Apache 2.0. SingleStore is a proprietary commercial
   product. This is the cleanest, most verifiable difference, and it drives the lock-in argument
   from `lessons/week-02-cloud-vs-self-hosted.md`.
2. **No self-hosted exit ramp on equal terms.** A TiDB customer can run the same engine
   themselves, forever, for free. Ask what a SingleStore customer's exit looks like.
3. **MySQL compatibility depth.** Both claim MySQL wire compatibility, but wire compatibility and
   behavioral compatibility are different things. This is a *testable* claim, not a talking point:
   the honest move is to propose running the customer's actual schema and queries against both.
4. **Agent-scale multi-tenancy.** TiDB Cloud Zero provisions isolated database branches in
   milliseconds, which is how Manus runs 1.4M+ databases created by agents. Ask what the
   equivalent motion is on SingleStore. This is the strongest ground in the comparison.
5. **Cost shape.** SingleStore's rowstore has historically been memory-resident, and memory is the
   expensive resource. **Verify the current model before making this argument** - do not assert a
   competitor's pricing or storage economics from memory, because it changes and being wrong here
   destroys credibility.

**Where SingleStore genuinely wins:** a customer already running it successfully on a
consolidated analytics-plus-transactions workload has no reason to move. Do not manufacture one.

**Assign:** "Open SingleStore's own documentation and find their statements on wire-protocol
compatibility and on Universal Storage. Then write down the three questions you would ask a
prospect to find out whether the difference between the two products actually matters to them."

Grade the three questions, not the research. Good questions surface the size of their existing
MySQL estate, whether they need an eventual self-host path, and how many isolated tenants or
databases they expect. Weak questions ask about features.

**Socratic:** "SingleStore checks every capability box TiDB does. What is left to compete on, and
which of those is the customer most likely to actually care about?"

**SE drill:** "Prospect: 'we're also evaluating SingleStore, and honestly it looks similar.' Two
sentences." Grade hard for: does **not** claim a capability SingleStore lacks that it actually
has, moves to open source / self-host / multi-tenancy, and proposes a test rather than an
assertion. Any answer that leads with a feature checkbox is a fail.

---

## Spanner - technically formidable, structurally constrained

**What it is:** Google's fully managed, horizontally scalable relational database. Automatically
shards data across servers and regions. Its distinguishing property is **TrueTime** (atomic clocks
and GPS receivers across datacenters) which gives it **external consistency**: transactions are
globally ordered as if they happened sequentially, so if T1 completes before T2 starts, T1's
effects are visible to T2.

Be straight with the trainee: **that is a genuinely strong consistency guarantee.** Do not try to
win the consistency argument against Spanner. TiDB is CP with Raft and snapshot isolation, which
is the right guarantee for its workloads, but Spanner's external consistency across regions is a
real engineering achievement and pretending otherwise makes an SE look uninformed.

**SQL dialects:** GoogleSQL (native) and a PostgreSQL interface. **Not MySQL compatible.** For a
customer with a large MySQL estate, moving to Spanner is an application rewrite, and moving to
TiDB is largely not. This is the single most important commercial fact in the comparison.

**What Spanner now has that trainees may not expect:**
- **Vector search** via ANN indexes built on ScaNN, Google's own indexing algorithm, plus exact
  KNN.
- **Full-text search** using tokenizer functions and search indexes.
- **A columnar engine** integrated into its storage layer, enabled per table or index via a
  columnar policy, for analytical queries on live operational data.
- **Hybrid search** patterns combining full-text and vector.

**Do not claim Spanner cannot do analytics, vectors, or search. It can.** If the trainee makes
that claim, correct it immediately - this is exactly the kind of stale competitive line that gets
an SE publicly corrected by a customer's architect.

**Where the real argument lives:**

1. **MySQL compatibility.** The migration cost story. This is the strongest single point.
2. **Cloud lock-in.** Spanner is Google Cloud only. No AWS, no Azure, no on-prem, no self-hosted.
   A multi-cloud or AWS-centric customer is not really shopping Spanner. Note that Spanner's own
   architecture depends on Google infrastructure (TrueTime, Colossus), so this is structural, not
   a roadmap gap.
3. **No self-hosted option, at all.** Same exit-ramp argument as everywhere else.
4. **Cost and pricing model.** Spanner is widely considered expensive at scale. **Verify current
   pricing before quoting anything** - never put a competitor's price in a customer's ear from
   memory.

**Assign:** "Write the two-sentence answer to 'why not Spanner?' for two different prospects: one
running 300 MySQL instances on AWS, and one that is greenfield and all-in on Google Cloud. They
should not be the same answer."

Pass when the second answer qualifies out or narrows to a specific TiDB advantage rather than
recycling the migration-cost argument that only applies to the first prospect.

**Socratic:** "Spanner has vector search, full-text search, and a columnar engine. What is left of
the consolidation pitch?" (Consolidation is no longer the differentiator against Spanner. MySQL
compatibility, cloud portability, and self-hostability are.)

**SE drill:** "Prospect on GCP: 'why wouldn't we just use Spanner?' Two sentences." Grade for:
does not attack Spanner's capabilities, leads with MySQL compatibility and migration cost, asks
whether they are committed single-cloud. If the customer is all-in on GCP with no MySQL estate and
no multi-cloud plan, the honest answer is that Spanner is a reasonable choice - and the trainee
should be willing to say so and qualify out.

---

## Snowflake - usually not the competitor, usually the neighbor

**The framing error to fix first:** trainees see Snowflake on a competitive list and try to
displace it. That is normally the wrong play. Snowflake is a cloud data **warehouse** - its home
turf is large-scale analytics, and it is very good at it. It is rarely the system serving a
customer's application traffic.

**So what is the actual conversation?** Two different ones, and the trainee must diagnose which:

**Conversation A - coexistence (most common).** The customer's app runs on MySQL/Aurora/TiDB,
and Snowflake is where analytics lives, fed by a pipeline. The TiDB argument here is not "replace
Snowflake." It is: **TiFlash removes the need to round-trip to the warehouse for operational
analytics.** The dashboard that needs data from the last five minutes should not require a
pipeline into Snowflake and back. Snowflake keeps the historical, cross-source, company-wide
analytics. TiDB serves the real-time operational query on live data. That is an honest division of
labor, and it is a much easier sell than a displacement.

**Conversation B - Snowflake creeping into OLTP.** Snowflake's **Unistore**, powered by **Hybrid
Tables**, is their transactional play: a row-based storage engine with index-based random reads and
writes, row locking for concurrency, and enforced unique and referential integrity constraints.
Hybrid Tables reached general availability in AWS commercial regions (announced November 2024).

If a customer is considering Hybrid Tables for application workloads, these are the documented
limits to raise - as questions about their workload, not as attacks:
- **Throughput ceiling:** roughly **16,000 operations per second per database** for a balanced
  80/20 read/write workload; exceeding it may result in Snowflake throttling throughput. For a
  customer talking about 1M+ QPS, that is the end of the conversation, and it is their own vendor's
  documented number.
- **Index changes:** adding a column to an existing index, or altering an index on an existing
  hybrid table, is not supported - the change requires dropping and re-creating the index.
- **Time Travel restrictions:** only the `TIMESTAMP` parameter is supported in the `AT` clause,
  and its value must be the same for all tables in the same database.

Compare to the Flipkart proof point from the main competitive lesson: 700+ MySQL clusters to one
TiDB cluster at 1M+ QPS with P95 under 5ms. Use the real numbers and do not round them up.

**Where Snowflake wins and the trainee should concede:** enterprise-wide analytics across many
sources, an established BI and governance practice, data sharing between organizations. Do not
pitch TiDB as a data warehouse replacement.

**Assign:** "Sketch the customer's architecture for Conversation A: app database, pipeline,
Snowflake, and the dashboards. Now mark the one query on that diagram that should never have gone
to Snowflake, and say what it costs the customer today."

Pass when they identify a latency-sensitive operational query sitting behind a batch pipeline, and
can name the cost in staleness rather than in dollars.

**Socratic:** "A prospect has Snowflake and is happy with it. Where is the deal, and where is the
part you should not touch?"

**SE drill:** "Prospect: 'we already have Snowflake for analytics, so we don't need HTAP.' Two
sentences." Grade for: separates real-time operational analytics from warehouse analytics, does
not attack Snowflake, asks about pipeline lag and whether any dashboard needs fresher data than
the pipeline delivers.

---

## Comparative matrix (extends the Week 7 matrix)

| Capability | TiDB Cloud | SingleStore | Spanner | Snowflake |
|---|---|---|---|---|
| MySQL wire compatible | YES | YES | NO | NO |
| Open source | YES (Apache 2.0) | NO | NO | NO |
| Self-hosted option | YES | see note | NO | NO |
| Horizontal write scale | YES | YES | YES | limited (Hybrid Tables) |
| Row + columnar in one system | YES (TiKV+TiFlash) | YES (Universal Storage) | YES (columnar engine) | YES (Unistore) |
| Vector search | YES | YES (IVF/HNSW/PQ) | YES (ScaNN) | see note |
| Full-text search | YES (BM25) | YES | YES | see note |
| Multi-cloud | YES | see note | NO (GCP only) | YES |
| Agent-scale multi-tenancy | YES (Cloud Zero) | verify | verify | NO |
| Primary design target | OLTP + HTAP | HTAP | Global OLTP | Analytics warehouse |

**Cells marked "see note" or "verify" are deliberate.** Do not fill them in from memory during a
session. If a trainee needs one for a live deal, look it up in the competitor's own documentation
and cite it. A confidently wrong cell in this table is worse than a blank one.

---

## Week 7 part 2 done when

The trainee can:
1. Deliver the **corrected** positioning line, and explain why the original fails against
   SingleStore.
2. Name what SingleStore genuinely matches, and pivot to open source / self-host / multi-tenancy
   instead of arguing features.
3. Say plainly that Spanner has vector, full-text, and columnar capabilities, and still make the
   MySQL-compatibility and cloud-portability argument.
4. Diagnose Snowflake as coexistence vs competition, and quote the Hybrid Tables throughput
   ceiling as a question about the customer's workload.
5. Qualify **out** of at least one of these three when the customer's situation genuinely favors
   the competitor.

Point 5 is the real bar. An SE who cannot say "in your situation, Spanner is a reasonable choice"
will not be believed when they say TiDB is.

Record in `progress.json` any instance of the trainee claiming a capability a competitor lacks
that it actually has. That is the failure mode this lesson exists to prevent.

---

## Sources used for this lesson

- SingleStore: `docs.singlestore.com` cluster components (aggregator/leaf), Universal Storage,
  vector data documentation; `singlestore.com/product-overview/` for MySQL and MongoDB wire
  compatibility and the capability list
- Spanner: `cloud.google.com/spanner/docs/overview` (TrueTime, external consistency, GoogleSQL +
  PostgreSQL interface), vector search overview (ScaNN, KNN/ANN), full-text search overview,
  configure columnar engine, hybrid full-text and vector search patterns
- Snowflake: `docs.snowflake.com/en/user-guide/tables-hybrid` and
  `tables-hybrid-limitations`; Unistore GA announcement (November 2024)
- TiDB proof points: `knowledge/tidb-expert.md` (Manus 1.4M+, Flipkart 700+ / 1M+ QPS / P95 <5ms)

**Re-verify every competitor claim before teaching this lesson.** These three ship features
constantly, and this lesson's whole point is not getting caught with a stale claim.
