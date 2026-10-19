import { authorize } from './gateway.js';
import { record } from './ledger.js';
import { findExisting } from './idempotency.js';

export function processCharge(ledger, request) {
  const existing = findExisting(ledger, request.idempotencyKey);
  if (existing) return existing;
  authorize(request.amountCents);
  const id = `ch_${ledger.charges.length + 1}`;
  return record(ledger, {
    id,
    idempotencyKey: request.idempotencyKey,
    amountCents: request.amountCents,
  });
}
