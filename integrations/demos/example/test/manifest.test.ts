import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

const raw: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

describe('example manifest', () => {
  it('satisfies the contract', () => {
    expect(DemoManifestSchema.safeParse(raw).success).toBe(true);
  });

  it('is never published', () => {
    expect(DemoManifestSchema.parse(raw).publish).toBe(false);
  });
});
