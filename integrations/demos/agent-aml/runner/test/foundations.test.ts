import { describe, expect, it } from 'vitest';
import { alertKey } from '../src/domain';
import { createRng, deriveSeed } from '../src/prng';
import { createStore } from '../src/store';
import {
  DAY_MS,
  formatDateTime,
  formatDateTimeMs,
  parseDateTime,
  startOfDay,
  weekBucket,
} from '../src/time';

describe('createRng', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it('differs for different seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('keeps int inside its inclusive range and pick inside its list', () => {
    const rng = createRng(9);
    Array.from({ length: 200 }, () => rng.int(3, 5)).forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
    });
    expect(['a', 'b']).toContain(rng.pick(['a', 'b']));
  });

  it('refuses to pick from an empty list', () => {
    expect(() => createRng(1).pick([])).toThrow('pick from empty list');
  });
});

describe('deriveSeed', () => {
  it('is stable per label and different across labels', () => {
    expect(deriveSeed(7, 'history')).toBe(deriveSeed(7, 'history'));
    expect(deriveSeed(7, 'history')).not.toBe(deriveSeed(7, 'population'));
  });
});

describe('time helpers', () => {
  it('formats and parses UTC timestamps round trip, with or without fractions', () => {
    const ms = Date.UTC(2026, 3, 1, 12, 30, 15, 123);
    expect(formatDateTime(ms)).toBe('2026-04-01 12:30:15');
    expect(formatDateTimeMs(ms)).toBe('2026-04-01 12:30:15.123');
    expect(parseDateTime('2026-04-01 12:30:15.123')).toBe(ms);
    expect(parseDateTime('2026-04-01T12:30:15.123Z')).toBe(ms);
  });

  it('rejects text that is not a timestamp', () => {
    expect(() => parseDateTime('yesterday')).toThrow('unparseable timestamp');
  });

  it('buckets by week and day', () => {
    expect(weekBucket(7 * DAY_MS)).toBe(1);
    expect(weekBucket(7 * DAY_MS - 1)).toBe(0);
    expect(startOfDay(DAY_MS + 5)).toBe(DAY_MS);
  });
});

describe('alertKey', () => {
  it('identifies an alert by rule, version, account and bucket', () => {
    expect(alertKey({ ruleId: 'structuring', ruleVersion: 'v1', accountId: 'ACC-0001', bucket: 4 })).toBe(
      'structuring|v1|ACC-0001|4',
    );
  });
});

describe('createStore', () => {
  it('replaces its value wholesale and returns the new one', () => {
    const store = createStore({ count: 1 });
    const next = store.update((current) => ({ count: current.count + 1 }));
    expect(next).toEqual({ count: 2 });
    expect(store.get()).toEqual({ count: 2 });
  });
});
