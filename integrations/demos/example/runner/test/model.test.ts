import { describe, expect, it } from 'vitest';
import { summarize } from '@lab/runner-kit';
import { BASE_RATE, initialModel, latencySamples, phaseFor, rateFor, startBurst, step } from '../src/model';

describe('synthetic model', () => {
  it('ramps up over the first ten ticks', () => {
    expect(rateFor(initialModel)).toBe(BASE_RATE / 10);
    expect(rateFor({ ...initialModel, tick: 9 })).toBe(BASE_RATE);
  });

  it('multiplies the rate by ten during a burst', () => {
    expect(rateFor(startBurst({ ...initialModel, tick: 20 }))).toBe(BASE_RATE * 10);
  });

  it('accumulates stored rows and counts the burst down', () => {
    const next = step(startBurst({ ...initialModel, tick: 20 }));
    expect(next).toEqual({ tick: 21, burstTicksLeft: 9, stored: BASE_RATE * 10 });
  });

  it('maps ticks to phases', () => {
    expect([0, 9, 10, 29, 30, 44, 45].map(phaseFor)).toEqual(['warmup', 'warmup', 'steady', 'steady', 'burst', 'burst', 'verify']);
  });

  it('keeps simulated p99 under the 20 ms target even during a burst', () => {
    expect(summarize(latencySamples(BASE_RATE * 10, 31))?.p99).toBeLessThan(20);
  });

  it('is deterministic', () => {
    expect(latencySamples(200, 5)).toEqual(latencySamples(200, 5));
  });
});
