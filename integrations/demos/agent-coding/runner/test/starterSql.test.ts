import { describe, expect, it } from 'vitest';
import { buildHybridSearch, createLedgerSql, createMemoriesSql, parseMemoryHits, seedMemories } from '../src/starterSql';

describe('createMemoriesSql', () => {
  it('declares auto-embedding, a full-text index and a vector index', () => {
    expect(createMemoriesSql).toContain('EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", content)');
    expect(createMemoriesSql).toContain('FULLTEXT INDEX ft_content (content) WITH PARSER STANDARD');
    expect(createMemoriesSql).toContain('VECTOR INDEX idx_vec ((VEC_COSINE_DISTANCE(content_vector)))');
  });
});

describe('createLedgerSql', () => {
  it('keys the ledger by run, attempt and step', () => {
    expect(createLedgerSql).toContain('PRIMARY KEY (run_id, attempt_id, step)');
  });
});

describe('seedMemories', () => {
  it('has ten memories and no empty text', () => {
    expect(seedMemories).toHaveLength(10);
    expect(seedMemories.every((text) => text.length > 20)).toBe(true);
  });
});

describe('buildHybridSearch', () => {
  it('fuses a vector list and a full-text list with reciprocal rank fusion at 60', () => {
    const { sql } = buildHybridSearch({ text: 'double charge', limit: 3 });
    expect(sql).toContain('VEC_EMBED_COSINE_DISTANCE(content_vector, ?)');
    expect(sql).toContain('fts_match_word(?, content)');
    expect(sql).toContain('1.0 / (60 + r)');
    expect(sql).toContain('LIMIT 3');
  });

  it('binds the query text once per placeholder', () => {
    const { sql, params } = buildHybridSearch({ text: 'double charge', limit: 3 });
    expect(sql.match(/\?/g)).toHaveLength(3);
    expect(params).toEqual(['double charge', 'double charge', 'double charge']);
  });

  it('uses the candidate count in both lists', () => {
    const { sql } = buildHybridSearch({ text: 'x', limit: 3, candidates: 7 });
    expect(sql.match(/LIMIT 7/g)).toHaveLength(2);
  });

  it('rejects a limit that is not a positive integer', () => {
    expect(() => buildHybridSearch({ text: 'x', limit: 0 })).toThrow(RangeError);
    expect(() => buildHybridSearch({ text: 'x', limit: 1.5 })).toThrow(RangeError);
  });
});

describe('parseMemoryHits', () => {
  it('reads id, kind and content', () => {
    expect(parseMemoryHits([{ id: '4', kind: 'lesson', content: 'text', rrf_score: 0.03 }])).toEqual([
      { id: 4, kind: 'lesson', content: 'text' },
    ]);
  });
});
