import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import OpenAI from 'openai';
import { openKbPool, retrieve } from '../../src/kb';
import { formatEvalObserved, scoreHybridEval } from '../../src/eval-scoring';

const EvalRowSchema = z.object({ triggerText: z.string(), expectedFactId: z.string() });
const evalRows = z
  .array(EvalRowSchema)
  .parse(JSON.parse(readFileSync(fileURLToPath(new URL('./triggers.json', import.meta.url)), 'utf-8')));

const runIfConfigured = process.env.TIDB_HOST !== undefined ? describe : describe.skip;

runIfConfigured('hybrid retrieval eval set (live TiDB)', () => {
  it('returns the expected fact first for every scripted trigger', async () => {
    const pool = openKbPool();
    const openai = new OpenAI();
    const topFactIdForTrigger = new Map<string, string | undefined>();
    for (const row of evalRows) {
      const embeddingResponse = await openai.embeddings.create({
        model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
        input: row.triggerText,
      });
      const queryEmbedding = embeddingResponse.data[0]?.embedding ?? [];
      const result = await retrieve({
        pool,
        mode: 'hybrid',
        queryText: row.triggerText,
        queryEmbedding,
        topK: 1,
      });
      topFactIdForTrigger.set(row.triggerText, result.facts[0]?.id);
    }
    await pool.end();
    const score = scoreHybridEval({ rows: evalRows, topFactIdForTrigger });
    expect(score.matched, formatEvalObserved(score)).toBe(score.total);
  });
});
