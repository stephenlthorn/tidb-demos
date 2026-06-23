# Week 3 — AI Capability Pillars (tutor lesson)

Objective for the week: the trainee can build vector search, full-text search, and hybrid
search on their own TiDB Cloud cluster, and can explain to a customer why doing it inside one
database beats bolting on a separate vector DB.

Teach the tasks in order. One or two per sitting. Run every check yourself with `verify.py`.

---

## Task 1 — Vector search (HNSW)

**Framing to use (keep it to ~3 sentences):** An agent's memory and a RAG app both need
semantic recall. TiDB stores embeddings as a native `VECTOR` type right next to relational
data, so there is no second system to sync. The customer pain you are solving: no ETL, no sync
lag, ACID consistency between the vector and the row it describes.

**Assign:** "On your cluster, create a `docs` table with an `id`, a `content TEXT`, and an
`embedding VECTOR(3)` column (3 dims so we can hand-write vectors). Insert three rows with
small vectors you choose. Then return the row closest to `[1,0,0]` by cosine distance."

Let them write it. Hint ladder if stuck:
1. "What column type holds the embedding, and what distance function does TiDB expose?"
2. "`VEC_COSINE_DISTANCE(embedding, '[1,0,0]')` in the ORDER BY, ascending."
3. Worked fragment: `ORDER BY VEC_COSINE_DISTANCE(embedding, '[1,0,0]') LIMIT 1`.

**Check (run this):**
```
python verify.py "SELECT id, content, VEC_COSINE_DISTANCE(embedding,'[1,0,0]') AS d FROM docs ORDER BY d LIMIT 3"
```
Pass when the query returns rows ordered by ascending distance and the trainee can say which
row won and why. Then have them add an HNSW index and re-run; ask what changed and what did not
(results same, approximate-nearest-neighbor speed at scale changes; on 3 rows it will not).

**Socratic:** "We support up to 16,383 dimensions. Why would a customer care about the upper
bound, and what determines the dimension count they actually use?" (Embedding model output
size, e.g. 1536 for ada-002; bound matters for large multimodal models.)

**SE drill:** "A prospect says 'we already store vectors in Postgres with pgvector.' Two
sentences." Grade for: acknowledges pgvector is real, reframes to consolidation + ACID + scale,
does not trash Postgres.

---

## Task 2 — Full-text search (BM25)

**Framing:** Keyword relevance still matters; `LIKE '%term%'` gives you no ranking, no
tokenization, no stop words. TiDB has BM25 full-text search built in (tantivy under the hood),
running on TiFlash. Be honest: the search path is eventually consistent, seconds-level lag, so
it is for search, not for read-immediately-after-write.

**Assign:** "Add a full-text index on `docs.content`, then return rows matching a phrase,
ranked by relevance score."

Hint ladder:
1. "There is a `FULLTEXT INDEX` and a pair of functions, one to filter and one to score."
2. "`fts_match(...)` in WHERE, `fts_match_score(...)` in SELECT/ORDER BY."

**Check:**
```
python verify.py "SHOW INDEX FROM docs"
```
Confirm a FULLTEXT index exists, then run their ranked query and confirm scores are returned in
descending order.

**Socratic:** "Why can't I query a row by full-text the millisecond after I insert it?"
(TiFlash replica is async; eventually consistent on that path.)

**SE drill:** "Customer: 'why not just use Elasticsearch next to our DB?' Two sentences."
Grade for: consolidation, no second system to operate or keep in sync, honest about ES being
more specialized for pure search at extreme scale.

---

## Task 3 — Hybrid search

**Framing:** Pure vector misses exact matches; pure keyword misses meaning. Production RAG uses
both and merges them. This is the query an agent actually runs to build context.

**Assign:** "Write one query that returns a vector distance and a full-text score for the same
rows, filtered to a category if you added one. You do not need perfect RRF math; show you can
combine both signals in a single SQL statement."

**Check:** run their query; confirm both a vector measure and a text score appear per row in
one result set.

**Socratic:** "Where would you compute the final ranking, in SQL or in the app, and what is the
tradeoff?" (RRF can be done in SQL or app; SQL keeps it one round trip, app gives flexibility.)

**SE drill:** "Pitch hybrid search to a prospect building an AI agent, in two sentences."

---

## Week 3 done when

All three checks pass on the trainee's cluster, and they can, unprompted: name the three
search types, say which engine they run on (TiFlash) and the consistency caveat, and give the
consolidation pitch without overclaiming. Record a one-line note in `progress.json` on anything
shaky (most common: forgetting the eventual-consistency caveat, or trashing competitors instead
of reframing).
