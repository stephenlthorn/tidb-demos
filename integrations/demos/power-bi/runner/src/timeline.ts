export type PhaseId =
  | 'intro'
  | 'seed-baseline'
  | 'tiflash-replica'
  | 'dashboard-on-tikv'
  | 'dashboard-on-tiflash'
  | 'freshness-check'
  | 'power-bi-live'
  | 'wrap-up';

export type PhaseSchedule = {
  readonly phase: PhaseId;
  readonly startsAtMs: number;
};

export const PHASE_SCHEDULE: readonly PhaseSchedule[] = [
  { phase: 'intro', startsAtMs: 0 },
  { phase: 'seed-baseline', startsAtMs: 15_000 },
  { phase: 'tiflash-replica', startsAtMs: 45_000 },
  { phase: 'dashboard-on-tikv', startsAtMs: 75_000 },
  { phase: 'dashboard-on-tiflash', startsAtMs: 115_000 },
  { phase: 'freshness-check', startsAtMs: 155_000 },
  { phase: 'power-bi-live', startsAtMs: 195_000 },
  { phase: 'wrap-up', startsAtMs: 225_000 },
];

export const phaseForElapsed = (elapsedMs: number): PhaseId => {
  const reached = PHASE_SCHEDULE.filter((entry) => entry.startsAtMs <= elapsedMs);
  const last = reached[reached.length - 1];
  return last === undefined ? 'intro' : last.phase;
};
