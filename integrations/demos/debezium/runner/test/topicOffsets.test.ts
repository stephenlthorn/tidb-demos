import { describe, expect, it } from 'vitest';
import { sumHighWatermarkOffsets } from '../src/topicOffsets';

describe('sumHighWatermarkOffsets', () => {
  it('sums the high watermark across multiple partitions', () => {
    const partitions = [
      { partition: 0, offset: '0', high: '120', low: '0' },
      { partition: 1, offset: '0', high: '80', low: '0' },
      { partition: 2, offset: '0', high: '5', low: '0' },
    ];
    expect(sumHighWatermarkOffsets(partitions)).toBe(205);
  });

  it('parses offsets larger than a 32-bit integer', () => {
    const partitions = [{ partition: 0, offset: '0', high: '4300000000', low: '0' }];
    expect(sumHighWatermarkOffsets(partitions)).toBe(4300000000);
  });

  it('returns 0 for a topic with no partitions', () => {
    expect(sumHighWatermarkOffsets([])).toBe(0);
  });

  it('returns 0 for partitions that have never received a message', () => {
    const partitions = [{ partition: 0, offset: '0', high: '0', low: '0' }];
    expect(sumHighWatermarkOffsets(partitions)).toBe(0);
  });
});
