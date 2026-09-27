import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { formatClock, formatRate, formatValue, isOnTarget } from '../src/format';

describe('formatValue', () => {
  it('formats each unit', () => {
    expect(formatValue(3.14159, 'ms')).toBe('3.14 ms');
    expect(formatValue(1234.4, 'ms')).toBe('1,234 ms');
    expect(formatValue(99.44, '%')).toBe('99.4%');
    expect(formatValue(12.5, 'USD')).toBe('$12.50');
    expect(formatValue(4.25, 's')).toBe('4.3 s');
    expect(formatValue(25000, 'rows/s')).toBe('25.0k rows/s');
    expect(formatValue(3200000, 'rows')).toBe('3.20M rows');
  });
});

describe('formatRate and formatClock', () => {
  it('compacts rates and prints mm:ss', () => {
    expect(formatRate(12.4)).toBe('12');
    expect(formatRate(15300)).toBe('15.3k');
    expect(formatClock(83000)).toBe('01:23');
  });
});

describe('isOnTarget', () => {
  it('compares against the target in the better direction', () => {
    const [metric] = aManifest({ metrics: [{ id: 'p99', label: 'p99', unit: 'ms', display: 'tile', better: 'lower', target: 20, howMeasured: 'timer' }] }).metrics;
    if (metric === undefined) throw new Error('fixture');
    expect(isOnTarget(metric, 12)).toBe(true);
    expect(isOnTarget(metric, 25)).toBe(false);
  });
});
