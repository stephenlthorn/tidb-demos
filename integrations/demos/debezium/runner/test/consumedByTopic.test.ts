import { describe, expect, it } from 'vitest';
import { countConsumedByTopic } from '../src/consumedByTopic';
import type { EnvelopeParseResult } from '../src/debeziumEnvelope';

const pgResult: EnvelopeParseResult = {
  ok: true,
  connector: 'postgresql',
  table: 'accounts',
  op: 'c',
  after: { id: 1 },
  tsMs: 1000,
};

const tidbResult: EnvelopeParseResult = {
  ok: true,
  connector: 'TiCDC',
  table: 'accounts',
  op: 'c',
  after: { id: 2 },
  tsMs: 2000,
};

const failure: EnvelopeParseResult = { ok: false, reason: 'invalid JSON' };

describe('countConsumedByTopic', () => {
  it('counts non-TiCDC messages as pg-changes', () => {
    expect(countConsumedByTopic([pgResult, pgResult])).toEqual({ pgChanges: 2, tidbChanges: 0 });
  });

  it('counts TiCDC-labeled messages as tidb-changes', () => {
    expect(countConsumedByTopic([tidbResult])).toEqual({ pgChanges: 0, tidbChanges: 1 });
  });

  it('ignores messages that failed to parse', () => {
    expect(countConsumedByTopic([failure, pgResult, tidbResult])).toEqual({ pgChanges: 1, tidbChanges: 1 });
  });

  it('returns zero counts for no messages', () => {
    expect(countConsumedByTopic([])).toEqual({ pgChanges: 0, tidbChanges: 0 });
  });
});
