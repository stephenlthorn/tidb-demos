import { authorize } from './gateway.js';
import { record } from './ledger.js';

export function processCharge(ledger, request) {
  const existing = ledger.charges.find((charge) => charge.idempotencyKey === request.idempotencyKey);
  if (existing) return existing;
  authorize(request.amountCents);
  const id = `ch_${ledger.charges.length + 1}`;
  return record(ledger, {
    id,
    idempotencyKey: request.idempotencyKey,
    amountCents: request.amountCents,
  });
}
