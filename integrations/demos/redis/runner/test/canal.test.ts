import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { extractCacheDemoFields, parseCanalJsonMessage } from '../src/canal';

const NaiveTidbExtensionSchema = z.object({ _tidb: z.object({ commitTs: z.number() }) });

describe('parseCanalJsonMessage', () => {
  it('extracts the table, commit TSO, and row data from a captured message', () => {
    const raw = readFileSync(new URL('../../fixtures/sample-canal-json-message.json', import.meta.url), 'utf8');
    const result = parseCanalJsonMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.change.table).toBe('cache_demo_rows');
      expect(result.change.commitTs).toBe(439123456789012345n);
      expect(result.change.row.id).toBe('1');
    }
  });

  it('extracts the row id and written_at_ms for the cache_demo_rows shape', () => {
    const raw = readFileSync(new URL('../../fixtures/sample-canal-json-message.json', import.meta.url), 'utf8');
    const result = parseCanalJsonMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fields = extractCacheDemoFields(result.change.row);
      expect(fields).toEqual({ rowId: 1, writtenAtMs: 1758960000000 });
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

describe('parseCanalJsonMessage against a real captured TiCDC v8.5.8 message', () => {
  const raw = readFileSync(new URL('../../fixtures/real-canal-json-ticdc-v8.5.8.json', import.meta.url), 'utf8');

  it('extracts the commit TSO losslessly, beyond JSON number precision', () => {
    const result = parseCanalJsonMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.change.commitTs).toBe(469374060999737350n);
      expect(result.change.commitTs.toString()).toBe('469374060999737350');
    }
    const naiveParse = NaiveTidbExtensionSchema.parse(JSON.parse(raw));
    expect(String(naiveParse._tidb.commitTs)).not.toBe('469374060999737350');
  });

  it('extracts the row data for a table this demo does not define', () => {
    const result = parseCanalJsonMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.change.table).toBe('payments');
      expect(result.change.row.payment_id).toBe('payment-000001');
      expect(result.change.row.account_id).toBe('acct-1');
      expect(result.change.row.amount_cents).toBe('500');
      expect(result.change.row.currency).toBe('USD');
    }
  });

  it('does not find cache_demo_rows fields on this unrelated table', () => {
    const result = parseCanalJsonMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(extractCacheDemoFields(result.change.row)).toBeUndefined();
    }
  });
});
