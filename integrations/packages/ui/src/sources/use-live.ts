import { useEffect, useState } from 'react';
import type { DemoManifest } from '@lab/contract';
import { fetchRelayManifest } from '../data';
import { initialState, type DemoState } from '../state/demo-state';
import { applyLiveMessage, type LiveState } from './live-state';

export type LiveStatus = 'connecting' | 'open' | 'error';

export type Live = {
  readonly manifest: DemoManifest | undefined;
  readonly state: DemoState | undefined;
  readonly status: LiveStatus;
  readonly sendControl: (id: string) => void;
};

export const useLive = (relayUrl: string): Live => {
  const [manifest, setManifest] = useState<DemoManifest | undefined>(undefined);
  const [live, setLive] = useState<LiveState | undefined>(undefined);
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    const controller = new AbortController();
    const holder: { source?: EventSource } = {};
    fetchRelayManifest(relayUrl, controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) return;
        setManifest(loaded);
        setLive({ runId: undefined, state: initialState(loaded) });
        const source = new EventSource(`${relayUrl}/events`);
        holder.source = source;
        source.onopen = () => setStatus('open');
        source.onerror = () => setStatus('error');
        source.onmessage = (message: MessageEvent<string>) => {
          setLive((previous) => (previous === undefined ? previous : applyLiveMessage(loaded, previous, message.lastEventId, message.data)));
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

  return { manifest, state: live?.state, status, sendControl };
};
