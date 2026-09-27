import { describe, expect, it } from 'vitest';
import { createParseRateTracker } from '../src/parseRate';

describe('parse rate tracker', () => {
  it('reports 100% with no observations yet', () => {
    const tracker = createParseRateTracker();
    expect(tracker.successRatePercent()).toBe(100);
  });

  it('reports the ratio of successes to total observations', () => {
    const tracker = createParseRateTracker();
    tracker.recordSuccess();
    tracker.recordSuccess();
    tracker.recordFailure();
    expect(tracker.successRatePercent()).toBeCloseTo((2 / 3) * 100, 5);
  });
});
