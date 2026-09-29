import { describe, expect, it, vi } from 'vitest';
import { safeTask } from '../src/safeTask';

describe('safeTask', () => {
  it('runs the wrapped task and does not throw when it resolves', async () => {
    const onError = vi.fn();
    const task = vi.fn(async () => undefined);
    await expect(safeTask({ task, onError })()).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('catches a rejection from the wrapped task and reports it instead of throwing', async () => {
    const onError = vi.fn();
    const failure = new Error('datadog metrics query failed: 429 rate limited');
    const task = vi.fn(async () => {
      throw failure;
    });
    await expect(safeTask({ task, onError })()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
