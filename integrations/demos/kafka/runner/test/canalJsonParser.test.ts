import { describe, expect, it } from 'vitest';
import { parseCanalJsonMessage, tsoPhysicalMillis } from '../src/canalJsonParser';

const sampleInsert =
  '{"database":"lab","table":"payments","type":"INSERT","isDdl":false,' +
  '"data":[{"payment_id":"payment-000001","account_id":"acct-1","amount_cents":"500","currency":"USD","produce_ts":"1000"}],' +
  '"old":null,"_tidb":{"commitTs":439749918821711874}}';

describe('parseCanalJsonMessage', () => {
  it('extracts table, type, row data, and commitTs from a canal-json row event', () => {
    const parsed = parseCanalJsonMessage(sampleInsert);
    expect(parsed).toEqual({
      ok: true,
      table: 'payments',
      type: 'INSERT',
      commitTs: 439749918821711874n,
      row: { payment_id: 'payment-000001', account_id: 'acct-1', amount_cents: '500', currency: 'USD', produce_ts: '1000' },
    });
  });

  it('preserves full TSO precision even though the same digits round-trip lossily through a JS number', () => {
    const parsed = parseCanalJsonMessage(sampleInsert);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(BigInt(Number(parsed.commitTs))).not.toBe(parsed.commitTs);
      expect(parsed.commitTs.toString()).toBe('439749918821711874');
    }
  });

  it('reports DDL events as not row events without throwing', () => {
    const ddl = JSON.stringify({ database: 'lab', table: '', type: 'QUERY', isDdl: true, data: null, old: null });
    expect(parseCanalJsonMessage(ddl)).toEqual({ ok: false, reason: 'not a row event' });
  });

  it('reports malformed JSON without throwing', () => {
    expect(parseCanalJsonMessage('not json')).toEqual({ ok: false, reason: 'invalid JSON' });
  });

  it('reports a row event with no TiDB extension block as not a row event', () => {
    const noExtension = JSON.stringify({
      database: 'lab',
      table: 'payments',
      type: 'INSERT',
      isDdl: false,
      data: [{ payment_id: 'payment-000002' }],
      old: null,
    });
    expect(parseCanalJsonMessage(noExtension)).toEqual({ ok: false, reason: 'not a row event' });
  });
});

describe('tsoPhysicalMillis', () => {
  it('extracts the physical millisecond component of a TSO via tso >> 18n', () => {
    expect(tsoPhysicalMillis(439749918821711874n)).toBe(1677512812888n);
  });
});
