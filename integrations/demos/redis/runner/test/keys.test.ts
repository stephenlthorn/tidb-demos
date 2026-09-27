import { describe, expect, it } from 'vitest';
import { redisKeyForRow } from '../src/keys';

describe('redisKeyForRow', () => {
  it('builds a namespaced key from a row id', () => {
    expect(redisKeyForRow(42)).toBe('row:42');
  });

  it('is stable for the same id', () => {
    expect(redisKeyForRow(7)).toBe(redisKeyForRow(7));
  });
});
