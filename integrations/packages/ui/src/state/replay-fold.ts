import type { DemoEvent, DemoManifest } from '@lab/contract';
import { initialState, reduceEvent, type DemoState } from './demo-state';

export type Folded = { readonly state: DemoState; readonly cursor: number; readonly positionMs: number };

export const firstIndexAfter = (events: readonly DemoEvent[], t: number, from: number): number => {
  const index = events.findIndex((event, i) => i >= from && event.t > t);
  return index === -1 ? events.length : index;
};

export const foldTo = (
  manifest: DemoManifest,
  events: readonly DemoEvent[],
  previous: Folded | undefined,
  positionMs: number,
): Folded => {
  const base = previous !== undefined && positionMs >= previous.positionMs
    ? previous
    : { state: initialState(manifest), cursor: 0, positionMs: 0 };
  const end = firstIndexAfter(events, positionMs, base.cursor);
  const folded = events.slice(base.cursor, end).reduce(reduceEvent, base.state);
  return { state: { ...folded, t: Math.max(folded.t, positionMs) }, cursor: end, positionMs };
};
