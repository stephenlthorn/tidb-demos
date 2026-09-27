import type { CheckStatus, DemoEvent, LogLevel, NodeStatus } from '@lab/contract';

export type Clock = () => number;
export type LineWriter = (line: string) => void;

export type Emitter = {
  readonly metric: (id: string, value: number) => void;
  readonly flow: (edge: string, count: number) => void;
  readonly node: (node: string, status: NodeStatus, note?: string) => void;
  readonly phase: (phase: string) => void;
  readonly check: (id: string, status: CheckStatus, observed?: string) => void;
  readonly log: (level: LogLevel, msg: string, node?: string) => void;
  readonly elapsedMs: () => number;
};

type WithoutTime<E> = E extends DemoEvent ? Omit<E, 't'> : never;
type EventBody = WithoutTime<DemoEvent>;

const stdoutWriter: LineWriter = (line) => {
  process.stdout.write(line);
};

export const createEmitter = (options: { readonly clock?: Clock; readonly write?: LineWriter } = {}): Emitter => {
  const clock = options.clock ?? Date.now;
  const write = options.write ?? stdoutWriter;
  const start = clock();
  const elapsedMs = (): number => clock() - start;
  const emit = (body: EventBody): void => write(`${JSON.stringify({ ...body, t: elapsedMs() })}\n`);
  return {
    metric: (id, value) => emit({ type: 'metric', id, value }),
    flow: (edge, count) => emit({ type: 'flow', edge, count }),
    node: (node, status, note) => emit({ type: 'node', node, status, note }),
    phase: (phase) => emit({ type: 'phase', phase }),
    check: (id, status, observed) => emit({ type: 'check', id, status, observed }),
    log: (level, msg, node) => emit({ type: 'log', level, msg, node }),
    elapsedMs,
  };
};
