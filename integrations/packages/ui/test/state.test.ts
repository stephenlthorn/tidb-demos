import { describe, expect, it } from 'vitest';
import type { DemoEvent } from '@lab/contract';
import { aManifest } from '@lab/contract/testing';
import { foldEvents, initialState, reduceEvent } from '../src/state/demo-state';
import { firstIndexAfter, foldTo } from '../src/state/replay-fold';
import { edgeRate, latestValue } from '../src/state/selectors';

const events: readonly DemoEvent[] = [
  { type: 'phase', t: 0, phase: 'warmup' },
  { type: 'node', t: 0, node: 'tidb', status: 'healthy', note: 'ready' },
  { type: 'flow', t: 1000, edge: 'source-to-tidb', count: 10 },
  { type: 'metric', t: 1000, id: 'ingest-rate', value: 10 },
  { type: 'flow', t: 2000, edge: 'source-to-tidb', count: 30 },
  { type: 'metric', t: 2000, id: 'ingest-rate', value: 30 },
  { type: 'check', t: 3000, id: 'counts-match', status: 'pass', observed: '40 = 40' },
  { type: 'log', t: 3000, level: 'info', msg: 'done' },
];

describe('initialState', () => {
  it('starts every node idle and every check pending', () => {
    const state = initialState(aManifest());
    expect(state.nodes).toEqual({ source: 'idle', tidb: 'idle' });
    expect(state.checks).toEqual({ 'counts-match': { status: 'pending', observed: undefined } });
  });
});

describe('reduceEvent', () => {
  it('folds a whole run', () => {
    const state = foldEvents(aManifest(), events);
    expect(state.phase).toBe('warmup');
    expect(state.nodes.tidb).toBe('healthy');
    expect(state.nodeNotes.tidb).toBe('ready');
    expect(state.metrics['ingest-rate']).toEqual([{ t: 1000, value: 10 }, { t: 2000, value: 30 }]);
    expect(state.checks['counts-match']).toEqual({ status: 'pass', observed: '40 = 40' });
    expect(state.logs).toHaveLength(1);
    expect(state.t).toBe(3000);
  });

  it('does not mutate the previous state', () => {
    const before = initialState(aManifest());
    reduceEvent(before, { type: 'metric', t: 5, id: 'ingest-rate', value: 1 });
    expect(before.metrics).toEqual({});
  });

  it('stops at untilT', () => {
    expect(foldEvents(aManifest(), events, 1500).metrics['ingest-rate']).toEqual([{ t: 1000, value: 10 }]);
  });
});

describe('selectors', () => {
  it('reads the latest metric value', () => {
    expect(latestValue(foldEvents(aManifest(), events), 'ingest-rate')).toBe(30);
    expect(latestValue(initialState(aManifest()), 'ingest-rate')).toBeUndefined();
  });

  it('computes an edge rate over the trailing window', () => {
    const state = foldEvents(aManifest(), events, 2000);
    expect(edgeRate(state, 'source-to-tidb', 2000)).toBe(20);
    expect(edgeRate({ ...state, t: 10000 }, 'source-to-tidb', 2000)).toBe(0);
  });
});

describe('replay folding', () => {
  it('finds the first event after a time', () => {
    expect(firstIndexAfter(events, 1000, 0)).toBe(4);
    expect(firstIndexAfter(events, 99999, 0)).toBe(events.length);
  });

  it('folds forward incrementally and refolds on seek backwards', () => {
    const manifest = aManifest();
    const early = foldTo(manifest, events, undefined, 1000);
    const late = foldTo(manifest, events, early, 3000);
    const back = foldTo(manifest, events, late, 1000);
    expect(late.state.metrics['ingest-rate']).toHaveLength(2);
    expect(back.state.metrics['ingest-rate']).toHaveLength(1);
    expect(late.state.t).toBe(3000);
  });

  it('advances state time to the playhead even between events', () => {
    expect(foldTo(aManifest(), events, undefined, 2500).state.t).toBe(2500);
  });
});
