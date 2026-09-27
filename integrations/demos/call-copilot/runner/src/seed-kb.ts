import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import OpenAI from 'openai';
import { createTidbPool } from '@lab/runner-kit';
import { countKbFacts } from './kb';

const SeedFactSchema = z.object({
  id: z.string(),
  category: z.enum(['product-fact', 'proof-point', 'objection-answer', 'competitive']),
  text: z.string(),
});
const SeedFactsSchema = z.array(SeedFactSchema);
export type SeedFact = z.infer<typeof SeedFactSchema>;

const loadSeedFacts = (): readonly SeedFact[] => {
  const raw = readFileSync(fileURLToPath(new URL('../../fixtures/kb-facts.json', import.meta.url)), 'utf-8');
  return SeedFactsSchema.parse(JSON.parse(raw));
};

const embed = async (openai: OpenAI, text: string): Promise<readonly number[]> => {
  const response = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (embedding === undefined) throw new Error('embeddings.create returned no data');
  return embedding;
};

export const seedKnowledgeBase = async (): Promise<number> => {
  const pool = createTidbPool();
  const openai = new OpenAI();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_facts (
      id VARCHAR(64) PRIMARY KEY,
      category VARCHAR(64),
      text TEXT,
      embedding VECTOR(1536),
      FULLTEXT INDEX (text) WITH PARSER STANDARD,
      VECTOR INDEX idx_embedding ((VEC_COSINE_DISTANCE(embedding)))
    )
  `);
  const facts = loadSeedFacts();
  for (const fact of facts) {
    const vector = await embed(openai, fact.text);
    await pool.query('REPLACE INTO kb_facts (id, category, text, embedding) VALUES (?, ?, ?, ?)', [
      fact.id,
      fact.category,
      fact.text,
      JSON.stringify(vector),
    ]);
  }
  const count = await countKbFacts(pool);
  await pool.end();
  return count;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  seedKnowledgeBase().then((count) => {
    process.stdout.write(`seeded kb_facts: ${count} rows\n`);
  });
}
