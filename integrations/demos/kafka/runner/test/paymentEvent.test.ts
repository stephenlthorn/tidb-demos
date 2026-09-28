import { describe, expect, it } from 'vitest';
import { createPaymentEvent, encodePaymentEvent, decodePaymentEvent } from '../src/paymentEvent';

describe('paymentEvent', () => {
  it('creates a payment event with a produceTs and a positive amount', () => {
    const event = createPaymentEvent({ sequence: 1, now: () => 1000 });
    expect(event.paymentId).toBe('payment-000001');
    expect(event.produceTs).toBe(1000);
    expect(event.amountCents).toBeGreaterThan(0);
  });

  it('round-trips through JSON encode/decode', () => {
    const event = createPaymentEvent({ sequence: 42, now: () => 5000 });
    const decoded = decodePaymentEvent(encodePaymentEvent(event));
    expect(decoded).toEqual(event);
  });
});
