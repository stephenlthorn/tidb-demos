import { describe, expect, it } from 'vitest';
import { computeFreshnessLagMs, computeFullLoopSeconds, parseDatabricksTimestamp } from '../src/freshness';

describe('computeFreshnessLagMs', () => {
  it('returns the gap between the heartbeat write time and when it was observed', () => {
    expect(computeFreshnessLagMs(1000, 1800)).toBe(800);
  });

  it('never returns a negative lag when clocks are skewed', () => {
    expect(computeFreshnessLagMs(2000, 1800)).toBe(0);
  });
});

describe('computeFullLoopSeconds', () => {
  it('converts the millisecond gap between write and score to seconds', () => {
    expect(computeFullLoopSeconds(1_000, 4_500)).toBe(3.5);
  });

  it('never returns a negative duration', () => {
    expect(computeFullLoopSeconds(5_000, 4_000)).toBe(0);
  });
});

describe('parseDatabricksTimestamp', () => {
  it('parses a space-separated UTC timestamp into epoch milliseconds', () => {
    expect(parseDatabricksTimestamp('2026-09-25 12:00:00.000')).toBe(Date.parse('2026-09-25T12:00:00.000Z'));
  });

  it('throws on an unparseable value', () => {
    expect(() => parseDatabricksTimestamp('not-a-timestamp')).toThrow('invalid timestamp');
  });
});
