import { describe, expect, it } from 'vitest';
import { initialDemoState, applyControl } from '../src/mode';

describe('applyControl', () => {
  it('starts in ttl mode with no hot-key storm active', () => {
    expect(initialDemoState()).toEqual({ invalidationMode: 'ttl', hotKeyStormUntilMs: 0 });
  });

  it('toggle-mode flips ttl to cdc', () => {
    const next = applyControl(initialDemoState(), { id: 'toggle-mode', nowMs: 0 });
    expect(next.invalidationMode).toBe('cdc');
  });

  it('toggle-mode flips cdc back to ttl', () => {
    const cdcState = applyControl(initialDemoState(), { id: 'toggle-mode', nowMs: 0 });
    const next = applyControl(cdcState, { id: 'toggle-mode', nowMs: 0 });
    expect(next.invalidationMode).toBe('ttl');
  });

  it('hot-key-storm sets a future expiry from now', () => {
    const next = applyControl(initialDemoState(), { id: 'hot-key-storm', nowMs: 1_000, hotKeyStormDurationMs: 5_000 });
    expect(next.hotKeyStormUntilMs).toBe(6_000);
  });

  it('write-burst does not change mode or storm state', () => {
    const next = applyControl(initialDemoState(), { id: 'write-burst', nowMs: 1_000 });
    expect(next).toEqual(initialDemoState());
  });
});
