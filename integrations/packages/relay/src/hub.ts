import type { DemoEvent } from '@lab/contract';

export type Hub = {
  readonly publish: (event: DemoEvent) => void;
  readonly events: () => readonly DemoEvent[];
  readonly subscribe: (listener: (event: DemoEvent) => void) => () => void;
};

export const createHub = (): Hub => {
  const history: DemoEvent[] = [];
  const listeners = new Set<(event: DemoEvent) => void>();
  return {
    publish: (event) => {
      history.push(event);
      listeners.forEach((listener) => listener(event));
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
