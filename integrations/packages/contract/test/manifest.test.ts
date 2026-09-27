import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '../src/manifest';
import { manifestInput } from './fixtures';

const issuesOf = (input: unknown): string => {
  const result = DemoManifestSchema.safeParse(input);
  return result.success ? '' : JSON.stringify(result.error.issues);
};

describe('DemoManifestSchema', () => {
  it('accepts a valid manifest and applies defaults', () => {
    const parsed = DemoManifestSchema.parse(manifestInput());
    expect(parsed.publish).toBe(true);
    expect(parsed.runner.cwd).toBe('.');
  });

  it('rejects an edge that points at an unknown node', () => {
    const input = manifestInput({ edges: [{ id: 'bad', from: 'source', to: 'nowhere', label: 'x', unit: 'rows' }] });
    expect(issuesOf(input)).toContain('edge bad references an unknown node');
  });

  it('rejects duplicate metric ids', () => {
    const metric = { id: 'dup', label: 'A', unit: 'ms', display: 'tile', better: 'lower', howMeasured: 'timer' };
    expect(issuesOf(manifestInput({ metrics: [metric, metric] }))).toContain('duplicate metrics id: dup');
  });

  it('rejects ids that are not kebab-case', () => {
    expect(DemoManifestSchema.safeParse(manifestInput({ id: 'Not_Kebab' })).success).toBe(false);
  });

  it('rejects node coordinates outside 0-100', () => {
    const nodes = [
      { id: 'a', label: 'A', kind: 'tidb', x: 120, y: 0 },
      { id: 'b', label: 'B', kind: 'source', x: 0, y: 0 },
    ];
    expect(DemoManifestSchema.safeParse(manifestInput({ nodes, edges: [] })).success).toBe(false);
  });

  it('rejects a metric without howMeasured', () => {
    const metric = { id: 'm', label: 'M', unit: 'ms', display: 'tile', better: 'lower' };
    expect(DemoManifestSchema.safeParse(manifestInput({ metrics: [metric] })).success).toBe(false);
  });
});
