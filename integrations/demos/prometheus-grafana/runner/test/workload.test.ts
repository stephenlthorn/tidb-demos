import { describe, expect, it } from 'vitest';
import { startWorkload, stopWorkload } from '../src/workload';

type FakePoolOptions = { readonly failFromCall?: number };

const createFakePool = ({ failFromCall }: FakePoolOptions = {}) => {
  let calls = 0;
  return {
    query: async (): Promise<unknown> => {
      calls += 1;
      if (failFromCall !== undefined && calls > failFromCall) throw new Error('boom');
      return undefined;
    },
  };
};

const waitFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('workload query counter', () => {
  it('starts both counters at zero before any tick has run', async () => {
    const pool = createFakePool();
    const handle = await startWorkload({ pool, intervalMs: 1000 });
    expect(handle.completedQueries()).toBe(0);
    expect(handle.errors()).toBe(0);
    stopWorkload(handle);
  });

  it('increments completedQueries by two per successful tick (insert and select)', async () => {
    const pool = createFakePool();
    const handle = await startWorkload({ pool, intervalMs: 5 });
    await waitFor(30);
    stopWorkload(handle);
    expect(handle.completedQueries()).toBeGreaterThanOrEqual(2);
    expect(handle.completedQueries() % 2).toBe(0);
    expect(handle.errors()).toBe(0);
  });

  it('increments errors and keeps ticking when a query rejects', async () => {
    const pool = createFakePool({ failFromCall: 1 });
    const handle = await startWorkload({ pool, intervalMs: 5 });
    await waitFor(30);
    stopWorkload(handle);
    expect(handle.errors()).toBeGreaterThan(0);
    expect(handle.completedQueries()).toBe(0);
  });

  it('stops increasing completedQueries after stop is called', async () => {
    const pool = createFakePool();
    const handle = await startWorkload({ pool, intervalMs: 5 });
    await waitFor(20);
    stopWorkload(handle);
    const countAfterStop = handle.completedQueries();
    await waitFor(20);
    expect(handle.completedQueries()).toBe(countAfterStop);
  });
});
