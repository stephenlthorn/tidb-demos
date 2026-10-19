export const createMemoriesSql = `CREATE TABLE IF NOT EXISTS memories (
  id INT PRIMARY KEY AUTO_INCREMENT,
  kind VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  content_vector VECTOR(1024) GENERATED ALWAYS AS (
    EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", content)
  ) STORED,
  FULLTEXT INDEX ft_content (content) WITH PARSER STANDARD,
  VECTOR INDEX idx_vec ((VEC_COSINE_DISTANCE(content_vector)))
)`;

export const createLedgerSql = `CREATE TABLE IF NOT EXISTS ledger (
  run_id VARCHAR(40) NOT NULL,
  attempt_id VARCHAR(16) NOT NULL,
  step INT NOT NULL,
  checkpoint_id VARCHAR(40) NOT NULL,
  db_time VARCHAR(30) NOT NULL,
  tree_hash CHAR(64) NOT NULL,
  db_checksum VARCHAR(24) NOT NULL,
  db_rows INT NOT NULL,
  PRIMARY KEY (run_id, attempt_id, step)
)`;

export const seedMemories: readonly string[] = [
  'Retried payment requests must be idempotent: look up the idempotency key before recording a charge.',
  'A connection reset from the gateway during a verification run is infrastructure noise: rerun once before judging the patch.',
  'Keep patches small and touch only the files the failing test covers.',
  'Never edit the failing test to make it pass.',
  'Charge records are append-only: fix duplicates by preventing the second write.',
  'Review the diff before opening a pull request.',
  'Do not wrap payment authorization in a retry loop without a backoff and a retry budget.',
  'Document behaviour changes in the README when a public contract changes.',
  'Prefer a ledger helper over an inlined lookup so the check lives in one place.',
  'A pull request needs a passing test run recorded in the ledger before it is opened.',
];

export const insertMemorySql = 'INSERT INTO memories (kind, content) VALUES (?, ?)';

export const insertLedgerSql =
  'INSERT INTO ledger (run_id, attempt_id, step, checkpoint_id, db_time, tree_hash, db_checksum, db_rows) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

export const buildHybridSearch = (options: {
  readonly text: string;
  readonly limit: number;
  readonly candidates?: number;
}): { readonly sql: string; readonly params: readonly string[] } => {
  const candidates = options.candidates ?? 20;
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError('limit must be a positive integer');
  if (!Number.isInteger(candidates) || candidates < 1) throw new RangeError('candidates must be a positive integer');
  const sql = `WITH
vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY distance, id) AS r
  FROM (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[memories]) */ id, VEC_EMBED_COSINE_DISTANCE(content_vector, ?) AS distance
    FROM memories
    ORDER BY distance
    LIMIT ${candidates}
  ) v
),
fts AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY score DESC, id) AS r
  FROM (
    SELECT id, fts_match_word(?, content) AS score
    FROM memories
    WHERE fts_match_word(?, content)
    ORDER BY score DESC
    LIMIT ${candidates}
  ) f
),
hits AS (
  SELECT id, 1.0 / (60 + r) AS contribution, r AS vector_rank, NULL AS fulltext_rank FROM vec
  UNION ALL
  SELECT id, 1.0 / (60 + r), NULL, r FROM fts
),
top_hits AS (
  SELECT id, SUM(contribution) AS rrf_score, MAX(vector_rank) AS vector_rank, MAX(fulltext_rank) AS fulltext_rank
  FROM hits
  GROUP BY id
  ORDER BY rrf_score DESC, id
  LIMIT ${options.limit}
)
SELECT m.id, m.kind, m.content, t.rrf_score, t.vector_rank, t.fulltext_rank
FROM top_hits t
JOIN memories m ON m.id = t.id
ORDER BY t.rrf_score DESC, t.id`;
  return { sql, params: [options.text, options.text, options.text] };
};

export type MemoryHit = {
  readonly id: number;
  readonly kind: string;
  readonly content: string;
};

export const parseMemoryHits = (rows: readonly Readonly<Record<string, unknown>>[]): readonly MemoryHit[] =>
  rows.map((row) => ({ id: Number(row.id), kind: String(row.kind), content: String(row.content) }));
