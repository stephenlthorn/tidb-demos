# TiDB Technical Knowledge Base

This file is the tutor's authoritative technical reference. Read it before every session.
It covers architecture, AI features, the sys9 stack, RU economics, competitive positioning,
and the troubleshooting playbook. Everything in here is what the SE will repeat to customers —
accuracy is the only metric that matters.

---

## Verified proof points (do not substitute other numbers)

- **Manus**: 1.4M+ databases, billions of events/day, 100% created by agents, 80% infra cost
  reduction. Migrated to production in ~2 weeks. The correct figure is 1.4M — not ten million.
- **Pinterest**: 6 systems → 1 TiDB Cloud, 1.3M+ QPS, 3-5x p99 improvement, 80% cost reduction.
- **Dify.AI**: 500K+ containers → 1 system, 90% ops reduction.
- **Flipkart**: 700+ MySQL clusters → 1, 1M+ QPS, P95 <5ms.

---

## The paradigm: every user is an agent

95% of new TiDB Cloud clusters are now created by AI agents, not humans. The database needs
to be good at four things simultaneously: relational OLTP (ACID, horizontal scale), real-time
OLAP (TiFlash, no ETL), vector search (semantic recall for agent memory), and full-text search
(keyword relevance). TiDB is the only MySQL-compatible engine that does all four in one system.

---

## Architecture: compute-storage separation

```
              ┌──────────────────────────────┐
              │    TiDB Server (SQL layer)    │  stateless, scales independently
              │   parse → plan → execute      │
              └──────────┬───────────────────┘
                         │ Raft + 2PC
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     ┌─────────┐   ┌─────────┐   ┌──────────────┐
     │  TiKV   │   │  TiKV   │   │   TiFlash    │
     │ (row,   │   │ (row,   │   │  (columnar,  │
     │  Raft)  │   │  Raft)  │   │  Raft Learner│
     └─────────┘   └─────────┘   └──────────────┘
          │                             │
     OLTP point reads/writes      OLAP + vector search
                                  + full-text search (BM25)
```

**TiDB Server** — Stateless SQL layer (Go). Parse, plan, execute. Scale independently of storage.

**TiKV** — Distributed KV, RocksDB + Raft. Data in Regions (~96MB each). Each Region has
a leader and 2 follower replicas across TiKV nodes. This is where OLTP lives.

**PD (Placement Driver)** — Cluster brain. Allocates TSO (globally monotonic timestamps for
MVCC), stores metadata, drives scheduling. Every transaction needs a TSO — slow PD = slow everything.

**TiFlash** — Columnar async replica of TiKV (Raft Learner). The optimizer routes between
TiKV and TiFlash automatically at query time. Two things run on TiFlash beyond OLAP:
  - **Vector search** (HNSW, up to 16,383 dims) — approximate nearest neighbor
  - **Full-text search** (BM25, tantivy) — ranked keyword search

**Critical accuracy point**: both vector and full-text search run on TiFlash as a Raft Learner
replica. They are **eventually consistent** — seconds-level lag behind writes. This is fine for
search; it is NOT suitable for "write then immediately search that write."
Do not attribute these to a separate "TiCI" component in customer conversations.

---

## TiDB Cloud (TiDB X) — the product

TiDB X: object storage (S3) as source of truth, compute decoupled from storage, background
tasks isolated from query traffic. Enables 5-10x faster scaling than previous architecture.

### Tiers

| Tier | Model | Use case |
|------|-------|----------|
| Starter | Serverless, pay-per-RU, scales to zero. **Multi-tenant.** | Dev, POCs, agent workloads starting out |
| Essential | Provisioned + autoscaling | Growing apps, consistent performance |
| Premium | Workload-aware auto-scaling | Mission-critical, unlimited scale |
| Dedicated | Fixed node counts, full control. Isolated VPC/VMs/k8s/storage. | Serious production, HTAP, large-scale |
| BYOC | TiDB **data plane** in customer's own cloud account | Regulated industries (fintech, healthcare) |

**Do not quote this table as current.** Tier names, positioning, and preview status change, and
Essential and Premium have been in public preview. Pull the live lineup from
`docs.pingcap.com/tidbcloud/tidb-cloud-intro/` before naming a tier to a customer.

### Control plane vs data plane

- **Control plane** (Central Services, deployed independently, reachable over the internet):
  console/dashboard UI, billing and metering, alerting, metadata about which clusters exist.
- **Data plane** (per resource, all in the same VPC): TiDB, TiKV, and TiFlash nodes plus
  auxiliary nodes (TiDB Operator, logging). This is where customer data lives.
- **BYOC relocates the data plane into the customer's cloud account. The control plane stays with
  PingCAP.** This is the most commonly botched point in customer conversations.
