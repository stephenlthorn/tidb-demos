import { describe, expect, it } from 'vitest';
import type { DemoEvent, Trace } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { validateTrace } from '../src/validate';

const traceWith = (events: readonly DemoEvent[], manifest = aManifest()): Trace => ({
  schemaVersion: 1,
  manifest,
  recordedAt: '2026-09-25T15:00:00.000Z',
  environment: { tidb: 'tiup playground', components: {}, notes: '' },
  durationMs: 1000,
  events: [...events],
});

describe('validateTrace', () => {
  it('accepts a clean trace', () => {
    const report = validateTrace(aManifest(), traceWith([{ type: 'phase', t: 0, phase: 'warmup' }]));
    expect(report).toEqual({ errors: [], warnings: [], eventCount: 1 });
  });

  it('reports unknown references, ordering and a missing phase', () => {
    const report = validateTrace(aManifest(), traceWith([
      { type: 'metric', t: 50, id: 'ghost', value: 1 },
      { type: 'flow', t: 10, edge: 'source-to-tidb', count: 1 },
    ]));
    expect(report.errors).toEqual(['event 0: unknown metric: ghost', 'events are not sorted by t', 'trace has no phase events']);
  });

  it('warns when the manifest changed after recording', () => {
    const report = validateTrace(aManifest({ title: 'Renamed' }), traceWith([{ type: 'phase', t: 0, phase: 'warmup' }]));
    expect(report.warnings).toEqual(['manifest changed since this trace was recorded; re-record before publishing']);
  });

  it('rejects a trace recorded for another demo', () => {
    const report = validateTrace(aManifest(), traceWith([{ type: 'phase', t: 0, phase: 'warmup' }], aManifest({ id: 'kafka' })));
    expect(report.errors[0]).toBe('trace belongs to kafka, not example');
  });
});
