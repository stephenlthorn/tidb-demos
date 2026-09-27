import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

const manifestRaw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf-8');
const manifest = DemoManifestSchema.parse(JSON.parse(manifestRaw));
const mainSource = readFileSync(new URL('../runner/main.ts', import.meta.url), 'utf-8');

const idsOf = (items: readonly { readonly id: string }[]): ReadonlySet<string> =>
  new Set(items.map((item) => item.id));

const metricIds = idsOf(manifest.metrics);
const edgeIds = idsOf(manifest.edges);
const nodeIds = idsOf(manifest.nodes);
const phaseIds = idsOf(manifest.phases);
const checkIds = idsOf(manifest.checks);

const capture = (source: string, pattern: RegExp): readonly string[] =>
  [...source.matchAll(pattern)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);

const metricCalls = capture(mainSource, /emitter\.metric\(\s*'([^']+)'/g);
const flowCalls = capture(mainSource, /emitter\.flow\(\s*'([^']+)'/g);
const nodeCalls = capture(mainSource, /emitter\.node\(\s*'([^']+)'/g);
const phaseCalls = capture(mainSource, /emitter\.phase\(\s*'([^']+)'/g);
const checkCalls = capture(mainSource, /emitter\.check\(\s*'([^']+)'/g);
const logNodeCalls = capture(mainSource, /emitter\.log\([^)]*?,\s*'([a-z0-9-]+)'\s*\)/g);

describe('every emitted id in runner/main.ts exists in manifest.json', () => {
  it('found at least one call of each kind, so the regex is exercising real code', () => {
    expect(metricCalls.length).toBeGreaterThan(0);
    expect(flowCalls.length).toBeGreaterThan(0);
    expect(nodeCalls.length).toBeGreaterThan(0);
    expect(phaseCalls.length).toBeGreaterThan(0);
    expect(checkCalls.length).toBeGreaterThan(0);
    expect(logNodeCalls.length).toBeGreaterThan(0);
  });

  it('every emitter.metric id is a manifest metric id', () => {
    metricCalls.forEach((id) => expect(metricIds.has(id)).toBe(true));
  });

  it('every emitter.flow edge id is a manifest edge id', () => {
    flowCalls.forEach((id) => expect(edgeIds.has(id)).toBe(true));
  });

  it('every emitter.node id is a manifest node id', () => {
    nodeCalls.forEach((id) => expect(nodeIds.has(id)).toBe(true));
  });

  it('every emitter.phase id is a manifest phase id', () => {
    phaseCalls.forEach((id) => expect(phaseIds.has(id)).toBe(true));
  });

  it('every emitter.check id is a manifest check id', () => {
    checkCalls.forEach((id) => expect(checkIds.has(id)).toBe(true));
  });

  it('every emitter.log node argument is a manifest node id', () => {
    logNodeCalls.forEach((id) => expect(nodeIds.has(id)).toBe(true));
  });
});
