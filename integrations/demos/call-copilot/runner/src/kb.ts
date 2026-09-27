import { z } from 'zod';
import { createTidbPool, timed } from '@lab/runner-kit';
import type { Pool } from 'mysql2/promise';
import { reciprocalRankFusion } from './fusion';

export type KbFact = { readonly id: string; readonly text: string };

export type RetrievalMode = 'vector' | 'fulltext' | 'hybrid';

const IdRowsSchema = z.array(z.object({ id: z.string() }));
const KbFactRowsSchema = z.array(z.object({ id: z.string(), text: z.string() }));
const CountRowSchema = z.array(z.object({ n: z.number() }));

const vectorQuery = async (
  pool: Pool,
  embedding: readonly number[],
  limit: number,
): Promise<readonly string[]> => {
  const [rows] = await pool.query(
    'SELECT id FROM kb_facts ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT ?',
    [JSON.stringify(embedding), limit],
  );
  return IdRowsSchema.parse(rows).map((row) => row.id);
};

const fulltextQuery = async (pool: Pool, query: string, limit: number): Promise<readonly string[]> => {
  const [rows] = await pool.query(
    'SELECT id FROM kb_facts WHERE FTS_MATCH_WORD(?, text) ORDER BY FTS_MATCH_WORD(?, text) DESC LIMIT ?',
    [query, query, limit],
  );
  return IdRowsSchema.parse(rows).map((row) => row.id);
};

const fetchFactsByIds = async (pool: Pool, ids: readonly string[]): Promise<readonly KbFact[]> => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(`SELECT id, text FROM kb_facts WHERE id IN (${placeholders})`, [...ids]);
  const byId = new Map(KbFactRowsSchema.parse(rows).map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is KbFact => row !== undefined);
};

export type RetrieveResult = {
  readonly facts: readonly KbFact[];
  readonly vectorMs?: number;
  readonly fulltextMs?: number;
};

export const retrieve = async (options: {
  readonly pool: Pool;
  readonly mode: RetrievalMode;
  readonly queryText: string;
  readonly queryEmbedding: readonly number[];
  readonly topK: number;
}): Promise<RetrieveResult> => {
  if (options.mode === 'vector') {
    const { value: ids, ms } = await timed(() => vectorQuery(options.pool, options.queryEmbedding, options.topK));
    return { facts: await fetchFactsByIds(options.pool, ids), vectorMs: ms };
  }
  if (options.mode === 'fulltext') {
    const { value: ids, ms } = await timed(() => fulltextQuery(options.pool, options.queryText, options.topK));
    return { facts: await fetchFactsByIds(options.pool, ids), fulltextMs: ms };
  }
  const [vectorTimed, fulltextTimed] = await Promise.all([
    timed(() => vectorQuery(options.pool, options.queryEmbedding, 20)),
    timed(() => fulltextQuery(options.pool, options.queryText, 20)),
  ]);
  const fused = reciprocalRankFusion({
    vectorResults: vectorTimed.value,
    fulltextResults: fulltextTimed.value,
    k: 60,
  });
  const topIds = fused.slice(0, options.topK).map((row) => row.id);
  return {
    facts: await fetchFactsByIds(options.pool, topIds),
    vectorMs: vectorTimed.ms,
    fulltextMs: fulltextTimed.ms,
  };
};

export const countKbFacts = async (pool: Pool): Promise<number> => {
  const [rows] = await pool.query('SELECT COUNT(*) AS n FROM kb_facts');
  const parsed = CountRowSchema.parse(rows);
  return parsed[0]?.n ?? 0;
};

export const openKbPool = (): Pool => createTidbPool();
