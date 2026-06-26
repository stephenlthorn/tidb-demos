# Week 7: Competitive + Objection Mastery

SE framing: deals are won or lost here. A prospect who likes TiDB but has an existing
database vendor will always ask "why not just use X?" You need a crisp, honest answer
for each one - not a feature list, a real reason grounded in what the prospect actually
needs. This lesson builds that muscle.

---

## The one-sentence positioning

**TiDB is the only MySQL-compatible database that does OLTP, OLAP, vector search, and
full-text search behind one ACID boundary at horizontal scale.**

Every competitive response anchors back to which of those capabilities the competitor
cannot match and why it matters for the deal.

---

## Competitive matrix

| Capability | TiDB Cloud | Aurora MySQL | RDS MySQL | Postgres/pgvector | DynamoDB | Oracle |
|---|---|---|---|---|---|---|
| MySQL compatible | YES | YES | YES | NO | NO | NO |
| Horizontal write scale | YES | NO (single writer) | NO | NO | YES | NO (RAC is shared-disk) |
| Native HTAP (columnar) | YES | NO | NO | NO | NO | NO |
| Vector search | YES | NO | NO | YES (pgvector) | NO | partial (23ai) |
| Full-text / BM25 | YES | NO | partial (FULLTEXT, no BM25) | partial | NO | partial |
| ACID distributed | YES | YES | YES | YES | partial (single-table) | YES |
| Multi-tenancy (millions) | YES | NO | NO | NO | YES (key-space) | NO |
| Serverless / scale-to-zero | YES (Starter) | YES (Aurora Serverless v2) | NO | NO | YES | NO |
| Self-hosted option | YES | NO | NO | YES | NO | YES |

---

## Head-to-head breakdowns

### Aurora MySQL / RDS MySQL

**Their strength**: the default. Every AWS shop has it. MySQL-compatible, managed, familiar.

**The real gap - write scale**: Aurora is a single writer. You scale reads with read replicas,
but every write goes to one node. Aurora Global adds a second region but that second region is
read-only. When a customer's write throughput exceeds one machine's capacity they either shard
(application-level, painful) or look at something else.

**The real gap - analytics**: Aurora cannot serve real-time OLAP. The standard path is
Aurora + Redshift + a DMS/Glue pipeline. That pipeline adds 15-30 minutes of lag and a second
bill. TiDB's TiFlash replica has sub-second lag and zero pipeline to maintain.

**The real gap - AI/agent workloads**: No native vector search. No multi-tenant branching.
When a prospect asks "can Aurora handle our agent platform?" the honest answer is: it handles
the relational state, but you will need a separate vector DB, a separate analytics store, and
a lot of glue code.

**Proof point to use**: Flipkart migrated from 700+ MySQL clusters to one TiDB Cloud cluster,
handling 1M+ QPS at P95 < 5ms. That number is real - don't round it up.

**SE drill question**: "If a customer says 'Aurora is fine for now,' what does 'for now' hide?"

---

### MySQL (self-hosted)

**Their strength**: free, known, no vendor lock-in. Many companies have years of MySQL
expertise.

**The gap**: single-node writes, manual sharding when you outgrow it, ops burden.
Self-hosted MySQL shops are TiDB's most natural migration path - MySQL-compatible means
most apps need zero SQL changes (verify compatibility at docs.pingcap.com/tidb/stable/mysql-compatibility).

**Watch out for**: AUTO_INCREMENT PKs. Self-hosted MySQL typically uses them everywhere.
TiDB requires AUTO_RANDOM for high-write tables to avoid region hotspots. This is the #1
migration gotcha - always run a schema audit before quoting a migration timeline.

**Proof point to use**: Flipkart, 700+ clusters to one. Pinterest, 6 systems to one.

---

### PostgreSQL + pgvector

**Their strength**: pgvector gives Postgres native vector search. For small-to-medium AI
apps it works fine. The LangChain/LlamaIndex ecosystem treats Postgres + pgvector as a
default.

**The gap - scale**: pgvector does not scale horizontally. When you hit tens of millions
of embeddings across millions of tenants you either shard your Postgres or you rewrite.
Sharding Postgres is application-level work - you own the routing logic, the rebalancing,
the cross-shard queries.

**The gap - HTAP**: Postgres has no columnar store. For analytics you add Redshift or
another OLAP warehouse. Same ETL lag problem as Aurora.

