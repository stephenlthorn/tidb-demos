import { describe, expect, it } from 'vitest';
import { buildHybridRecallSql, buildRecallQuery, recallHitFromRow } from '../src/recallSql';
import { sqlStringLiteral } from '../src/sqlLiteral';

describe('sqlStringLiteral', () => {
  it('doubles single quotes and backslashes', () => {
    expect(sqlStringLiteral("it's a\\b")).toBe("'it''s a\\\\b'");
  });
});

describe('buildHybridRecallSql', () => {
  const sql = buildHybridRecallSql({ queryText: "cash 'deposits' under threshold" });

  it('fuses a vector CTE and a full-text CTE with reciprocal rank fusion at constant 60', () => {
    expect(sql).toContain('WITH\nvec AS');
    expect(sql).toContain('fts AS');
    expect(sql).toContain('1.0 / (60 + r)');
    expect(sql).toContain('SUM(contribution) AS rrf_score');
  });

  it('embeds the query text once per search with quotes escaped', () => {
    expect(sql.split("'cash ''deposits'' under threshold'")).toHaveLength(4);
  });

  it('reads the vector side from TiFlash and uses fts_match_word on the text side', () => {
    expect(sql).toContain('READ_FROM_STORAGE(TIFLASH[episodic_memory])');
    expect(sql).toContain('VEC_EMBED_COSINE_DISTANCE(summary_vector,');
    expect(sql).toContain('fts_match_word(');
  });

  it('applies the candidate limit to both lists and the top K to the fused list', () => {
    const custom = buildHybridRecallSql({ queryText: 'x', candidateLimit: 12, topK: 5 });
    expect(custom.match(/LIMIT 12/g)).toHaveLength(2);
    expect(custom).toContain('LIMIT 5');
  });

  it('rejects non-integer limits instead of emitting broken SQL', () => {
    expect(() => buildHybridRecallSql({ queryText: 'x', topK: 1.5 })).toThrow('topK must be a safe integer');
  });
});

describe('recallHitFromRow', () => {
  it('maps database columns and keeps a missing rank undefined', () => {
    expect(
      recallHitFromRow({
        memory_id: '4',
        case_id: 'PAST-004',
        pattern: 'structuring',
        outcome: 'confirmed',
        summary: 's',
        rrf_score: '0.0328',
        vector_rank: 1,
        fulltext_rank: null,
      }),
    ).toEqual({
      memoryId: 4,
      caseId: 'PAST-004',
      pattern: 'structuring',
      outcome: 'confirmed',
      summary: 's',
      rrfScore: 0.0328,
      vectorRank: 1,
      fulltextRank: undefined,
    });
  });
});

describe('buildRecallQuery', () => {
  it('describes the pattern in the words past case summaries use', () => {
    expect(buildRecallQuery({ pattern: 'structuring', accountKind: 'retail', distinctBranches: 3 })).toBe(
      'repeated cash deposits just under the reporting threshold across several branches retail account 3 branches',
    );
  });
});
