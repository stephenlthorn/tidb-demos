import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifestJson from '../manifest.json';

const manifest = DemoManifestSchema.parse(manifestJson);
const runnerEntryPath = fileURLToPath(new URL('../runner/main.ts', import.meta.url));
const source = readFileSync(runnerEntryPath, 'utf8');

const manifestIdSets = {
  metric: new Set(manifest.metrics.map((item) => item.id)),
  flow: new Set(manifest.edges.map((item) => item.id)),
  node: new Set(manifest.nodes.map((item) => item.id)),
  phase: new Set(manifest.phases.map((item) => item.id)),
  check: new Set(manifest.checks.map((item) => item.id)),
};

const findCallBodies = (text: string, method: string): readonly string[] => {
  const marker = `emitter.${method}(`;
  const bodies: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(marker, searchFrom);
    if (start === -1) break;
    let depth = 1;
    let index = start + marker.length;
    let quote: '"' | "'" | '`' | undefined;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (quote !== undefined) {
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      index += 1;
    }
    bodies.push(text.slice(start + marker.length, index - 1));
    searchFrom = index;
  }
  return bodies;
};

const splitTopLevelArgs = (body: string): readonly string[] => {
  const args: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote !== undefined) {
      current += char;
      if (char === '\\') {
        current += body[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
};

const literalStringId = (arg: string | undefined): string | undefined => {
  if (arg === undefined) return undefined;
  const match = /^'([a-z0-9-]+)'$/.exec(arg) ?? /^"([a-z0-9-]+)"$/.exec(arg);
  return match?.[1];
};

const literalIdsAtArgIndex = (method: string, argIndex: number): readonly string[] =>
  findCallBodies(source, method)
    .map((body) => literalStringId(splitTopLevelArgs(body)[argIndex]))
    .filter((id): id is string => id !== undefined);

describe('every emitted id exists in manifest.json', () => {
  it('emitter.metric ids are known metrics', () => {
    const ids = literalIdsAtArgIndex('metric', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.metric.has(id)).toBe(true));
  });

  it('emitter.flow edge ids are known edges', () => {
    const ids = literalIdsAtArgIndex('flow', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.flow.has(id)).toBe(true));
  });

  it('emitter.node ids are known nodes', () => {
    const ids = literalIdsAtArgIndex('node', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.node.has(id)).toBe(true));
  });

  it('emitter.phase ids are known phases', () => {
    const ids = literalIdsAtArgIndex('phase', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.phase.has(id)).toBe(true));
  });

  it('emitter.check ids are known checks', () => {
    const ids = literalIdsAtArgIndex('check', 0);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.check.has(id)).toBe(true));
  });

  it('emitter.log node ids (third argument) are known nodes', () => {
    const ids = literalIdsAtArgIndex('log', 2);
    expect(ids.length).toBeGreaterThan(0);
    ids.forEach((id) => expect(manifestIdSets.node.has(id)).toBe(true));
  });

  it('every manifest edge is emitted by at least one emitter.flow call', () => {
    const emittedEdgeIds = new Set(literalIdsAtArgIndex('flow', 0));
    manifest.edges.forEach((edge) => expect(emittedEdgeIds.has(edge.id)).toBe(true));
  });
});
