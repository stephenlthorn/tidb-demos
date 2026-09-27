import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('databricks demo manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const result = DemoManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('is demo number 6 with id databricks', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.id).toBe('databricks');
    expect(result.number).toBe(6);
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
      expect(metric.howMeasured.length).toBeGreaterThan(0);
    });
  });

  it('publishes to the hosted site', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.publish).toBe(true);
  });

  it('runs the runner through node --import tsx runner/main.ts', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.runner.command).toEqual(['node', '--import', 'tsx', 'runner/main.ts']);
  });
});
