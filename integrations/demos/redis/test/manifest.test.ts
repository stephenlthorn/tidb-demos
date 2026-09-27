import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('redis demo manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const raw = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const result = DemoManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('is demo id redis, number 4', () => {
    const raw = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const manifest = DemoManifestSchema.parse(raw);
    expect(manifest.id).toBe('redis');
    expect(manifest.number).toBe(4);
  });
});
