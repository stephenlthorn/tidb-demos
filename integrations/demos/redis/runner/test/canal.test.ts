import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCanalJsonMessage } from '../src/canal';

describe('parseCanalJsonMessage', () => {
  it('extracts the row id, table, and written_at_ms from a captured message', () => {
    const raw = readFileSync(new URL('../../fixtures/sample-canal-json-message.json', import.meta.url), 'utf8');
    const result = parseCanalJsonMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.change.table).toBe('cache_demo_rows');
      expect(result.change.rowId).toBe(1);
      expect(typeof result.change.writtenAtMs).toBe('number');
    }
  });

  it('reports an error for a line that is not JSON', () => {
    const result = parseCanalJsonMessage('not json');
    expect(result.ok).toBe(false);
  });

  it('reports an error for a message missing a data array', () => {
    const result = parseCanalJsonMessage(JSON.stringify({ database: 'lab', table: 'cache_demo_rows', type: 'INSERT' }));
    expect(result.ok).toBe(false);
  });
});
