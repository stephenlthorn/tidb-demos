import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../src/ledger.js';
import { processCharge } from '../src/charge.js';

const request = { idempotencyKey: 'order-1001', amountCents: 2500 };

test('records one charge for a first request', () => {
  const ledger = createLedger();
  const charge = processCharge(ledger, request);
  assert.equal(ledger.charges.length, 1);
  assert.equal(charge.amountCents, 2500);
});

test('a retried request with the same idempotency key records one charge', () => {
  const ledger = createLedger();
  processCharge(ledger, request);
  processCharge(ledger, request);
  assert.equal(ledger.charges.length, 1);
});

test('a retried request returns the original charge id', () => {
  const ledger = createLedger();
  const first = processCharge(ledger, request);
  const second = processCharge(ledger, request);
  assert.equal(second.id, first.id);
});

test('different idempotency keys record separate charges', () => {
  const ledger = createLedger();
  processCharge(ledger, { idempotencyKey: 'order-1', amountCents: 100 });
  processCharge(ledger, { idempotencyKey: 'order-2', amountCents: 200 });
  assert.equal(ledger.charges.length, 2);
});
