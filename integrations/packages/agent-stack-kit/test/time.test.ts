import { describe, expect, it } from 'vitest';
import { rfc3339Second } from '../src/time';

describe('rfc3339Second', () => {
  it('rounds a fractional second up to the next whole second', () => {
    expect(rfc3339Second('2026-10-17T10:00:00.250Z')).toBe('2026-10-17T10:00:01Z');
  });

  it('keeps a timestamp that is already on a whole second', () => {
    expect(rfc3339Second('2026-10-17T10:00:00.000Z')).toBe('2026-10-17T10:00:00Z');
  });

  it('rounds microsecond precision up as well', () => {
    expect(rfc3339Second('2026-10-17T10:00:00.000001Z')).toBe('2026-10-17T10:00:01Z');
  });

  it('carries across a minute boundary', () => {
    expect(rfc3339Second('2026-10-17T10:00:59.900Z')).toBe('2026-10-17T10:01:00Z');
  });

  it('accepts a Date', () => {
    expect(rfc3339Second(new Date('2026-10-17T10:00:00.001Z'))).toBe('2026-10-17T10:00:01Z');
  });

  it('rejects text that is not a timestamp', () => {
    expect(() => rfc3339Second('yesterday')).toThrow(RangeError);
  });
});
