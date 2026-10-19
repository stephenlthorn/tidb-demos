export const retryUntil = async <T>(options: {
  readonly attempt: () => Promise<T | undefined>;
  readonly tries: number;
  readonly delayMs: number;
  readonly pause: (ms: number) => Promise<void>;
}): Promise<T | undefined> => {
  const result = await options.attempt();
  if (result !== undefined || options.tries <= 1) return result;
  await options.pause(options.delayMs);
  return retryUntil({ ...options, tries: options.tries - 1 });
};
