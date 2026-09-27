import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { initialState } from '../src/state/demo-state';
import { applyLiveMessage } from '../src/sources/live-state';

const manifest = aManifest();
const start = { runId: undefined, state: initialState(manifest) };

describe('applyLiveMessage', () => {
  it('folds events from the same run', () => {
    const first = applyLiveMessage(manifest, start, 'run1.0', '{"type":"metric","t":1000,"id":"ingest-rate","value":5}');
    const second = applyLiveMessage(manifest, first, 'run1.1', '{"type":"metric","t":2000,"id":"ingest-rate","value":7}');
    expect(second.runId).toBe('run1');
    expect(second.state.metrics['ingest-rate']).toHaveLength(2);
  });

  it('starts from a clean state when a new run begins', () => {
    const old = applyLiveMessage(manifest, start, 'run1.0', '{"type":"metric","t":50000,"id":"ingest-rate","value":5}');
    const fresh = applyLiveMessage(manifest, old, 'run2.0', '{"type":"metric","t":1000,"id":"ingest-rate","value":9}');
    expect(fresh.runId).toBe('run2');
    expect(fresh.state.metrics['ingest-rate']).toEqual([{ t: 1000, value: 9 }]);
    expect(fresh.state.t).toBe(1000);
  });

  it('ignores messages that are not valid events', () => {
    expect(applyLiveMessage(manifest, start, 'run1.0', 'not json')).toBe(start);
  });
});
