import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

const manifestRaw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8');
const manifest = DemoManifestSchema.parse(JSON.parse(manifestRaw));
const runnerSource = readFileSync(new URL('../runner/main.ts', import.meta.url), 'utf-8');

type EmitterCategory = 'metric' | 'flow' | 'node' | 'phase' | 'check';

const idsOf = (items: readonly { readonly id: string }[]): ReadonlySet<string> =>
  new Set(items.map((item) => item.id));

const manifestIdsByCategory: Record<EmitterCategory, ReadonlySet<string>> = {
  metric: idsOf(manifest.metrics),
  flow: idsOf(manifest.edges),
  node: idsOf(manifest.nodes),
  phase: idsOf(manifest.phases),
  check: idsOf(manifest.checks),
};

const extractEmittedIds = (category: EmitterCategory): readonly string[] => {
  const pattern = new RegExp(`emitter\\.${category}\\(\\s*['"]([a-z0-9-]+)['"]`, 'g');
  return [...runnerSource.matchAll(pattern)].map((match) => match[1] ?? '');
};

const extractLogNodeIds = (): readonly string[] => {
  const pattern = /emitter\.log\(\s*['"]\w+['"]\s*,\s*[^,]+,\s*['"]([a-z0-9-]+)['"]\s*\)/g;
  return [...runnerSource.matchAll(pattern)].map((match) => match[1] ?? '');
};

describe('runner emits only ids declared in manifest.json', () => {
  (['metric', 'flow', 'node', 'phase', 'check'] satisfies EmitterCategory[]).forEach((category) => {
    it(`every emitter.${category} id used in runner/main.ts is declared in the manifest`, () => {
      const known = manifestIdsByCategory[category];
      const unknown = extractEmittedIds(category).filter((id) => !known.has(id));
      expect(unknown).toEqual([]);
    });
  });

  it('every emitter.log node id used in runner/main.ts is declared in manifest.nodes', () => {
    const known = manifestIdsByCategory.node;
    const unknown = extractLogNodeIds().filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it('the runner actually emits at least one id of every checked kind', () => {
    expect(extractEmittedIds('metric').length).toBeGreaterThan(0);
    expect(extractEmittedIds('flow').length).toBeGreaterThan(0);
    expect(extractEmittedIds('node').length).toBeGreaterThan(0);
    expect(extractEmittedIds('phase').length).toBeGreaterThan(0);
    expect(extractEmittedIds('check').length).toBeGreaterThan(0);
  });

  it('every manifest metric id is emitted somewhere in the runner', () => {
    const emitted = new Set(extractEmittedIds('metric'));
    const missing = manifest.metrics.map((metric) => metric.id).filter((id) => !emitted.has(id));
    expect(missing).toEqual([]);
  });

  it('every manifest check id is emitted somewhere in the runner', () => {
    const emitted = new Set(extractEmittedIds('check'));
    const missing = manifest.checks.map((check) => check.id).filter((id) => !emitted.has(id));
    expect(missing).toEqual([]);
  });
});
