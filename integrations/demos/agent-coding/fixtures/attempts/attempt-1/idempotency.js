export function findExisting(ledger, idempotencyKey) {
  return ledger.charges.find((charge) => charge.idempotencyKey === idempotencyKey);
}
