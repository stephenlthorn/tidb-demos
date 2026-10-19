import { describe, expect, it } from 'vitest';
import { resetStatements, schemaStatements } from '../src/schema';

describe('schemaStatements', () => {
  it('creates every table idempotently', () => {
    expect(schemaStatements).toHaveLength(9);
    schemaStatements.forEach((sql) => expect(sql.startsWith('CREATE TABLE IF NOT EXISTS')).toBe(true));
  });

  it('gives episodic memory auto-embedding, a full-text index and a vector index', () => {
    const memory = schemaStatements.find((sql) => sql.includes('episodic_memory')) ?? '';
    expect(memory).toContain('VECTOR(1024)');
    expect(memory).toContain('EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", summary)');
    expect(memory).toContain('FULLTEXT INDEX ft_summary (summary) WITH PARSER STANDARD');
    expect(memory).toContain('VECTOR INDEX idx_summary_vec ((VEC_COSINE_DISTANCE(summary_vector)))');
  });

  it('keeps alerts unique per rule version, account and week so replays are idempotent', () => {
    const alerts = schemaStatements.find((sql) => sql.includes('TABLE IF NOT EXISTS alerts')) ?? '';
    expect(alerts).toContain('UNIQUE KEY uq_alert (rule_id, rule_version, account_id, bucket)');
  });

  it('indexes the watchlist name for fts_match_word', () => {
    const watchlist = schemaStatements.find((sql) => sql.includes('TABLE IF NOT EXISTS watchlist')) ?? '';
    expect(watchlist).toContain('FULLTEXT INDEX ft_full_name (full_name) WITH PARSER STANDARD');
  });

  it('truncates one table per reset statement', () => {
    expect(resetStatements).toHaveLength(9);
    resetStatements.forEach((sql) => expect(sql.startsWith('TRUNCATE TABLE ')).toBe(true));
  });
});
