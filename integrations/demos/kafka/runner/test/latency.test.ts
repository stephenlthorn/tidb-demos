import { describe, expect, it } from 'vitest';
import { computeE2eLatencyMs } from '../src/latency';

describe('computeE2eLatencyMs', () => {
  it('returns the difference between consume time and produce time', () => {
    expect(computeE2eLatencyMs({ produceTs: 1000, consumeTs: 1250 })).toBe(250);
  });

  it('floors negative results at zero for clock-skew safety', () => {
    expect(computeE2eLatencyMs({ produceTs: 1000, consumeTs: 900 })).toBe(0);
  });
});
