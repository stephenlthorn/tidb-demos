import { describe, expect, it } from 'vitest';
import { rowCountDiff } from '../runner/src/row-count-diff';

describe('rowCountDiff', () => {
  it('returns zero when both counts match', () => {
    expect(rowCountDiff({ sourceCount: 1000, targetCount: 1000 })).toBe(0);
  });

  it('returns the absolute difference when counts do not match', () => {
    expect(rowCountDiff({ sourceCount: 1000, targetCount: 994 })).toBe(6);
    expect(rowCountDiff({ sourceCount: 994, targetCount: 1000 })).toBe(6);
  });
});
