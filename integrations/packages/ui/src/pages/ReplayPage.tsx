import { useEffect, useState } from 'react';
import type { Trace } from '@lab/contract';
import { DemoView } from '../components/DemoView';
import { EnvironmentBadge } from '../components/EnvironmentBadge';
import { PlayerBar } from '../components/PlayerBar';
import { useReplay } from '../sources/use-replay';

export const ReplayView = ({ trace }: { readonly trace: Trace }) => {
  const replay = useReplay(trace);
  const labels = new Map(trace.manifest.controls.map((control) => [control.id, control.label]));
  const markers = trace.events.flatMap((event) => (event.type === 'control' ? [{ t: event.t, label: labels.get(event.id) ?? event.id }] : []));
  return (
    <DemoView
      manifest={trace.manifest}
      state={replay.state}
      badge={<EnvironmentBadge trace={trace} />}
      footer={<PlayerBar player={replay.player} markers={markers} onToggle={replay.toggle} onSeek={replay.seekTo} onSpeed={replay.setSpeed} />}
    />
  );
};

type Loaded = { readonly trace: Trace } | { readonly error: string } | undefined;

export const ReplayPage = ({ id, load }: { readonly id: string; readonly load: (id: string) => Promise<Trace> }) => {
  const [loaded, setLoaded] = useState<Loaded>(undefined);
  useEffect(() => {
    load(id).then(
      (trace) => setLoaded({ trace }),
      () => setLoaded({ error: `No recording for ${id} yet. Run it live with: pnpm lab run ${id}` }),
    );
  }, [id, load]);
  if (loaded === undefined) return <p className="status">Loading recording...</p>;
  if ('error' in loaded) return <p className="status error">{loaded.error}</p>;
  return <ReplayView trace={loaded.trace} />;
};
