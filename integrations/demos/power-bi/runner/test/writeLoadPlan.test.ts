import { describe, expect, it } from 'vitest';
import { ordersPerTick } from '../src/writeLoadPlan';

describe('ordersPerTick', () => {
  it('writes the base rate when no burst is active', () => {
    expect(ordersPerTick({ baseRatePerSec: 5, burstActive: false, burstFactor: 8 })).toBe(5);
  });

  it('multiplies by the burst factor while a burst is active', () => {
    expect(ordersPerTick({ baseRatePerSec: 5, burstActive: true, burstFactor: 8 })).toBe(40);
  });

  it('never returns fewer than 1 order per tick', () => {
    expect(ordersPerTick({ baseRatePerSec: 0, burstActive: false, burstFactor: 8 })).toBe(1);
  });
});
