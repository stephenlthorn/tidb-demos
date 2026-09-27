import { describe, expect, it } from 'vitest';
import { msSincePublished } from '../src/latency';

describe('msSincePublished', () => {
  it('computes the millisecond gap between a published ISO timestamp and a later time', () => {
    const publishedMs = Date.parse('2026-01-01T00:00:00.000Z');
    const completedAtMs = publishedMs + 500;
    expect(msSincePublished('2026-01-01T00:00:00.000Z', completedAtMs)).toBe(500);
  });

  it('throws on an invalid ISO timestamp', () => {
    expect(() => msSincePublished('not-a-date', Date.now())).toThrow('invalid ISO timestamp: not-a-date');
  });
});
