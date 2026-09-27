import { describe, expect, it } from 'vitest';
import { currentWriteRate, isBurstActive } from '../runner/src/workload';

describe('currentWriteRate', () => {
  it('returns the baseline rate when no burst is active', () => {
    expect(
      currentWriteRate({ baselineRowsPerTick: 5, burstUntilMs: undefined, burstMultiplier: 10, nowMs: 1000 }),
    ).toBe(5);
  });

  it('returns the multiplied rate while a burst window is active', () => {
    expect(
      currentWriteRate({ baselineRowsPerTick: 5, burstUntilMs: 5000, burstMultiplier: 10, nowMs: 1000 }),
    ).toBe(50);
  });

  it('returns the baseline rate once the burst window has elapsed', () => {
    expect(
      currentWriteRate({ baselineRowsPerTick: 5, burstUntilMs: 5000, burstMultiplier: 10, nowMs: 6000 }),
    ).toBe(5);
  });

  it('treats the exact burst end tick as no longer bursting', () => {
    expect(
      currentWriteRate({ baselineRowsPerTick: 5, burstUntilMs: 5000, burstMultiplier: 10, nowMs: 5000 }),
    ).toBe(5);
  });
});

describe('isBurstActive', () => {
  it('is false with no burst window set', () => {
    expect(isBurstActive({ burstUntilMs: undefined, nowMs: 1000 })).toBe(false);
  });

  it('is true strictly before the burst window ends', () => {
    expect(isBurstActive({ burstUntilMs: 5000, nowMs: 4999 })).toBe(true);
  });

  it('is false at or after the burst window ends', () => {
    expect(isBurstActive({ burstUntilMs: 5000, nowMs: 5000 })).toBe(false);
  });
});
