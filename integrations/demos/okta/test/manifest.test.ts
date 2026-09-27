import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

describe('okta manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const result = DemoManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});