- **Encryption at rest is dual-layer**: the cloud provider's storage encryption plus a TiDB Cloud
  layer using either CMEK (customer-managed keys) or escrow keys that TiDB Cloud manages.
  Dedicated always uses dual-layer. Per-tier defaults change - verify at
  `docs.pingcap.com/tidbcloud/security-concepts/`.
- **Network isolation options**: IP access list, VPC peering, private endpoints (AWS PrivateLink,
  Azure Private Link, Google Cloud Private Service Connect, Alibaba Cloud).

Full teaching material: `lessons/week-02-planes-and-tiers.md`.

**BYOC specifics**: PrivateLink, 13 static IAM roles, ~3-4 hour initial deploy.
Data never leaves the customer's cloud account. Biggest SE closer for regulated deals.

**TiDB Cloud Zero**: zero-config auto-provisioning. An agent or app calls an API and gets an
isolated database branch in milliseconds. This is how Manus runs 1.4M+ databases — each user
workspace is a branch, copy-on-write, created in ms, costs nothing idle.

---

## Request Units (RUs) — the cloud currency

On Starter and Essential, all consumption is metered in RUs: a composite of read bytes
+ write bytes + SQL CPU time. Optimizing RUs = optimizing performance AND cost simultaneously.

**Three levers**:
1. Reduce data scanned — better indexes, covering indexes
2. Reduce writes — batch sizing
3. Reduce CPU — simpler plans, push computation to TiKV/TiFlash coprocessor

**Where to look**: SQL Statements page under Diagnosis, or `EXPLAIN ANALYZE` on individual
queries. Use `ru_collector.py` in this repo to surface top RU consumers from the live cluster.

**SE framing**: "On TiDB Cloud Starter, a slow query and an expensive query are the same
query. Tuning performance automatically reduces cost. You get both levers with one fix."

---

## AI features in detail

### Vector search

```sql
CREATE TABLE docs (
  id   BIGINT AUTO_RANDOM PRIMARY KEY,
  content TEXT,
  embedding VECTOR(1536)            -- OpenAI ada-002 is 1536 dims
);

-- Cosine distance, L2 distance, and inner product all supported
SELECT id, content,
  VEC_COSINE_DISTANCE(embedding, '[0.1, 0.2, ...]') AS dist
FROM docs
ORDER BY dist
LIMIT 10;

-- Add HNSW index for ANN at scale
ALTER TABLE docs ADD INDEX idx_vec((VEC_COSINE_DISTANCE(embedding)));
```

HNSW = approximate nearest neighbor. On small datasets the index has no visible effect;
the SE drill question is "what changes at 10 million rows?"

### Auto-embedding

TiDB Cloud can generate embeddings server-side using integrated models (OpenAI, Cohere, Jina).
No external preprocessing pipeline. Data goes in as text; vector comes out automatically.
The selling point: no API key in application code, no separate embedding service to manage.

### Full-text search (BM25)

```sql
-- Create a full-text index
CREATE FULLTEXT INDEX idx_ft ON docs(content);

-- Query with relevance ranking
SELECT id, content,
  fts_match_score('idx_ft', 'agent memory') AS score
FROM docs
WHERE fts_match('idx_ft', 'agent memory')
ORDER BY score DESC
LIMIT 10;
```

Always pair with the consistency caveat: FTS runs on TiFlash (Raft Learner = eventually
consistent). If a trainee forgets this, correct them before it leaks into a customer call.

### Hybrid search

```sql
SELECT id, content,
  VEC_COSINE_DISTANCE(embedding, '[...]')       AS vec_dist,
  fts_match_score('idx_ft', 'agent memory')     AS fts_score
FROM docs
WHERE fts_match('idx_ft', 'agent memory')
ORDER BY (0.7 * vec_dist + 0.3 * fts_score)
LIMIT 10;
```

RRF (Reciprocal Rank Fusion) can be computed in SQL or in the application layer.
In-SQL = one round-trip. App-side = more flexibility for re-ranking.

---

## The sys9 stack (agent-native on TiDB Cloud)

sys9.ai is PingCAP's "agent-native toolbox." Three products, all on TiDB Cloud:

**mem9** (mem9.ai, github.com/mem9-ai/mem9)
- Cognitive memory for agents: session traces, extracted insights, pinned memories
- Hybrid recall: vector + keyword merged with RRF
- Server-side auto-embedding — no OpenAI key in app code
- Stateless plugins — all state in `mnemo-server` (Go), agents stay disposable
- Integrates: Claude Code, OpenClaw, OpenCode, Codex, Cursor, Dify
- Backends: `tidb` (default, TiDB Cloud Zero auto-provisioning), `postgres`, `db9`
- Multi-tenant: each team/project gets its own memory pool via tenant ID

