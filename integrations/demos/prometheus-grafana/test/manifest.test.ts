import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('prometheus-grafana manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const result = DemoManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('declares the four fault-detection checks', () => {
    const result = DemoManifestSchema.parse(manifest);
    const checkIds = result.checks.map((check) => check.id);
    expect(checkIds).toEqual([
      'detect-slow-query-storm',
      'detect-write-hot-spot',
      'detect-store-outage',
      'detect-connection-surge',
      'resolve-all',
    ]);
  });
});
