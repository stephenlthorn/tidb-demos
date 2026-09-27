export type InvalidationMode = 'ttl' | 'cdc';

export type DemoState = {
  readonly invalidationMode: InvalidationMode;
  readonly hotKeyStormUntilMs: number;
};

export const initialDemoState = (): DemoState => ({ invalidationMode: 'ttl', hotKeyStormUntilMs: 0 });

export type ControlInput =
  | { readonly id: 'toggle-mode'; readonly nowMs: number }
  | { readonly id: 'hot-key-storm'; readonly nowMs: number; readonly hotKeyStormDurationMs: number }
  | { readonly id: 'write-burst'; readonly nowMs: number };

const flip = (mode: InvalidationMode): InvalidationMode => (mode === 'ttl' ? 'cdc' : 'ttl');

export const applyControl = (state: DemoState, control: ControlInput): DemoState => {
  if (control.id === 'toggle-mode') {
    return { ...state, invalidationMode: flip(state.invalidationMode) };
  }
  if (control.id === 'hot-key-storm') {
    return { ...state, hotKeyStormUntilMs: control.nowMs + control.hotKeyStormDurationMs };
  }
  return state;
};

export const isHotKeyStormActive = (state: DemoState, nowMs: number): boolean =>
  nowMs < state.hotKeyStormUntilMs;