**drive9**
- Workspace memory: files, revisions, extracted text, provenance, task state
- Complements mem9: mem9 = "what the agent has learned"; drive9 = "what the agent can reopen"

**db9** (db9.ai)
- Serverless Postgres for agents (Postgres-wire protocol)
- Native `embedding()` function, vector search, environment branching, file storage, cron
- **Important accuracy note**: db9 is Postgres-wire, NOT TiDB's MySQL-wire engine.
  Do not claim "db9 is TiDB" without verification. The relationship is that it runs
  on TiDB Cloud infrastructure, but the protocol and positioning are Postgres.

**Sales framing**: "A context window is a transport mechanism, not a memory strategy. It
carries information into one model call but cannot decide what to persist, update, expire, or
delete. mem9 and drive9 make memory runtime infrastructure — the same way you would not put
your application state in a local variable."

---

## HTAP: TiKV + TiFlash, no ETL

The consolidation pitch. Aurora + Redshift = two systems, 15-30 min ETL lag.
TiDB = one system, TiFlash replication lag <1 second typically.

```sql
-- Force OLAP to TiFlash (optimizer usually routes automatically)
SELECT /*+ READ_FROM_STORAGE(TIFLASH[orders]) */
  region, COUNT(*), SUM(amount)
FROM orders
GROUP BY region;

-- Check that TiFlash replica is syncing
SELECT TABLE_NAME, REPLICA_COUNT, AVAILABLE, PROGRESS
FROM INFORMATION_SCHEMA.TIFLASH_REPLICA
WHERE TABLE_SCHEMA = DATABASE();
```

---

## Distributed systems internals (for credibility)

**CAP**: TiDB is CP. Raft = strong consistency. During a network partition, unavailable
regions block rather than serve stale data. Be direct about this tradeoff.

**Raft**: every write — leader proposes → majority acks → commit. Write latency has a floor
set by the round-trip to the slowest majority replica. Geography matters.

**MVCC + TSO**: each transaction sees a consistent snapshot via a PD-allocated timestamp.
No locks for reads. Isolation is snapshot-level by default.

**2PC (Percolator-style)**: distributed transactions touch multiple regions, lock them, get
a commit timestamp, commit. More regions spanned = more 2PC overhead. Wide cross-region
transactions are visibly more expensive.

**Region as the unit of everything**: replication, scheduling, load balancing. Hot data =
hot region. Sequential AUTO_INCREMENT PKs create write hotspots — always use AUTO_RANDOM on
high-write tables. This is the #1 migration gotcha from single-node MySQL.

**Hot regions**: PD detects via the hot-region scheduler and rebalances. Check Key Visualizer
in TiDB Cloud dashboard — a bright stripe = hot region.

**Online DDL**: asynchronous schema change through intermediate states,
`none` → `delete only` → `write only` → `write/delete reorganization` → `public`. Inspect with
`ADMIN SHOW DDL JOBS`; `STATE` of `synced` means propagated to all instances, `done` means executed
on the owner node only. DML keeps working throughout.

**Metadata lock** (`tidb_enable_metadata_lock`, added v6.3.0, default on from v6.5.0): coordinates
DML/DDL priority during a metadata change by making **DDL wait for transactions holding old
metadata to commit**. Guarantees metadata versions in use differ by at most one version. Without
it, transactions spanning a DDL fail with `Information schema is changed`. **It does not block
DML** - trainees get this backwards constantly. Caveat to disclose: a pathologically long
transaction can delay a schema change.

**Table locks** (`LOCK TABLES` / `UNLOCK TABLES`): gated by the `enable-table-lock` **config file**
parameter, **disabled by default**, and **experimental - not recommended for production**. Not
settable from SQL, so unavailable on managed tiers. Differs from MySQL: other sessions' writes
error immediately instead of blocking, `LOCK TABLES` errors rather than waiting, it works
cluster-wide, and `BEGIN` does not implicitly release held locks. Cannot lock tables in
`INFORMATION_SCHEMA`, `PERFORMANCE_SCHEMA`, `METRICS_SCHEMA`, or `mysql`. `READ LOCAL` is syntax
compatibility only and unsupported.

**DDL through TiCDC**: allow-list based; non-listed DDLs are ignored. A DDL dropping the **last
valid index** (`DROP INDEX`, `DROP PRIMARY KEY`) is not replicated **and subsequent replication
fails**. `RENAME TABLE` swapping two names in one statement is unsupported, and a rename that
crosses the changefeed filter boundary errors and exits replication. With a TiDB downstream,
create/add index DDLs run asynchronously and can leave later DDLs queued.

