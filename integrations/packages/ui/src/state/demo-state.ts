import type { CheckStatus, DemoEvent, DemoManifest, NodeStatus } from '@lab/contract';

export type SeriesPoint = { readonly t: number; readonly value: number };
export type FlowSample = { readonly t: number; readonly count: number };
export type LogEntry = Extract<DemoEvent, { type: 'log' }>;
export type ControlEntry = Extract<DemoEvent, { type: 'control' }>;
export type CheckState = { readonly status: CheckStatus; readonly observed: string | undefined };

export type DemoState = {
  readonly t: number;
  readonly phase: string | undefined;
  readonly nodes: Readonly<Record<string, NodeStatus>>;
  readonly nodeNotes: Readonly<Record<string, string>>;
  readonly metrics: Readonly<Record<string, readonly SeriesPoint[]>>;
  readonly flows: Readonly<Record<string, readonly FlowSample[]>>;
  readonly checks: Readonly<Record<string, CheckState>>;
  readonly logs: readonly LogEntry[];
  readonly controls: readonly ControlEntry[];
};

const LOG_LIMIT = 200;
const FLOW_LIMIT = 30;

const append = <T>(items: readonly T[] | undefined, item: T, limit = Number.POSITIVE_INFINITY): readonly T[] =>
  [...(items ?? []), item].slice(-limit);

export const initialState = (manifest: DemoManifest): DemoState => ({
  t: 0,
  phase: undefined,
  nodes: Object.fromEntries(manifest.nodes.map((node) => [node.id, 'idle'])),
  nodeNotes: {},
  metrics: {},
  flows: {},
  checks: Object.fromEntries(manifest.checks.map((check) => [check.id, { status: 'pending', observed: undefined }])),
  logs: [],
  controls: [],
});

export const reduceEvent = (state: DemoState, event: DemoEvent): DemoState => {
  const next = { ...state, t: Math.max(state.t, event.t) };
  switch (event.type) {
    case 'metric':
      return { ...next, metrics: { ...state.metrics, [event.id]: append(state.metrics[event.id], { t: event.t, value: event.value }) } };
    case 'flow':
      return { ...next, flows: { ...state.flows, [event.edge]: append(state.flows[event.edge], { t: event.t, count: event.count }, FLOW_LIMIT) } };
    case 'node':
      return {
        ...next,
        nodes: { ...state.nodes, [event.node]: event.status },
        nodeNotes: event.note === undefined ? state.nodeNotes : { ...state.nodeNotes, [event.node]: event.note },
      };
    case 'phase':
      return { ...next, phase: event.phase };
    case 'check':
      return { ...next, checks: { ...state.checks, [event.id]: { status: event.status, observed: event.observed } } };
    case 'log':
      return { ...next, logs: append(state.logs, event, LOG_LIMIT) };
    case 'control':
      return { ...next, controls: append(state.controls, event) };
  }
};

export const foldEvents = (
  manifest: DemoManifest,
  events: readonly DemoEvent[],
  untilT = Number.POSITIVE_INFINITY,
): DemoState => events.filter((event) => event.t <= untilT).reduce(reduceEvent, initialState(manifest));
