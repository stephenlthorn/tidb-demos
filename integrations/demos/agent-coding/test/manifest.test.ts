import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('agent-coding demo manifest', () => {
  it('parses against DemoManifestSchema', () => {
    expect(DemoManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('is demo number 12 with id agent-coding', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.id).toBe('agent-coding');
    expect(result.number).toBe(12);
  });

  it('names every node referenced by an edge', () => {
    const result = DemoManifestSchema.parse(manifest);
    const nodeIds = new Set(result.nodes.map((node) => node.id));
    result.edges.forEach((edge) => {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    });
  });

  it('gives every metric a howMeasured explanation', () => {
    const result = DemoManifestSchema.parse(manifest);
    result.metrics.forEach((metric) => {
      expect(metric.howMeasured.length).toBeGreaterThan(20);
    });
  });

  it('lists the nine phases in run order', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.phases.map((phase) => phase.id)).toEqual([
      'setup',
      'intake-memory-recall',
      'seed-checkpoint',
      'fan-out',
      'work-loop',
      'winner-pr',
      'replay-failed-step',
      'lake-eval',
      'write-lesson',
    ]);
  });

  it('offers the five controls', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.controls.map((control) => control.id)).toEqual([
      'fan-out',
      'inject-flaky-dependency',
      'replay-failed-step',
      'run-eval',
      'write-lesson',
    ]);
  });

  it('publishes to the hosted site', () => {
    expect(DemoManifestSchema.parse(manifest).publish).toBe(true);
  });

  it('runs the runner through node --import tsx runner/main.ts', () => {
    expect(DemoManifestSchema.parse(manifest).runner.command).toEqual(['node', '--import', 'tsx', 'runner/main.ts']);
  });

  it('says modeled where a metric uses synthetic history', () => {
    const result = DemoManifestSchema.parse(manifest);
    const evalMetric = result.metrics.find((metric) => metric.id === 'eval-query-ms');
    expect(evalMetric?.howMeasured).toContain('modeled');
  });
});
