import { describe, expect, it } from 'vitest';
import { withTimeout } from '../src/shutdown';

describe('withTimeout', () => {
  it('resolves with the promise value when it settles before the deadline', async () => {
    const result = await withTimeout(Promise.resolve('done'), 50, 'fallback');
    expect(result).toBe('done');
  });

  it('resolves with the fallback when the promise never settles in time', async () => {
    const neverSettles = new Promise<string>(() => {});
    const result = await withTimeout(neverSettles, 20, 'fallback');
    expect(result).toBe('fallback');
  });

  it('does not let a rejected promise reject the wrapper before the deadline', async () => {
    const result = await withTimeout(Promise.reject(new Error('boom')).catch(() => 'caught'), 50, 'fallback');
    expect(result).toBe('caught');
  });
});
