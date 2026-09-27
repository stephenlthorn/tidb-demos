import { DemoManifestSchema, type DemoManifest } from '../src/manifest';

export const manifestInput = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  id: 'example',
  number: 0,
  title: 'Example',
  tagline: 'Synthetic rows flowing through a pipeline',
  integrations: ['Synthetic'],
  pattern: 'Any team that wants to see the lab shell working',
  runner: { command: ['node', '--import', 'tsx', 'runner/main.ts'] },
  nodes: [
    { id: 'source', label: 'Source', kind: 'source', x: 10, y: 50 },
    { id: 'tidb', label: 'TiDB', kind: 'tidb', x: 50, y: 50 },
  ],
  edges: [{ id: 'source-to-tidb', from: 'source', to: 'tidb', label: 'rows', unit: 'rows' }],
  metrics: [
    {
      id: 'ingest-rate',
      label: 'Ingest',
      unit: 'rows/s',
      display: 'both',
      better: 'higher',
      howMeasured: 'Rows inserted per second over the last tick',
    },
  ],
  phases: [{ id: 'warmup', label: 'Warm up', narration: 'We start the pipeline.' }],
  checks: [{ id: 'counts-match', label: 'Counts match', description: 'Rows sent equal rows stored' }],
  controls: [{ id: 'burst', label: 'Burst', description: 'Ten times the write rate for 20 seconds' }],
  ...overrides,
});

export const aManifest = (overrides: Readonly<Record<string, unknown>> = {}): DemoManifest =>
  DemoManifestSchema.parse(manifestInput(overrides));
