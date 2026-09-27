import { describe, expect, it } from 'vitest';
import { computeHitRatioPercent, isStaleRead, computeInvalidationLagMs } from '../src/staleness';

describe('computeHitRatioPercent', () => {
  it('returns 100 when there are no misses', () => {
    expect(computeHitRatioPercent({ hits: 10, misses: 0 })).toBe(100);
  });

  it('returns 0 when there are no hits', () => {
    expect(computeHitRatioPercent({ hits: 0, misses: 10 })).toBe(0);
  });

  it('returns 0 when there are no reads at all', () => {
    expect(computeHitRatioPercent({ hits: 0, misses: 0 })).toBe(0);
  });

  it('rounds to two decimal places', () => {
    expect(computeHitRatioPercent({ hits: 1, misses: 2 })).toBeCloseTo(33.33, 2);
  });
});

describe('isStaleRead', () => {
  it('is stale when the cached version is behind the TiDB version', () => {
    expect(isStaleRead({ cachedVersion: 3, tidbVersion: 5 })).toBe(true);
  });

  it('is not stale when versions match', () => {
    expect(isStaleRead({ cachedVersion: 5, tidbVersion: 5 })).toBe(false);
  });

  it('is not stale when the cache is somehow ahead', () => {
    expect(isStaleRead({ cachedVersion: 6, tidbVersion: 5 })).toBe(false);
  });
});

describe('computeInvalidationLagMs', () => {
  it('is the difference between delete time and write time', () => {
    expect(computeInvalidationLagMs({ deletedAtMs: 1_000, writtenAtMs: 850 })).toBe(150);
  });

  it('floors at zero for clock skew', () => {
    expect(computeInvalidationLagMs({ deletedAtMs: 100, writtenAtMs: 150 })).toBe(0);
  });
});
