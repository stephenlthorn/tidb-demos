import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('kafka demo manifest', () => {
  it('parses as a valid DemoManifest', () => {
    const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8');
    const result = DemoManifestSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });
});
