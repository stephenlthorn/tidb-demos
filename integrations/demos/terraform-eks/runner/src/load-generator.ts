import { createSampleWindow, summarize, type LatencySummary } from '@lab/runner-kit';

export type LoadGeneratorOptions = {
  readonly targetUrl: string;
  readonly ratePerSecond: number;
};

export type LoadTick = {
  readonly completed: number;
  readonly failed: number;
  readonly latency: LatencySummary | undefined;
};

export const runLoadTick = async (options: LoadGeneratorOptions): Promise<LoadTick> => {
  const window = createSampleWindow();
  let completed = 0;
  let failed = 0;
  const requests = Array.from({ length: options.ratePerSecond }, async () => {
    const start = performance.now();
    try {
      const response = await fetch(options.targetUrl);
      window.add(performance.now() - start);
      if (response.ok) {
        completed += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  });
  await Promise.all(requests);
  return { completed, failed, latency: summarize(window.drain()) };
};
