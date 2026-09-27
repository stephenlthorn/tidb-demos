import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry, Trace } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { CatalogPage } from '../src/pages/CatalogPage';
import { ReplayView } from '../src/pages/ReplayPage';

const entries: readonly CatalogEntry[] = [
  { id: 'kafka', number: 2, title: 'Kafka in and out', tagline: 'Streams both ways', integrations: ['Kafka'], hasReplay: true },
  { id: 'okta', number: 5, title: 'Okta lifecycle', tagline: 'Revoke in seconds', integrations: ['Okta'], hasReplay: false },
];

const trace: Trace = {
  schemaVersion: 1,
  manifest: aManifest(),
  recordedAt: '2026-09-25T15:00:00.000Z',
  environment: { tidb: 'tiup playground', components: {}, notes: '' },
  durationMs: 10000,
  events: [
    { type: 'phase', t: 0, phase: 'warmup' },
    { type: 'metric', t: 1000, id: 'ingest-rate', value: 111 },
    { type: 'metric', t: 8000, id: 'ingest-rate', value: 999 },
  ],
};

describe('CatalogPage', () => {
  it('lists demos and says which have replays', async () => {
    render(<CatalogPage load={async () => entries} />);
    expect(await screen.findByText('Kafka in and out')).toBeTruthy();
    expect(screen.getByText('Replay ready')).toBeTruthy();
    expect(screen.getByText('Recording coming soon')).toBeTruthy();
    expect(screen.getByText('Kafka in and out').closest('a')?.getAttribute('href')).toBe('#/demo/kafka');
  });

  it('shows an error when the catalog cannot load', async () => {
    render(<CatalogPage load={async () => { throw new Error('offline'); }} />);
    expect(await screen.findByText('Could not load demos: offline')).toBeTruthy();
  });
});

describe('ReplayView', () => {
  it('renders the state at the scrubbed position', () => {
    render(<ReplayView trace={trace} />);
    expect(screen.getByText('Recorded 2026-09-25 on tiup playground')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '2000' } });
    expect(screen.getByText('111 rows/s')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '9000' } });
    expect(screen.getByText('999 rows/s')).toBeTruthy();
  });
});
