export const alertsPerMinute = (options: { readonly newAlerts: number; readonly tickWallMs: number }): number =>
  options.tickWallMs <= 0 ? 0 : (options.newAlerts * 60_000) / options.tickWallMs;

export const elapsedSeconds = (startMs: number, endMs: number): number => Math.max(endMs - startMs, 0) / 1000;
