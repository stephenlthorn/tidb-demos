import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('call-copilot manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const raw = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8'));
    const result = DemoManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});
