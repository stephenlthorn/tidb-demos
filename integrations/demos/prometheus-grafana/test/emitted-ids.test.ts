import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifestData from '../manifest.json';

const manifest = DemoManifestSchema.parse(manifestData);

const demoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runnerSource = readFileSync(join(demoRoot, 'runner', 'main.ts'), 'utf8');

const extractCalls = (methodName: string, argIndex: number): readonly string[] => {
  const pattern = new RegExp(`emitter\\.${methodName}\\(([^)]*)\\)`, 'g');
  const ids: string[] = [];
  for (const match of runnerSource.matchAll(pattern)) {
    const argsText = match[1] ?? '';
    const literals = argsText.match(/'[^']*'/g) ?? [];
    const literal = literals[argIndex];
    if (literal !== undefined) ids.push(literal.slice(1, -1));
  }
  return ids;
};

describe('runner main.ts only emits ids declared in manifest.json', () => {
  it('every emitter.metric id is declared in manifest.metrics', () => {
    const known = new Set(manifest.metrics.map((metric) => metric.id));
    const found = extractCalls('metric', 0);
    expect(found.length).toBeGreaterThan(0);
    found.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('every emitter.flow edge is declared in manifest.edges', () => {
    const known = new Set(manifest.edges.map((edge) => edge.id));
    const found = extractCalls('flow', 0);
    expect(found.length).toBeGreaterThan(0);
    found.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('every emitter.node id is declared in manifest.nodes', () => {
    const known = new Set(manifest.nodes.map((node) => node.id));
    const found = extractCalls('node', 0);
    expect(found.length).toBeGreaterThan(0);
    found.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('every emitter.phase id is declared in manifest.phases', () => {
    const known = new Set(manifest.phases.map((phase) => phase.id));
    const found = extractCalls('phase', 0);
    expect(found.length).toBeGreaterThan(0);
    found.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('every emitter.check id is declared in manifest.checks', () => {
    const known = new Set(manifest.checks.map((check) => check.id));
    const found = extractCalls('check', 0);
    expect(found.length).toBeGreaterThan(0);
    found.forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('every emitter.log node argument (third argument) is declared in manifest.nodes', () => {
    const known = new Set(manifest.nodes.map((node) => node.id));
    extractCalls('log', 2).forEach((id) => expect(known.has(id)).toBe(true));
  });

  it('flags an unknown id as a control (proves the scan is not vacuous)', () => {
    const known = new Set(manifest.checks.map((check) => check.id));
    expect(known.has('not-a-real-check-id')).toBe(false);
  });
});
