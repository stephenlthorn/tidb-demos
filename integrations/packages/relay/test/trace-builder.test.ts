import { describe, expect, it } from 'vitest';
import { TraceSchema } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { buildTrace, traceFileName } from '../src/trace-builder';

const recordedAt = new Date('2026-09-25T15:00:00.000Z');

describe('buildTrace', () => {
  it('sorts events, computes duration and maps LAB_ENV variables', () => {
    const trace = buildTrace({
      manifest: aManifest(),
      events: [
        { type: 'metric', t: 2000, id: 'ingest-rate', value: 5 },
        { type: 'phase', t: 0, phase: 'warmup' },
      ],
      recordedAt,
      env: { LAB_ENV_TIDB: 'tiup playground', LAB_ENV_NOTES: 'laptop', LAB_ENV_COMPONENT_KAFKA: 'apache/kafka 4.1.0', OTHER: 'x' },
    });
    expect(TraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.events.map((event) => event.t)).toEqual([0, 2000]);
    expect(trace.durationMs).toBe(2000);
    expect(trace.environment).toEqual({ tidb: 'tiup playground', components: { kafka: 'apache/kafka 4.1.0' }, notes: 'laptop' });
  });

  it('marks an unspecified environment honestly', () => {
    expect(buildTrace({ manifest: aManifest(), events: [], recordedAt, env: {} }).environment.tidb).toBe('unspecified');
  });
});

describe('traceFileName', () => {
  it('is filesystem safe', () => {
    expect(traceFileName(recordedAt)).toBe('2026-09-25T15-00-00-000Z.json');
  });
});
