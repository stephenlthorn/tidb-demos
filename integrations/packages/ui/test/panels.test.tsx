import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { ChecksPanel } from '../src/components/ChecksPanel';
import { DemoView } from '../src/components/DemoView';
import { MetricTile } from '../src/components/MetricTile';
import { PhaseTimeline } from '../src/components/PhaseTimeline';
import { PlayerBar } from '../src/components/PlayerBar';
import { foldEvents } from '../src/state/demo-state';

const manifest = aManifest({
  phases: [
    { id: 'warmup', label: 'Warm up', narration: 'We start the pipeline.' },
    { id: 'burst', label: 'Burst', narration: 'Ten times the load.' },
  ],
});

describe('MetricTile', () => {
  it('shows the latest value, a dash when empty, and how it was measured', () => {
    const [metric] = manifest.metrics;
    if (metric === undefined) throw new Error('fixture');
    const { rerender } = render(<MetricTile metric={metric} points={[]} />);
    expect(screen.getByText('-')).toBeTruthy();
    rerender(<MetricTile metric={metric} points={[{ t: 0, value: 25000 }]} />);
    expect(screen.getByText('25.0k rows/s')).toBeTruthy();
    expect(screen.getByText('Rows inserted per second over the last tick')).toBeTruthy();
  });
});

describe('PhaseTimeline', () => {
  it('is a numbered step rail that marks the current phase and the ones already done', () => {
    render(<PhaseTimeline phases={manifest.phases} current="burst" />);
    const burst = screen.getByText('Burst').closest('li');
    const warmup = screen.getByText('Warm up').closest('li');
    expect(burst?.getAttribute('aria-current')).toBe('step');
    expect(burst?.querySelector('.marker')?.textContent).toBe('2');
    expect(warmup?.getAttribute('data-done')).toBe('true');
    expect(screen.getByRole('progressbar', { name: 'Phase progress' }).getAttribute('aria-valuenow')).toBe('2');
  });
});

describe('ChecksPanel', () => {
  it('shows status and observed value', () => {
    const state = foldEvents(manifest, [{ type: 'check', t: 0, id: 'counts-match', status: 'fail', observed: '99 != 100' }]);
    render(<ChecksPanel manifest={manifest} state={state} />);
    expect(screen.getByText('FAIL').closest('.pill')?.getAttribute('data-tone')).toBe('warn');
    expect(screen.getByText('99 != 100')).toBeTruthy();
  });
});

describe('PlayerBar', () => {
  it('reports seeks and speed changes', () => {
    const seeks: number[] = [];
    const speeds: number[] = [];
    render(
      <PlayerBar
        player={{ playing: false, speed: 1, positionMs: 0, durationMs: 60000 }}
        markers={[]}
        onToggle={() => undefined}
        onSeek={(ms) => { seeks.push(ms); }}
        onSpeed={(speed) => { speeds.push(speed); }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '30000' } });
    fireEvent.click(screen.getByText('4x'));
    expect(seeks).toEqual([30000]);
    expect(speeds).toEqual([4]);
    expect(screen.getByText('00:00 / 01:00')).toBeTruthy();
  });
});

describe('DemoView', () => {
  it('puts title, diagram, metrics, narration and checks on one screen', () => {
    const state = foldEvents(manifest, [{ type: 'phase', t: 0, phase: 'warmup' }]);
    render(<DemoView manifest={manifest} state={state} footer={null} badge={null} />);
    expect(screen.getByRole('heading', { name: /Example/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Example data flow' })).toBeTruthy();
    expect(screen.getByText('We start the pipeline.')).toBeTruthy();
    expect(screen.getByText('Counts match')).toBeTruthy();
  });

  it('leads with the integrations as an eyebrow and names the phase in sequence', () => {
    const state = foldEvents(manifest, [{ type: 'phase', t: 0, phase: 'burst' }]);
    render(<DemoView manifest={manifest} state={state} footer={null} badge={null} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(manifest.title);
    expect(screen.getByText(manifest.integrations.join(' · '), { selector: '.eyebrow' })).toBeTruthy();
    expect(screen.getByText('Phase 2 of 2 · Burst')).toBeTruthy();
    expect(screen.getByText('Ten times the load.')).toBeTruthy();
  });
});
