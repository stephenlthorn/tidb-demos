import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry, Trace } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { AppBar } from '../src/components/AppBar';
import { CatalogPage } from '../src/pages/CatalogPage';
import { ReplayView } from '../src/pages/ReplayPage';

const entries: readonly CatalogEntry[] = [
  {
    id: 'kafka',
    number: 2,
    title: 'Kafka in and out',
    tagline: 'Streams both ways',
    integrations: ['Kafka'],
    hasReplay: true,
    media: {
      videos: [{ src: 'data/media/kafka/kafka-live.mp4', title: 'Live' }],
      screenshots: [
        { src: 'data/media/kafka/screenshots/01-start.jpg', caption: 'Start', group: 'console' },
        { src: 'data/media/kafka/screenshots/02-end.jpg', caption: 'End', group: 'console' },
      ],
    },
  },
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

  it('opens with a hero and presents each demo as a story card', async () => {
    render(<CatalogPage load={async () => entries} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'TiDB, working with the tools you already run.' })).toBeTruthy();
    expect(screen.getByText('Integration Lab', { selector: '.eyebrow' })).toBeTruthy();
    const kafka = screen.getByText('Kafka in and out').closest('a');
    expect(kafka?.querySelector('.card-tag')?.textContent).toBe('Kafka');
    expect(kafka?.textContent).toContain('Watch replay →');
    expect(screen.getByText('Okta lifecycle').closest('a')?.textContent).not.toContain('Watch replay');
  });

  it('badges cards that have media', async () => {
    render(<CatalogPage load={async () => entries} />);
    await screen.findByText('Kafka in and out');
    expect(screen.getByText('Video')).toBeTruthy();
    expect(screen.getByText('2 screenshots')).toBeTruthy();
    expect(screen.queryByText('Okta lifecycle')?.closest('a')?.textContent).not.toContain('Video');
  });

  it('shows an error when the catalog cannot load', async () => {
    render(<CatalogPage load={async () => { throw new Error('offline'); }} />);
    expect(await screen.findByText('Could not load demos: offline')).toBeTruthy();
  });
});

describe('AppBar', () => {
  it('links the wordmark home and offers an all-demos pill away from the catalog', () => {
    const { rerender } = render(<AppBar showHome={false} />);
    expect(screen.getByRole('link', { name: /^TiDB Integration Lab/ }).getAttribute('href')).toBe('#/');
    expect(screen.getByText('Integration Lab')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'All demos' })).toBeNull();
    rerender(<AppBar showHome />);
    expect(screen.getByRole('link', { name: 'All demos' }).getAttribute('href')).toBe('#/');
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
