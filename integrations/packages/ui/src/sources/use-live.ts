import { useEffect, useState } from 'react';
import { parseEventLine, type DemoManifest } from '@lab/contract';
import { fetchRelayManifest } from '../data';
import { initialState, reduceEvent, type DemoState } from '../state/demo-state';

export type LiveStatus = 'connecting' | 'open' | 'error';

export type Live = {
  readonly manifest: DemoManifest | undefined;
  readonly state: DemoState | undefined;
  readonly status: LiveStatus;
  readonly sendControl: (id: string) => void;
};

export const useLive = (relayUrl: string): Live => {
  const [manifest, setManifest] = useState<DemoManifest | undefined>(undefined);
  const [state, setState] = useState<DemoState | undefined>(undefined);
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    const controller = new AbortController();
    const holder: { source?: EventSource } = {};
    fetchRelayManifest(relayUrl, controller.signal).then(
      (loaded) => {
        setManifest(loaded);
        setState(initialState(loaded));
        const source = new EventSource(`${relayUrl}/events`);
        holder.source = source;
        source.onopen = () => setStatus('open');
        source.onerror = () => setStatus('error');
        source.onmessage = (message: MessageEvent<string>) => {
          const parsed = parseEventLine(message.data);
          if (parsed.ok) setState((previous) => (previous === undefined ? previous : reduceEvent(previous, parsed.event)));
        };
      },
      () => setStatus('error'),
    );
    return () => {
      controller.abort();
      holder.source?.close();
    };
  }, [relayUrl]);

  const sendControl = (id: string): void => {
    void fetch(`${relayUrl}/control/${id}`, { method: 'POST' });
  };

  return { manifest, state, status, sendControl };
};
