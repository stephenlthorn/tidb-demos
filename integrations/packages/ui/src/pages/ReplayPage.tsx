import { useEffect, useState } from 'react';
import type { CatalogMedia, Trace } from '@lab/contract';
import { DemoView } from '../components/DemoView';
import { EnvironmentBadge } from '../components/EnvironmentBadge';
import { PlayerBar } from '../components/PlayerBar';
import { fetchMedia } from '../data';
import { useReplay } from '../sources/use-replay';

export const ReplayView = ({
  trace,
  media,
  initialPositionMs,
}: {
  readonly trace: Trace;
  readonly media?: CatalogMedia;
  readonly initialPositionMs?: number;
}) => {
  const replay = useReplay(trace, initialPositionMs);
  const labels = new Map(trace.manifest.controls.map((control) => [control.id, control.label]));
  const markers = trace.events.flatMap((event) => (event.type === 'control' ? [{ t: event.t, label: labels.get(event.id) ?? event.id }] : []));
  return (
    <DemoView
      manifest={trace.manifest}
      state={replay.state}
      badge={<EnvironmentBadge trace={trace} />}
      footer={<PlayerBar player={replay.player} markers={markers} onToggle={replay.toggle} onSeek={replay.seekTo} onSpeed={replay.setSpeed} />}
      media={media}
    />
  );
};

type Loaded = { readonly trace: Trace } | { readonly error: string } | undefined;

export const ReplayPage = ({
  id,
  load,
  loadMedia = fetchMedia,
  initialPositionMs,
}: {
  readonly id: string;
  readonly load: (id: string) => Promise<Trace>;
  readonly loadMedia?: (id: string) => Promise<CatalogMedia | undefined>;
  readonly initialPositionMs?: number;
}) => {
  const [loaded, setLoaded] = useState<Loaded>(undefined);
  const [media, setMedia] = useState<CatalogMedia | undefined>(undefined);
  useEffect(() => {
    load(id).then(
      (trace) => setLoaded({ trace }),
      () => setLoaded({ error: `No recording for ${id} yet. Run it live with: pnpm lab run ${id}` }),
    );
  }, [id, load]);
  useEffect(() => {
    let active = true;
    loadMedia(id).then(
      (result) => {
        if (active) setMedia(result);
      },
      () => {
        if (active) setMedia(undefined);
      },
    );
    return () => {
      active = false;
    };
  }, [id, loadMedia]);
  if (loaded === undefined) return <p className="status">Loading recording...</p>;
  if ('error' in loaded) return <p className="status error">{loaded.error}</p>;
  return <ReplayView trace={loaded.trace} media={media} initialPositionMs={initialPositionMs} />;
};
