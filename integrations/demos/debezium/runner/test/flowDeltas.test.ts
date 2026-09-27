import { describe, expect, it } from 'vitest';
import { computeCounterDelta } from '../src/flowDeltas';

describe('computeCounterDelta', () => {
  it('returns 0 when there is no previous value', () => {
    expect(computeCounterDelta({ previous: undefined, current: 42 })).toBe(0);
  });

  it('returns the increase between previous and current', () => {
    expect(computeCounterDelta({ previous: 10, current: 17 })).toBe(7);
  });

  it('floors at 0 when the counter appears to have gone backwards', () => {
    expect(computeCounterDelta({ previous: 20, current: 12 })).toBe(0);
  });

  it('returns 0 when the counter is unchanged', () => {
    expect(computeCounterDelta({ previous: 5, current: 5 })).toBe(0);
  });
});
