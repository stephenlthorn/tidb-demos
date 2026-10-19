export function createLedger() {
  return { charges: [] };
}

export function record(ledger, charge) {
  ledger.charges.push(charge);
  return charge;
}

export function findByKey(ledger, idempotencyKey) {
  return ledger.charges.find((charge) => charge.idempotencyKey === idempotencyKey);
}
