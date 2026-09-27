import { describe, expect, it } from 'vitest';
import { buildUpsertStatement } from '../src/upsertStatement';

describe('buildUpsertStatement', () => {
  it('returns an empty statement for no rows', () => {
    expect(buildUpsertStatement([])).toEqual({ sql: '', params: [] });
  });

  it('builds one value group per row with ON DUPLICATE KEY UPDATE', () => {
    const result = buildUpsertStatement([
      { customerId: 1, score: 4.2, rule: 'velocity', updatedAtMs: Date.UTC(2026, 8, 25, 12, 0, 0) },
      { customerId: 2, score: 1.1, rule: 'velocity', updatedAtMs: Date.UTC(2026, 8, 25, 12, 0, 1) },
    ]);
    expect(result.sql).toContain('VALUES (?, ?, ?, ?), (?, ?, ?, ?)');
    expect(result.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(result.params).toEqual([
      1, 4.2, 'velocity', '2026-09-25 12:00:00.000',
      2, 1.1, 'velocity', '2026-09-25 12:00:01.000',
    ]);
  });
});
