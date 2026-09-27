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
  it('marks the current phase and shows its narration', () => {
    render(<PhaseTimeline phases={manifest.phases} current="burst" />);
    expect(screen.getByText('Ten times the load.')).toBeTruthy();
    expect(screen.getByText('2. Burst').getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('1. Warm up').getAttribute('data-done')).toBe('true');
  });
});

describe('ChecksPanel', () => {
  it('shows status and observed value', () => {
    const state = foldEvents(manifest, [{ type: 'check', t: 0, id: 'counts-match', status: 'fail', observed: '99 != 100' }]);
    render(<ChecksPanel manifest={manifest} state={state} />);
    expect(screen.getByText('FAIL')).toBeTruthy();
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
});
