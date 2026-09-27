import { describe, expect, it } from 'vitest';
import { createFaultState, faultInjected, faultsCleared } from '../src/faultState';

describe('fault state machine', () => {
  it('starts with no active fault', () => {
    expect(createFaultState().active).toBeUndefined();
  });

  it('records the active fault and its injection time', () => {
    const state = faultInjected(createFaultState(), { fault: 'slow-query-storm', atMs: 1_000 });
    expect(state.active).toEqual({ fault: 'slow-query-storm', injectedAtMs: 1_000 });
  });

  it('replacing an active fault keeps only the newest one', () => {
    const first = faultInjected(createFaultState(), { fault: 'slow-query-storm', atMs: 1_000 });
    const second = faultInjected(first, { fault: 'write-hot-spot', atMs: 2_000 });
    expect(second.active).toEqual({ fault: 'write-hot-spot', injectedAtMs: 2_000 });
  });

  it('clearing resets to no active fault', () => {
    const injected = faultInjected(createFaultState(), { fault: 'connection-surge', atMs: 1_000 });
    expect(faultsCleared(injected).active).toBeUndefined();
  });
});
