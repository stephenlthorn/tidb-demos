export function authorize(amountCents) {
  if (process.env.GATEWAY_FAULT === 'econnreset') {
    const error = new Error('connect ECONNRESET 10.0.0.7:443');
    error.code = 'ECONNRESET';
    throw error;
  }
  return { authorized: true, amountCents };
}

export function authorizeWithRetry(amountCents, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return authorize(amountCents);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
