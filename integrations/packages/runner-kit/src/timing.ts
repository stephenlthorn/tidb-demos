import type { Clock } from './emitter';

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export const timed = async <T>(
  task: () => Promise<T>,
  clock: Clock = () => performance.now(),
): Promise<{ readonly value: T; readonly ms: number }> => {
  const start = clock();
  const value = await task();
  return { value, ms: clock() - start };
};

export const every = async (options: {
  readonly intervalMs: number;
  readonly task: () => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<void> => {
  while (!options.signal.aborted) {
    const started = performance.now();
    await options.task();
    const remaining = options.intervalMs - (performance.now() - started);
    await sleep(Math.max(remaining, 0), options.signal);
  }
};
