import { describe, expect, it } from 'vitest';
import { CatalogSchema, TraceSchema } from '../src/index';
import { manifestInput } from './fixtures';

const traceInput = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  schemaVersion: 1,
  manifest: manifestInput(),
  recordedAt: '2026-09-25T15:00:00.000Z',
  environment: { tidb: 'tiup playground (local)', components: { kafka: 'apache/kafka 4.1.0' }, notes: '' },
  durationMs: 1000,
  events: [{ type: 'phase', t: 0, phase: 'warmup' }],
  ...overrides,
});

describe('TraceSchema', () => {
  it('accepts a valid trace', () => {
    expect(TraceSchema.safeParse(traceInput()).success).toBe(true);
  });

  it('rejects a recordedAt that is not an ISO datetime', () => {
    expect(TraceSchema.safeParse(traceInput({ recordedAt: 'yesterday' })).success).toBe(false);
  });

  it('rejects an unknown schema version', () => {
    expect(TraceSchema.safeParse(traceInput({ schemaVersion: 2 })).success).toBe(false);
  });
});

describe('CatalogSchema', () => {
  it('accepts catalog entries', () => {
    const entry = { id: 'kafka', number: 2, title: 'Kafka', tagline: 't', integrations: ['Kafka'], hasReplay: false };
    expect(CatalogSchema.safeParse([entry]).success).toBe(true);
  });
});
