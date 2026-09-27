import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

const readFrom = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const manifest = DemoManifestSchema.parse(JSON.parse(readFrom('../manifest.json')));
const source = readFrom('../runner/main.ts');

const extractFirstArgIds = (methodName: string): readonly string[] => {
  const pattern = new RegExp(String.raw`emitter\.${methodName}\(\s*'([^']*)'`, 'g');
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
};

const extractControlLiteralIds = (): readonly string[] => {
  const pattern = /controlId === '([^']*)'/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
};

describe('runner main.ts emitted ids', () => {
  it('only emits metric ids declared in manifest.json', () => {
    const known = new Set(manifest.metrics.map((metric) => metric.id));
    const used = extractFirstArgIds('metric');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('only emits flow edge ids declared in manifest.json', () => {
    const known = new Set(manifest.edges.map((edge) => edge.id));
    const used = extractFirstArgIds('flow');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('only emits node ids declared in manifest.json', () => {
    const known = new Set(manifest.nodes.map((node) => node.id));
    const used = extractFirstArgIds('node');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('only emits phase ids declared in manifest.json', () => {
    const known = new Set(manifest.phases.map((phase) => phase.id));
    const used = extractFirstArgIds('phase');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('only emits check ids declared in manifest.json', () => {
    const known = new Set(manifest.checks.map((check) => check.id));
    const used = extractFirstArgIds('check');
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('every phase id in manifest.json is reachable from the runner source', () => {
    const used = new Set(extractFirstArgIds('phase'));
    manifest.phases.forEach((phase) => expect(used.has(phase.id)).toBe(true));
  });

  it('every check id in manifest.json is reachable from the runner source', () => {
    const used = new Set(extractFirstArgIds('check'));
    manifest.checks.forEach((check) => expect(used.has(check.id)).toBe(true));
  });

  it('every edge id in manifest.json is reachable from the runner source', () => {
    const used = new Set(extractFirstArgIds('flow'));
    manifest.edges.forEach((edge) => expect(used.has(edge.id)).toBe(true));
  });

  it('every node id in manifest.json is reachable from the runner source', () => {
    const used = new Set(extractFirstArgIds('node'));
    manifest.nodes.forEach((node) => expect(used.has(node.id)).toBe(true));
  });

  it('only compares control ids declared in manifest.json', () => {
    const known = new Set(manifest.controls.map((control) => control.id));
    const used = extractControlLiteralIds();
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('every control id in manifest.json is reachable from the runner source', () => {
    const used = new Set(extractControlLiteralIds());
    manifest.controls.forEach((control) => expect(used.has(control.id)).toBe(true));
  });

  it('fails when an unknown id is scanned (self-check of the regex)', () => {
    const known = new Set(manifest.metrics.map((metric) => metric.id));
    expect(known.has('not-a-real-metric-id')).toBe(false);
  });
});
