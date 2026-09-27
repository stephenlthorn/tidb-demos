import { describe, expect, it } from 'vitest';
import { degradationPct, freshnessMs } from '../src/metrics';

describe('freshnessMs', () => {
  it('returns the gap between commit and visibility', () => {
    expect(freshnessMs({ committedAtMs: 1_000, visibleAtMs: 1_340 })).toBe(340);
  });

  it('never returns a negative number if visibility is observed before the recorded commit time', () => {
    expect(freshnessMs({ committedAtMs: 1_000, visibleAtMs: 900 })).toBe(0);
  });
});

describe('degradationPct', () => {
  it('computes the percentage increase over baseline', () => {
    expect(degradationPct({ baselineP99Ms: 20, currentP99Ms: 25 })).toBe(25);
  });

  it('returns 0 when there is no baseline yet', () => {
    expect(degradationPct({ baselineP99Ms: 0, currentP99Ms: 25 })).toBe(0);
  });

  it('returns a negative number when latency improves over baseline', () => {
    expect(degradationPct({ baselineP99Ms: 20, currentP99Ms: 10 })).toBe(-50);
  });
});
