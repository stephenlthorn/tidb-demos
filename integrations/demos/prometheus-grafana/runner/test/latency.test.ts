import { describe, expect, it } from 'vitest';
import { detectionLatencySeconds, recoveryLatencySeconds } from '../src/latency';

describe('latency math', () => {
  it('computes detection latency as receipt minus injection, in seconds', () => {
    expect(detectionLatencySeconds({ injectedAtMs: 1_000, receivedAtMs: 4_500 })).toBeCloseTo(3.5);
  });

  it('returns undefined when no receipt has happened yet', () => {
    expect(detectionLatencySeconds({ injectedAtMs: 1_000, receivedAtMs: undefined })).toBeUndefined();
  });

  it('computes recovery latency as resolved minus cleared, in seconds', () => {
    expect(recoveryLatencySeconds({ clearedAtMs: 2_000, resolvedAtMs: 9_000 })).toBeCloseTo(7);
  });

  it('returns undefined when not yet resolved', () => {
    expect(recoveryLatencySeconds({ clearedAtMs: 2_000, resolvedAtMs: undefined })).toBeUndefined();
  });
});
