import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('terraform-eks manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');
    const result = DemoManifestSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it('declares the six diagram nodes', () => {
    const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');
    const manifest = DemoManifestSchema.parse(JSON.parse(raw));
    const nodeIds = manifest.nodes.map((node) => node.id);
    expect(nodeIds).toEqual([
      'terraform-cli',
      'aws-vpc',
      'eks-cluster',
      'app-deployment',
      'tidb-cluster',
      'private-endpoint',
    ]);
  });
});
