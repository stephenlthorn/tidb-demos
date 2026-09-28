import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

const manifest = DemoManifestSchema.parse(
  JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8')),
);
const mainSource = readFileSync(new URL('../runner/main.ts', import.meta.url), 'utf-8');

const idsUsedFor = (method: string): readonly string[] => {
  const pattern = new RegExp(`emitter\\.${method}\\(\\s*'([a-z0-9-]+)'`, 'g');
  return [...mainSource.matchAll(pattern)].map((match) => match[1] ?? '');
};

const idsComparedInOnControl = (): readonly string[] => {
  const onControlBody = /onControl\(\(id\) => \{([\s\S]*?)\n\}\);/.exec(mainSource)?.[1] ?? '';
  const pattern = /id === '([a-z0-9-]+)'/g;
  return [...onControlBody.matchAll(pattern)].map((match) => match[1] ?? '');
};

describe('every emitter id in runner/main.ts exists in manifest.json', () => {
  it('references only known metric ids', () => {
    const knownIds = new Set(manifest.metrics.map((metric) => metric.id));
    const used = idsUsedFor('metric');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(knownIds.has(id)).toBe(true));
  });

  it('references only known edge ids for flow events', () => {
    const knownIds = new Set(manifest.edges.map((edge) => edge.id));
    const used = idsUsedFor('flow');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(knownIds.has(id)).toBe(true));
  });

  it('references only known node ids', () => {
    const knownIds = new Set(manifest.nodes.map((node) => node.id));
    const used = idsUsedFor('node');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(knownIds.has(id)).toBe(true));
  });

  it('references only known phase ids', () => {
    const knownIds = new Set(manifest.phases.map((phase) => phase.id));
    const used = idsUsedFor('phase');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(knownIds.has(id)).toBe(true));
  });

  it('references only known check ids', () => {
    const knownIds = new Set(manifest.checks.map((check) => check.id));
    const used = idsUsedFor('check');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(knownIds.has(id)).toBe(true));
  });

  it('handles only known control ids in the onControl handler', () => {
    const knownIds = new Set(manifest.controls.map((control) => control.id));
    const used = idsComparedInOnControl();
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(knownIds.has(id)).toBe(true));
  });

  it('handles every control declared in the manifest', () => {
    const used = new Set(idsComparedInOnControl());
    manifest.controls.forEach((control) => expect(used.has(control.id)).toBe(true));
  });
});
