import { authorize } from './gateway.js';
import { record, findByKey } from './ledger.js';
import { withRetry } from './retry.js';

export function processCharge(ledger, request) {
  const existing = findByKey(ledger, request.idempotencyKey);
  if (existing) return existing;
  withRetry(() => authorize(request.amountCents));
  const id = `ch_${ledger.charges.length + 1}`;
  return record(ledger, {
    id,
    idempotencyKey: request.idempotencyKey,
    amountCents: request.amountCents,
  });
}
