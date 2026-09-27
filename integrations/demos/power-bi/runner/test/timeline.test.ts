import { describe, expect, it } from 'vitest';
import { phaseForElapsed } from '../src/timeline';

describe('phaseForElapsed', () => {
  it('starts in intro', () => {
    expect(phaseForElapsed(0)).toBe('intro');
  });

  it('moves to seed-baseline at 15s', () => {
    expect(phaseForElapsed(15_000)).toBe('seed-baseline');
  });

  it('moves to tiflash-replica at 45s', () => {
    expect(phaseForElapsed(46_000)).toBe('tiflash-replica');
  });

  it('reaches wrap-up by 225s and stays there past the end of the schedule', () => {
    expect(phaseForElapsed(225_000)).toBe('wrap-up');
    expect(phaseForElapsed(999_000)).toBe('wrap-up');
  });
});
