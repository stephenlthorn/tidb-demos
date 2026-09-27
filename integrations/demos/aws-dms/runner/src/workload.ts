export type IsBurstActiveOptions = {
  readonly burstUntilMs: number | undefined;
  readonly nowMs: number;
};

export const isBurstActive = (options: IsBurstActiveOptions): boolean =>
  options.burstUntilMs !== undefined && options.nowMs < options.burstUntilMs;

export type CurrentWriteRateOptions = {
  readonly baselineRowsPerTick: number;
  readonly burstUntilMs: number | undefined;
  readonly burstMultiplier: number;
  readonly nowMs: number;
};

export const currentWriteRate = (options: CurrentWriteRateOptions): number =>
  isBurstActive({ burstUntilMs: options.burstUntilMs, nowMs: options.nowMs })
    ? options.baselineRowsPerTick * options.burstMultiplier
    : options.baselineRowsPerTick;
