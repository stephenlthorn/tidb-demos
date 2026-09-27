import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DemoManifestSchema } from '@lab/contract';

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));

describe('chalk demo manifest', () => {
  it('parses as a valid DemoManifest', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const result = DemoManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('has exactly the four checks and controls this plan documents', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const manifest = DemoManifestSchema.parse(raw);
    expect(manifest.checks.map((c) => c.id).sort()).toEqual(['feature-parity', 'fraud-flip']);
    expect(manifest.controls.map((c) => c.id).sort()).toEqual([
      'burst-writes',
      'tighten-staleness',
      'velocity-burst',
    ]);
  });
});
