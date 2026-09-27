import { describe, expect, it } from 'vitest';
import { parseDebeziumEnvelope } from '../src/debeziumEnvelope';

const realDebeziumInsert = JSON.stringify({
  payload: {
    before: null,
    after: { id: 1, name: 'acct-1', risk_tier: null },
    source: { connector: 'postgresql', db: 'lab', table: 'accounts', ts_ms: 1000 },
    op: 'c',
    ts_ms: 1005,
  },
});

const ticdcDebeziumInsert = JSON.stringify({
  payload: {
    before: null,
    after: { id: 1, name: 'acct-1' },
    source: { connector: 'TiCDC', db: 'lab', table: 'accounts', ts_ms: 2000 },
    op: 'c',
    ts_ms: 2005,
    CommitTs: 439749918821711874,
    ClusterID: 'cluster-1',
  },
});

describe('parseDebeziumEnvelope', () => {
  it('parses a real Debezium message', () => {
    const parsed = parseDebeziumEnvelope(realDebeziumInsert);
    expect(parsed).toEqual({
      ok: true,
      connector: 'postgresql',
      table: 'accounts',
      op: 'c',
      after: { id: 1, name: 'acct-1', risk_tier: null },
      tsMs: 1005,
    });
  });

  it('parses a TiCDC-shaped Debezium message the same way', () => {
    const parsed = parseDebeziumEnvelope(ticdcDebeziumInsert);
    expect(parsed).toEqual({
      ok: true,
      connector: 'TiCDC',
      table: 'accounts',
      op: 'c',
      after: { id: 1, name: 'acct-1' },
      tsMs: 2005,
    });
  });

  it('reports malformed JSON without throwing', () => {
    expect(parseDebeziumEnvelope('not json')).toEqual({ ok: false, reason: 'invalid JSON' });
  });

  it('reports a message missing payload.source without throwing', () => {
    expect(parseDebeziumEnvelope(JSON.stringify({ payload: {} }))).toEqual({ ok: false, reason: 'missing envelope fields' });
  });
});
