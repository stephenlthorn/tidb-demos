import { describe, expect, it } from 'vitest';
import { createHeartbeatOrder, createOrder } from '../src/orderGenerator';

const fixedSource = (values: readonly number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    if (value === undefined) throw new Error('fixedSource exhausted');
    return value;
  };
};

describe('createOrder', () => {
  it('builds a deterministic order from a fixed random source', () => {
    const order = createOrder({ sequence: 7, randomSource: fixedSource([0, 0, 0.5]) });
    expect(order).toEqual({
      orderId: 'ord-7',
      region: 'us-east',
      productCategory: 'electronics',
      amount: 255,
      isHeartbeat: false,
    });
  });
});

describe('createHeartbeatOrder', () => {
  it('builds a marked heartbeat order with a distinct id prefix', () => {
    expect(createHeartbeatOrder({ sequence: 3 })).toEqual({
      orderId: 'hb-3',
      region: 'us-east',
      productCategory: 'heartbeat',
      amount: 0,
      isHeartbeat: true,
    });
  });
});