Full teaching material: `lessons/week-06-ddl-dml-cdc.md`.

---

## Competitive matrix

| Capability | TiDB Cloud | pgvector | Pinecone | CockroachDB/Yugabyte |
|---|---|---|---|---|
| MySQL compatible | YES | NO | NO | NO |
| HTAP (native columnar) | YES | NO | NO | NO |
| Vector search | YES | YES | YES | NO |
| Full-text / BM25 | YES | partial | NO | NO |
| ACID distributed | YES | YES | NO | YES |
| Horizontal scale | YES | NO | YES | YES |
| Multi-tenancy (millions) | YES | NO | partial | NO |

**Positioning correction - read before any competitive conversation.** The line "the only
MySQL-compatible database that does OLTP, OLAP, vector, and full-text behind one ACID boundary" is
**not safe**. SingleStore is MySQL wire-compatible with rowstore + columnstore (Universal Storage),
vector search (IVF/HNSW/PQ), and full-text search - it matches every clause. Spanner now has vector
search (ScaNN), full-text search, and a columnar engine, though it is not MySQL compatible. Use the
defensible version instead:

> "TiDB brings OLTP, real-time analytics, vector, and full-text search behind one ACID boundary, on
> the MySQL wire protocol, as open source you can also run yourself."

The differentiators that survive against SingleStore, Spanner, and Snowflake are **MySQL wire +
Apache 2.0 open source + self-hostable + agent-scale multi-tenancy (Cloud Zero)**, not the
capability checklist. Full treatment: `lessons/week-07-competitive-part2.md`.

**Key objection responses**:
- **"We use pgvector"**: pgvector does not scale horizontally. At agent scale (millions of
  tenants, billions of embeddings) you shard or you rewrite. TiDB handles that natively.
- **"Pinecone is our vector DB"**: Pinecone is vectors only — no SQL, no transactions.
  Consolidation eliminates the ETL between your relational DB and your vector DB.
- **"We use Aurora"**: Aurora cannot serve real-time OLAP without a separate Redshift pipeline.
  No native vector search. Sharding is manual. These are fine tradeoffs until they aren't.
- **"CockroachDB / Yugabyte"**: Neither has a native columnar store (no HTAP). Strong
  distributed OLTP, but you still need a separate analytics and search stack.
- **"We need it in our VPC"**: BYOC. TiDB managed infrastructure in your AWS/GCP account,
  PrivateLink, your IAM, your keys.

---

## Performance tuning quick reference

**Stats**: stale stats = bad plans. `SHOW STATS_HEALTHY` — below 80% run `ANALYZE TABLE`.

**EXPLAIN ANALYZE**: actual vs estimated rows. Large discrepancy = stats problem.
`cop_task` = TiKV coprocessor work (good — pushed down). `tiflash_task` = TiFlash.

**Covering indexes**: in a distributed system, a post-index table lookup crosses nodes.
Include SELECT columns in the index to avoid it.

**SQL bindings**: `CREATE BINDING FOR SELECT ... USING SELECT /*+ hint */ ...` locks a query
to a specific plan. More stable than hints alone across plan cache evictions.

**Connection pooling**: TiDB Cloud has connection limits. New connections carry TLS + session
init overhead. Use a pool (HikariCP, pgbouncer pattern, or the serverless HTTP driver for edge
runtimes like Cloudflare Workers).

---

## Ecosystem / SDKs

- **pytidb** — Python, first-class vector + FTS. Preferred for Python AI stacks.
- **@tidbcloud/serverless** — HTTP driver, no TCP, for edge (Vercel, Cloudflare Workers).
- **LangChain / LlamaIndex** — TiDB Cloud is a supported vector store backend in both.
- **MCP server** — TiDB Cloud MCP for Claude and Cursor. See github.com/pingcap/agent-rules.
- **agent-rules** — library of Claude Code / agent skills: `tidbx`, `pytidb`, `tidb-sql`,
  `tidb-query-tuning`, `tidbx-serverless-driver`, `tidbx-prisma`, `tidb-cloud-zero`, etc.

---

## Troubleshooting playbook

1. **Which query?** Slow Query Log or SQL Statements under Diagnosis.
2. **EXPLAIN ANALYZE** — actual vs estimated rows, cop_task duration, memory use.
3. **Hotspots** — Key Visualizer in TiDB Cloud. Bright stripe = hot region.
4. **Stats health** — SHOW STATS_HEALTHY. <80% → ANALYZE TABLE.
5. **Locks** — INFORMATION_SCHEMA.DATA_LOCK_WAITS, DEADLOCKS.
6. For agent workloads: check resource group RU cap, branch replication lag, AUTO_RANDOM usage.
