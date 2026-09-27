import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DemoManifestSchema } from '@lab/contract';

const manifestPath = new URL('../manifest.json', import.meta.url);
const manifest = DemoManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

const nodeIds = new Set(manifest.nodes.map((node) => node.id));
const edgeIds = new Set(manifest.edges.map((edge) => edge.id));
const metricIds = new Set(manifest.metrics.map((metric) => metric.id));
const phaseIds = new Set(manifest.phases.map((phase) => phase.id));
const checkIds = new Set(manifest.checks.map((check) => check.id));

const srcDir = new URL('../runner/src/', import.meta.url);
const sourceUrls = [
  new URL('../runner/main.ts', import.meta.url),
  ...readdirSync(fileURLToPath(srcDir))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => new URL(name, srcDir)),
];

const runnerSource = sourceUrls.map((url) => readFileSync(url, 'utf8')).join('\n');

const findLiteralArgs = (source: string, method: string): readonly string[] => {
  const pattern = new RegExp(`emitter\\.${method}\\(\\s*['"]([^'"]+)['"]`, 'g');
  return Array.from(source.matchAll(pattern), (match) => match[1]).filter((id): id is string => id !== undefined);
};

const findLogNodeIds = (source: string): readonly string[] => {
  const pattern = /emitter\.log\(\s*['"](?:info|warn|error)['"]\s*,[^,]+,\s*['"]([^'"]+)['"]/g;
  return Array.from(source.matchAll(pattern), (match) => match[1]).filter((id): id is string => id !== undefined);
};

describe('emitted event ids reference the manifest', () => {
  it('emits only metric ids declared in manifest.json', () => {
    const unknown = findLiteralArgs(runnerSource, 'metric').filter((id) => !metricIds.has(id));
    expect(unknown).toEqual([]);
  });

  it('emits only edge ids declared in manifest.json for flow events', () => {
    const unknown = findLiteralArgs(runnerSource, 'flow').filter((id) => !edgeIds.has(id));
    expect(unknown).toEqual([]);
  });

  it('emits only node ids declared in manifest.json for node events', () => {
    const unknown = findLiteralArgs(runnerSource, 'node').filter((id) => !nodeIds.has(id));
    expect(unknown).toEqual([]);
  });

  it('emits only phase ids declared in manifest.json', () => {
    const unknown = findLiteralArgs(runnerSource, 'phase').filter((id) => !phaseIds.has(id));
    expect(unknown).toEqual([]);
  });

  it('emits only check ids declared in manifest.json', () => {
    const unknown = findLiteralArgs(runnerSource, 'check').filter((id) => !checkIds.has(id));
    expect(unknown).toEqual([]);
  });

  it('logs against only node ids declared in manifest.json', () => {
    const unknown = findLogNodeIds(runnerSource).filter((id) => !nodeIds.has(id));
    expect(unknown).toEqual([]);
  });

  it('actually emits at least one metric, node and phase id, proving the scan is not vacuous', () => {
    expect(findLiteralArgs(runnerSource, 'metric').length).toBeGreaterThan(0);
    expect(findLiteralArgs(runnerSource, 'node').length).toBeGreaterThan(0);
    expect(findLiteralArgs(runnerSource, 'phase').length).toBeGreaterThan(0);
    expect(findLiteralArgs(runnerSource, 'flow').length).toBeGreaterThan(0);
  });
});
