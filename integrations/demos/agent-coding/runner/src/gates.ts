export type Gate =
  | { readonly run: true }
  | { readonly run: false; readonly reason: string };

const allow: Gate = { run: true };
const refuse = (reason: string): Gate => ({ run: false, reason });

export const gateControl = (options: { readonly control: string; readonly done: readonly string[] }): Gate => {
  const has = (stage: string): boolean => options.done.includes(stage);
  switch (options.control) {
    case 'inject-flaky-dependency':
      return has('fan-out') ? refuse('the fan-out already ran; restart the runner and press this first') : allow;
    case 'fan-out':
      return has('fan-out') ? refuse('the fan-out already ran; restart the runner for a new run') : allow;
    case 'replay-failed-step':
      if (!has('fan-out')) return refuse('press fan-out first');
      return has('replay-failed-step') ? refuse('the replay already ran') : allow;
    case 'run-eval':
      if (!has('fan-out')) return refuse('press fan-out first');
      return has('run-eval') ? refuse('the eval already ran') : allow;
    case 'write-lesson':
      if (!has('replay-failed-step')) return refuse('replay the failed step first');
      if (!has('run-eval')) return refuse('run the eval first');
      return has('write-lesson') ? refuse('the lesson is already written') : allow;
    default:
      return refuse(`unknown control: ${options.control}`);
  }
};

export const assertBranchHeadroom = (options: {
  readonly existing: number;
  readonly needed: number;
  readonly quota: number;
}): void => {
  if (options.existing + options.needed <= options.quota) return;
  throw new Error(
    `branch quota exceeded: ${options.existing} existing + ${options.needed} needed is more than ${options.quota}; delete old branches or raise the quota`,
  );
};
