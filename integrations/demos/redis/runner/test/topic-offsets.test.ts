import { describe, expect, it } from 'vitest';
import { computeOffsetDelta, sumHighWatermarks } from '../src/topic-offsets';

describe('sumHighWatermarks', () => {
  it('sums the high watermark across all partitions', () => {
    const total = sumHighWatermarks([
      { partition: 0, high: '10' },
      { partition: 1, high: '25' },
      { partition: 2, high: '3' },
    ]);
    expect(total).toBe(38);
  });

  it('returns 0 for a topic with no partitions', () => {
    expect(sumHighWatermarks([])).toBe(0);
  });
});

describe('computeOffsetDelta', () => {
  it('is 0 on the first sample, when there is no previous total to diff against', () => {
    expect(computeOffsetDelta({ previousTotal: undefined, currentTotal: 500 })).toBe(0);
  });

  it('is the difference between the current and previous total', () => {
    expect(computeOffsetDelta({ previousTotal: 500, currentTotal: 512 })).toBe(12);
  });

  it('floors at 0 if the reported total ever goes backwards', () => {
    expect(computeOffsetDelta({ previousTotal: 500, currentTotal: 480 })).toBe(0);
  });

  it('is 0 when nothing moved since the last tick', () => {
    expect(computeOffsetDelta({ previousTotal: 500, currentTotal: 500 })).toBe(0);
  });
});
