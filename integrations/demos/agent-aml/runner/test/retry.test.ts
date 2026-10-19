import { describe, expect, it } from 'vitest';
import { retryUntil } from '../src/retry';

const noPause = async (): Promise<void> => undefined;

describe('retryUntil', () => {
  it('returns the first defined result without pausing', async () => {
    const pauses: number[] = [];
    const result = await retryUntil({
      attempt: async () => 'ready',
      tries: 5,
      delayMs: 100,
      pause: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result).toBe('ready');
    expect(pauses).toEqual([]);
  });

  it('retries with the given delay until a result appears', async () => {
    const calls: number[] = [];
    const pauses: number[] = [];
    const result = await retryUntil({
      attempt: async () => {
        calls.push(calls.length + 1);
        return calls.length === 3 ? 'visible' : undefined;
      },
      tries: 5,
      delayMs: 250,
      pause: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result).toBe('visible');
    expect(pauses).toEqual([250, 250]);
  });

  it('gives up with undefined after the last try', async () => {
    const result = await retryUntil({ attempt: async () => undefined, tries: 3, delayMs: 1, pause: noPause });
    expect(result).toBeUndefined();
  });
});
