import type { DemoEvent } from '@lab/contract';

export type Hub = {
  readonly publish: (event: DemoEvent) => void;
  readonly events: () => readonly DemoEvent[];
  readonly subscribe: (listener: (event: DemoEvent, index: number) => void) => () => void;
};

export const createHub = (): Hub => {
  const history: DemoEvent[] = [];
  const listeners = new Set<(event: DemoEvent, index: number) => void>();
  return {
    publish: (event) => {
      const index = history.push(event) - 1;
      listeners.forEach((listener) => listener(event, index));
    },
    events: () => [...history],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
