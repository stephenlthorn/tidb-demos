import { parseEventLine, parseSseId, type DemoManifest } from '@lab/contract';
import { initialState, reduceEvent, type DemoState } from '../state/demo-state';

export type LiveState = { readonly runId: string | undefined; readonly state: DemoState };

export const applyLiveMessage = (manifest: DemoManifest, current: LiveState, lastEventId: string, data: string): LiveState => {
  const parsed = parseEventLine(data);
  if (!parsed.ok) return current;
  const runId = parseSseId(lastEventId)?.runId;
  const base = runId !== undefined && current.runId !== undefined && runId !== current.runId ? initialState(manifest) : current.state;
  return { runId: runId ?? current.runId, state: reduceEvent(base, parsed.event) };
};
