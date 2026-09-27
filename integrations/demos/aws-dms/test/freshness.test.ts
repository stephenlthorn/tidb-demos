import { describe, expect, it } from 'vitest';
import { freshnessMs } from '../runner/src/freshness';

describe('freshnessMs', () => {
  it('returns the millisecond gap between insertion and visibility', () => {
    expect(freshnessMs({ insertedAtMs: 1000, visibleAtMs: 1250 })).toBe(250);
  });

  it('returns zero when visibility is immediate', () => {
    expect(freshnessMs({ insertedAtMs: 1000, visibleAtMs: 1000 })).toBe(0);
  });
});
