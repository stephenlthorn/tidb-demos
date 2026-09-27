import { describe, expect, it } from 'vitest';
import { every, sleep, timed } from '../src/timing';
import { clockFrom } from './helpers';

describe('timed', () => {
  it('returns the task value and the elapsed milliseconds', async () => {
    const result = await timed(async () => 'done', clockFrom([10, 35]));
    expect(result).toEqual({ value: 'done', ms: 25 });
  });
});

describe('sleep', () => {
  it('resolves early when the signal aborts', async () => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 20);
    await sleep(5000, controller.signal);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('every', () => {
  it('runs the task repeatedly until aborted', async () => {
    const controller = new AbortController();
    const runs: number[] = [];
    setTimeout(() => controller.abort(), 260);
    await every({ intervalMs: 50, task: async () => { runs.push(1); }, signal: controller.signal });
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(runs.length).toBeLessThanOrEqual(7);
  });

  it('never overlaps runs when a task is slower than the interval', async () => {
    const controller = new AbortController();
    const state = { active: 0, maxActive: 0 };
    setTimeout(() => controller.abort(), 200);
    await every({
      intervalMs: 10,
      task: async () => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await sleep(30);
        state.active -= 1;
      },
      signal: controller.signal,
    });
    expect(state.maxActive).toBe(1);
  });
});
