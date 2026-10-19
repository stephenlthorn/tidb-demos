import type { PatternKind } from './domain';
import { assertSafeInteger, sqlStringLiteral } from './sqlLiteral';

export type RecallOptions = {
  readonly queryText: string;
  readonly candidateLimit?: number;
  readonly topK?: number;
};

export const RRF_CONSTANT = 60;

export const buildHybridRecallSql = (options: RecallOptions): string => {
  const candidateLimit = assertSafeInteger('candidateLimit', options.candidateLimit ?? 20);
  const topK = assertSafeInteger('topK', options.topK ?? 3);
  const query = sqlStringLiteral(options.queryText);
  return `
WITH
vec AS (
  SELECT memory_id,
         ROW_NUMBER() OVER (ORDER BY distance, memory_id) AS r
  FROM (
    SELECT /*+ READ_FROM_STORAGE(TIFLASH[episodic_memory]) */
           memory_id,
           VEC_EMBED_COSINE_DISTANCE(summary_vector, ${query}) AS distance
    FROM episodic_memory
    ORDER BY distance
    LIMIT ${candidateLimit}
  ) v
),
fts AS (
  SELECT memory_id,
         ROW_NUMBER() OVER (ORDER BY score DESC, memory_id) AS r
  FROM (
    SELECT memory_id,
           fts_match_word(${query}, summary) AS score
    FROM episodic_memory
    WHERE fts_match_word(${query}, summary)
    ORDER BY score DESC
    LIMIT ${candidateLimit}
  ) f
),
hits AS (
  SELECT memory_id, 1.0 / (${RRF_CONSTANT} + r) AS contribution, r AS vector_rank, NULL AS fulltext_rank FROM vec
  UNION ALL
  SELECT memory_id, 1.0 / (${RRF_CONSTANT} + r), NULL, r FROM fts
),
top_hits AS (
  SELECT memory_id,
         SUM(contribution) AS rrf_score,
         MAX(vector_rank) AS vector_rank,
         MAX(fulltext_rank) AS fulltext_rank
  FROM hits
  GROUP BY memory_id
  ORDER BY rrf_score DESC, memory_id
  LIMIT ${topK}
)
SELECT m.memory_id, m.case_id, m.pattern, m.outcome, m.summary,
       t.rrf_score, t.vector_rank, t.fulltext_rank
FROM top_hits t
JOIN episodic_memory m ON m.memory_id = t.memory_id
ORDER BY t.rrf_score DESC, t.memory_id
`.trim();
};

export type RecallHit = {
  readonly memoryId: number;
  readonly caseId: string;
  readonly pattern: string;
  readonly outcome: string;
  readonly summary: string;
  readonly rrfScore: number;
  readonly vectorRank: number | undefined;
  readonly fulltextRank: number | undefined;
};

const optionalNumber = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

export const recallHitFromRow = (row: Readonly<Record<string, unknown>>): RecallHit => ({
  memoryId: Number(row.memory_id),
  caseId: String(row.case_id),
  pattern: String(row.pattern),
  outcome: String(row.outcome),
  summary: String(row.summary),
  rrfScore: Number(row.rrf_score),
  vectorRank: optionalNumber(row.vector_rank),
  fulltextRank: optionalNumber(row.fulltext_rank),
});

export const patternPhrases: Readonly<Record<PatternKind, string>> = {
  structuring: 'repeated cash deposits just under the reporting threshold across several branches',
  'rapid-in-out': 'wire in then near-full wire out within hours pass-through',
  'watchlist-near-match': 'account holder name close to a watchlist entry fuzzy name match',
};

export const buildRecallQuery = (options: {
  readonly pattern: PatternKind;
  readonly accountKind: string;
  readonly distinctBranches: number;
}): string =>
  `${patternPhrases[options.pattern]} ${options.accountKind} account ${options.distinctBranches} branches`;
