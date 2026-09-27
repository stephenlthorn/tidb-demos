import { describe, expect, it } from 'vitest';
import { computeSchemaPropagationMs } from '../src/schemaPropagation';

describe('computeSchemaPropagationMs', () => {
  it('returns undefined while the column has not yet appeared', () => {
    expect(computeSchemaPropagationMs({ controlPressedAtMs: 1000, columnObservedAtMs: undefined, nowMs: 1500 })).toBeUndefined();
  });

  it('returns the gap once the column has appeared', () => {
    expect(computeSchemaPropagationMs({ controlPressedAtMs: 1000, columnObservedAtMs: 1420, nowMs: 1500 })).toBe(420);
  });
});
