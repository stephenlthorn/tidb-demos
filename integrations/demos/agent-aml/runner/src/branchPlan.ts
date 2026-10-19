export const pointInTimeMs = (options: {
  readonly committedAtMs: number;
  readonly nowMs: number;
}): number => Math.min(options.committedAtMs + 1000, options.nowMs - 2000);