**The gap - multi-tenancy**: Postgres + pgvector at Manus scale (10M+ databases) is not
a conversation. TiDB Cloud Zero provisions an isolated database branch in milliseconds,
per agent, with copy-on-write storage. Postgres cannot do that.

**Where pgvector wins**: greenfield projects, small scale, existing Postgres expertise.
Don't oversell against pgvector for a 50K-embedding RAG app - TiDB is overkill there.
The conversation gets interesting when they mention tens of millions of rows, multiple
tenants, or needing transactional + analytics in one place.

**SE drill question**: "A prospect says 'pgvector is good enough.' What question do you
ask to figure out if they're right?"

---

### DynamoDB

**Their strength**: true horizontal scale, managed, AWS-native, very fast key-value lookups.
Serverless pricing is predictable at scale.

**The gap - SQL and JOINs**: DynamoDB is a key-value store. Complex queries, JOINs, and
aggregations require you to model data differently or pull into a separate service. This
costs engineering time every time requirements change.

**The gap - ACID**: DynamoDB transactions are limited to 25 items per transaction within
a single account/region. Multi-table ACID across arbitrary rows does not exist. For agent
state - where an agent might debit credits, update a job status, and log an event atomically
across three tables - DynamoDB requires application-level compensation logic.

**The gap - vector search**: DynamoDB has no native vector search.

**Where DynamoDB wins**: high-throughput key-value patterns, event streams, simple session
state. When the data model is known and won't change and you don't need relational queries.

**The pivot**: if a prospect is using DynamoDB for agent state and is adding LangChain/RAG
on top of it, ask what their vector DB is. That's where consolidation becomes the story.

---

### Oracle

**Their strength**: enterprise-grade, decades of stored procedures, Oracle RAC for HA,
strong compliance tooling. Finance, healthcare, telco still run Oracle for core systems.

**The gap - cost**: Oracle licensing is extremely expensive. The typical migration trigger
is a cost audit, not a capability gap.

**The gap - modern scale**: Oracle RAC is shared-disk HA, not horizontal write scale.
Adding capacity means bigger hardware, not more nodes. It does not handle agent-scale
workloads.

**The gap - cloud-native**: Oracle cloud exists but most enterprises run Oracle on-prem
or on dedicated hardware. Moving to TiDB Cloud is a path to full managed + elastic scale.

**The migration path**: Oracle to TiDB requires attention. TiDB is MySQL-compatible, not
Oracle-compatible. PL/SQL stored procedures, Oracle-specific functions (DECODE, NVL,
CONNECT BY), sequences and synonyms all require rewriting or third-party CDC tooling
(Striim, HVR). DM only supports MySQL sources, not Oracle. Always qualify the migration
scope before quoting a timeline.

**Where to be honest**: if a prospect has deep PL/SQL logic, the migration is a multi-month
rewrite project. Don't oversell the ease. The economic case (licensing + ops cost) is
usually where the deal lives, not the technical capability.

---

## Objection responses (rapid-fire format)

**"We're already on Aurora, migration is risky."**
MySQL-compatible means most SQL runs unchanged. TiDB supports dual-write migration with
TiCDC to cut over safely. The risk is the migration project, not the database.

**"Postgres has pgvector, we don't need a separate vector DB."**
Agreed for small scale. Ask: how many tenants? How many embeddings per tenant? At agent
scale pgvector requires horizontal sharding that TiDB handles natively.

**"DynamoDB scales fine for us."**
For key-value yes. Ask: where does your relational state live? Where does your analytics
live? Where does your vector retrieval live? Three answers = three systems = the story.

**"Oracle is a sunk cost, we can't migrate."**
Understood. Where are the *new* workloads going? Agent platforms, AI features, new
services - those don't need Oracle's legacy. Start there.

**"We need it in our VPC, we can't use a cloud service."**
BYOC. TiDB managed in your AWS/GCP account. PrivateLink, your IAM, your keys.
Data never leaves your cloud account.

**"We have compliance requirements - SOC2, HIPAA, etc."**
Dedicated and BYOC both have compliance certifications. Get specifics and check the TiDB
Cloud compliance page before committing to a particular standard.

---

## SE drill (end of week)

Pick any competitor the trainee is least confident on. Say: *"A prospect just told you they
have 400 MySQL clusters and are evaluating sharding solutions. You have 90 seconds. Go."*

Grade on: accuracy of the horizontal scale pitch, correct Flipkart proof point (NOT 900
clusters - that's wrong, it's 700+), and honest qualification of the migration effort.
