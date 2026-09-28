export type CutoverState = 'running' | 'draining' | 'verified' | 'flipped';

export type TransitionResult =
  | { readonly ok: true; readonly state: CutoverState }
  | { readonly ok: false; readonly state: CutoverState; readonly reason: string };

export type CutoverStateMachine = {
  readonly getState: () => CutoverState;
  readonly beginDraining: () => TransitionResult;
  readonly markVerified: () => TransitionResult;
  readonly markFlipped: () => TransitionResult;
};

const attemptTransition = (
  current: CutoverState,
  requiredFrom: CutoverState,
  next: CutoverState,
  actionName: string,
): { readonly next: CutoverState; readonly result: TransitionResult } => {
  if (current !== requiredFrom) {
    return {
      next: current,
      result: { ok: false, state: current, reason: `cannot ${actionName} from ${current}, expected ${requiredFrom}` },
    };
  }
  return { next, result: { ok: true, state: next } };
};

export const createCutoverStateMachine = (): CutoverStateMachine => {
  let state: CutoverState = 'running';

  const beginDraining = (): TransitionResult => {
    const { next, result } = attemptTransition(state, 'running', 'draining', 'beginDraining');
    state = next;
    return result;
  };

  const markVerified = (): TransitionResult => {
    const { next, result } = attemptTransition(state, 'draining', 'verified', 'markVerified');
    state = next;
    return result;
  };

  const markFlipped = (): TransitionResult => {
    const { next, result } = attemptTransition(state, 'verified', 'flipped', 'markFlipped');
    state = next;
    return result;
  };

  return { getState: () => state, beginDraining, markVerified, markFlipped };
};
