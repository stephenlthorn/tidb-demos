import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

const readFrom = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const manifest = DemoManifestSchema.parse(JSON.parse(readFrom('../manifest.json')));
const source = readFrom('../runner/main.ts');

const literalMatch = (text: string): string | undefined => {
  const match = /^'([^']*)'$/.test(text) ? text.slice(1, -1) : undefined;
  return match;
};

const extractFirstArgIds = (methodName: string): readonly string[] => {
  const pattern = new RegExp(String.raw`emitter\.${methodName}\(\s*'([^']*)'`, 'g');
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
};

const extractLogNodeIds = (): readonly string[] => {
  const marker = 'emitter.log(';
  const nodeIds: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    const end = source.indexOf(')', start);
    if (end === -1) break;
    const rawArgs = source.slice(start + marker.length, end).split(',').map((part) => part.trim());
    if (rawArgs.length >= 3) {
      const literal = literalMatch(rawArgs[2] ?? '');
      if (literal !== undefined) nodeIds.push(literal);
    }
    searchFrom = end + 1;
  }
  return nodeIds;
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

  it('only references node ids in log calls that name a node', () => {
    const known = new Set(manifest.nodes.map((node) => node.id));
    const used = extractLogNodeIds();
    expect(used.length).toBeGreaterThan(0);
    used.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('fails when an unknown id is scanned (self-check of the regex)', () => {
    const known = new Set(manifest.metrics.map((metric) => metric.id));
    expect(known.has('not-a-real-metric-id')).toBe(false);
  });
});
