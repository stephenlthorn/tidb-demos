import { describe, expect, it } from 'vitest';
import { createDedupeTracker } from '../src/dedupe';

describe('dedupe tracker', () => {
  it('reports the first observation of a key as not a duplicate', () => {
    const tracker = createDedupeTracker();
    expect(tracker.observe('payment-000001:100')).toEqual({ isDuplicate: false, duplicateCount: 0 });
  });

  it('reports a repeated key as a duplicate and counts it', () => {
    const tracker = createDedupeTracker();
    tracker.observe('payment-000001:100');
    expect(tracker.observe('payment-000001:100')).toEqual({ isDuplicate: true, duplicateCount: 1 });
    expect(tracker.observe('payment-000001:100')).toEqual({ isDuplicate: true, duplicateCount: 2 });
  });

  it('treats different keys independently', () => {
    const tracker = createDedupeTracker();
    tracker.observe('payment-000001:100');
    expect(tracker.observe('payment-000002:100')).toEqual({ isDuplicate: false, duplicateCount: 0 });
  });
});
