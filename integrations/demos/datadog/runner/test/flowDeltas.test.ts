import { describe, expect, it } from 'vitest';
import { computeCounterDelta } from '../src/flowDeltas';

describe('computeCounterDelta', () => {
  it('returns zero on the first observation (no previous value yet)', () => {
    expect(computeCounterDelta({ previous: undefined, current: 42 })).toBe(0);
  });

  it('returns the increase since the previous observation', () => {
    expect(computeCounterDelta({ previous: 10, current: 17 })).toBe(7);
  });

  it('clamps a decrease (counter reset) to zero rather than a negative flow', () => {
    expect(computeCounterDelta({ previous: 20, current: 12 })).toBe(0);
  });

  it('returns zero when nothing changed', () => {
    expect(computeCounterDelta({ previous: 5, current: 5 })).toBe(0);
  });
});
