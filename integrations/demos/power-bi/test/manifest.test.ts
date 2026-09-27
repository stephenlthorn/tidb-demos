import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));

describe('power-bi manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const result = DemoManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('is numbered 11 and published', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const manifest = DemoManifestSchema.parse(raw);
    expect(manifest.number).toBe(11);
    expect(manifest.publish).toBe(true);
  });
});
