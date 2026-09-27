import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('datadog manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const result = DemoManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('declares the correlation check alongside the four fault checks', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.checks.map((check) => check.id)).toEqual([
      'detect-slow-query-storm',
      'detect-write-hot-spot',
      'detect-store-outage',
      'detect-connection-surge',
      'slow-span-correlated',
    ]);
  });
});
