# payments-api

A tiny payments service used as a fixture. A charge request carries an idempotency key. Retrying a request with the same key must not record a second charge.
