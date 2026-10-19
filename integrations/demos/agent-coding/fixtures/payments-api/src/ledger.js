export function createLedger() {
  return { charges: [] };
}

export function record(ledger, charge) {
  ledger.charges.push(charge);
  return charge;
}
