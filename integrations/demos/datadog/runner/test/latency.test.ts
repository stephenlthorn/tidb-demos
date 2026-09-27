import { describe, expect, it } from 'vitest';
import { detectionLatencySeconds } from '../src/latency';

describe('detection latency math', () => {
  it('computes detection latency as the alert-observed poll time minus injection time, in seconds', () => {
    expect(detectionLatencySeconds({ injectedAtMs: 2_000, alertObservedAtMs: 9_000 })).toBeCloseTo(7);
  });

  it('returns undefined when the monitor has not alerted yet', () => {
    expect(detectionLatencySeconds({ injectedAtMs: 2_000, alertObservedAtMs: undefined })).toBeUndefined();
  });
});
