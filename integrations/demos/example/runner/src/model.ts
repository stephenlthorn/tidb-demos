export type ModelState = { readonly tick: number; readonly burstTicksLeft: number; readonly stored: number };

export const BASE_RATE = 200;
export const TOTAL_TICKS = 60;
export const initialModel: ModelState = { tick: 0, burstTicksLeft: 0, stored: 0 };

const PHASES: readonly { readonly until: number; readonly id: string }[] = [
  { until: 10, id: 'warmup' },
  { until: 30, id: 'steady' },
  { until: 45, id: 'burst' },
  { until: Number.POSITIVE_INFINITY, id: 'verify' },
];

export const phaseFor = (tick: number): string => PHASES.find((phase) => tick < phase.until)?.id ?? 'verify';

export const rateFor = (state: ModelState): number => {
  const ramp = Math.min(1, (state.tick + 1) / 10);
  return Math.round(BASE_RATE * ramp * (state.burstTicksLeft > 0 ? 10 : 1));
};

export const startBurst = (state: ModelState): ModelState => ({ ...state, burstTicksLeft: 10 });

export const step = (state: ModelState): ModelState => ({
  tick: state.tick + 1,
  burstTicksLeft: Math.max(0, state.burstTicksLeft - 1),
  stored: state.stored + rateFor(state),
});

const pseudoRandom = (n: number): number => {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
};

export const latencySamples = (rate: number, seed: number, count = 50): readonly number[] =>
  Array.from({ length: count }, (_, index) => 4 + (rate / 1000) * 6 + pseudoRandom(seed * 100 + index) * 3);
