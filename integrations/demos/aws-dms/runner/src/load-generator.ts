import { every } from '@lab/runner-kit';
import { currentWriteRate } from './workload';
import type { PgClient } from './pg-client';

export type LoadGenerator = {
  readonly start: (signal: AbortSignal) => Promise<void>;
  readonly burst: () => void;
  readonly stop: () => void;
};

export type CreateLoadGeneratorOptions = {
  readonly pgClient: PgClient;
  readonly baselineRowsPerTick: number;
  readonly burstMultiplier: number;
  readonly burstDurationMs: number;
  readonly onTick?: (rowsInserted: number) => void;
};

export const createLoadGenerator = (options: CreateLoadGeneratorOptions): LoadGenerator => {
  let burstUntilMs: number | undefined;
  let stopped = false;

  const burst = (): void => {
    burstUntilMs = Date.now() + options.burstDurationMs;
  };

  const stop = (): void => {
    stopped = true;
  };

  const start = async (signal: AbortSignal): Promise<void> => {
    await every({
      intervalMs: 1000,
      signal,
      task: async () => {
        if (stopped) return;
        const rate = currentWriteRate({
          baselineRowsPerTick: options.baselineRowsPerTick,
          burstUntilMs,
          burstMultiplier: options.burstMultiplier,
          nowMs: Date.now(),
        });
        await options.pgClient.insertAccountsAndOrders(rate);
        options.onTick?.(rate);
      },
    });
  };

  return { start, burst, stop };
};
