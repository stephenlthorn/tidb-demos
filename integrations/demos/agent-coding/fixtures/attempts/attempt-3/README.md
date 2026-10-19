# payments-api

A tiny payments service used as a fixture. A charge request carries an idempotency key. Retrying a request with the same key must not record a second charge.

## Idempotency

The ledger exposes `findByKey`. `processCharge` returns the stored charge when the key was already recorded, and the gateway call is retried up to three times.
