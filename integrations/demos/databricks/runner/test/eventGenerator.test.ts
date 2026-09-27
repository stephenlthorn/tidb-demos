import { describe, expect, it } from 'vitest';
import { generateEvent } from '../src/eventGenerator';

const sequence = (values: readonly number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    if (value === undefined) throw new Error('sequence exhausted');
    return value;
  };
};

describe('generateEvent', () => {
  it('keeps the customer id within 1..customerCount', () => {
    const event = generateEvent(50, sequence([0, 0, 0]));
    expect(event.customerId).toBe(1);
  });

  it('picks purchase below the 0.85 roll threshold', () => {
    const event = generateEvent(50, sequence([0.1, 0.5, 0.5]));
    expect(event.eventType).toBe('purchase');
  });

  it('picks refund between 0.85 and 0.97', () => {
    const event = generateEvent(50, sequence([0.1, 0.9, 0.5]));
    expect(event.eventType).toBe('refund');
  });

  it('picks chargeback at or above 0.97', () => {
    const event = generateEvent(50, sequence([0.1, 0.99, 0.5]));
    expect(event.eventType).toBe('chargeback');
  });

  it('rounds the amount to two decimal places', () => {
    const event = generateEvent(50, sequence([0.5, 0.5, 0.123456]));
    expect(event.amount).toBeCloseTo(66.11, 2);
  });
});
