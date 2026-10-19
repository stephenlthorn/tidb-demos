export function withRetry(task, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return task();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
