import { describe, expect, it } from 'vitest';
import { cutoverDowntimeSeconds } from '../runner/src/cutover-timer';

describe('cutoverDowntimeSeconds', () => {
  it('converts a millisecond span to seconds rounded to one decimal', () => {
    expect(cutoverDowntimeSeconds({ stoppedAtMs: 0, confirmedAtMs: 4300 })).toBe(4.3);
  });

  it('returns zero for a zero-length span', () => {
    expect(cutoverDowntimeSeconds({ stoppedAtMs: 1000, confirmedAtMs: 1000 })).toBe(0);
  });
});
