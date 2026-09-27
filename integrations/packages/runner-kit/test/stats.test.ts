import { describe, expect, it } from 'vitest';
import { createSampleWindow, percentile, summarize } from '../src/stats';

const oneToHundred = Array.from({ length: 100 }, (_, index) => index + 1);

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
    expect(percentile(oneToHundred, 0)).toBe(1);
  });

  it('returns undefined for no samples', () => {
    expect(percentile([], 99)).toBeUndefined();
  });

  it('does not reorder the caller array', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('summarize', () => {
  it('returns count, p50, p95, p99 and max', () => {
    expect(summarize(oneToHundred)).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('returns undefined for no samples', () => {
    expect(summarize([])).toBeUndefined();
  });
});

describe('createSampleWindow', () => {
  it('returns everything added since the last drain', () => {
    const window = createSampleWindow();
    window.add(5);
    window.add(7);
    expect(window.drain()).toEqual([5, 7]);
    window.add(9);
    expect(window.drain()).toEqual([9]);
    expect(window.drain()).toEqual([]);
  });
});
