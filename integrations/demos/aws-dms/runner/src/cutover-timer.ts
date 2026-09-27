export type CutoverTimerOptions = {
  readonly stoppedAtMs: number;
  readonly confirmedAtMs: number;
};

export const cutoverDowntimeSeconds = (options: CutoverTimerOptions): number =>
  Math.round(((options.confirmedAtMs - options.stoppedAtMs) / 1000) * 10) / 10;
