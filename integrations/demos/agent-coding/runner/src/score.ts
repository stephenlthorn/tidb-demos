export type AttemptResult = {
  readonly attemptId: string;
  readonly passed: boolean;
  readonly changedFiles: number;
  readonly steps: number;
};

export const scoreAttempt = (result: Omit<AttemptResult, 'attemptId'>): number =>
  result.passed ? Math.max(0, 100 - 10 * result.changedFiles - result.steps) : 0;

export const pickWinner = (results: readonly AttemptResult[]): AttemptResult | undefined =>
  results
    .filter((result) => result.passed)
    .reduce<AttemptResult | undefined>((best, result) => {
      if (best === undefined) return result;
      const gap = scoreAttempt(result) - scoreAttempt(best);
      if (gap > 0) return result;
      if (gap < 0) return best;
      return result.attemptId < best.attemptId ? result : best;
    }, undefined);

export const pickReplayTarget = (
  halted: readonly { readonly attemptId: string; readonly haltedAtStep: number }[],
): { readonly attemptId: string; readonly haltedAtStep: number } | undefined =>
  halted.reduce<{ readonly attemptId: string; readonly haltedAtStep: number } | undefined>((best, item) => {
    if (best === undefined) return item;
    if (item.haltedAtStep > best.haltedAtStep) return item;
    if (item.haltedAtStep < best.haltedAtStep) return best;
    return item.attemptId < best.attemptId ? item : best;
  }, undefined);
