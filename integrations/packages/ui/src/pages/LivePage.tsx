import { useEffect, useState } from 'react';
import type { CatalogMedia } from '@lab/contract';
import { ControlBar } from '../components/ControlBar';
import { DemoView } from '../components/DemoView';
import { fetchMedia } from '../data';
import { useLive } from '../sources/use-live';

export const LivePage = ({
  relayUrl,
  loadMedia = fetchMedia,
}: {
  readonly relayUrl: string;
  readonly loadMedia?: (id: string) => Promise<CatalogMedia | undefined>;
}) => {
  const live = useLive(relayUrl);
  const id = live.manifest?.id;
  const [media, setMedia] = useState<CatalogMedia | undefined>(undefined);
  useEffect(() => {
    if (id === undefined) return undefined;
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
  if (live.manifest === undefined || live.state === undefined) {
    return <p className="status">{live.status === 'error' ? `Cannot reach relay at ${relayUrl}. Is pnpm lab run active?` : 'Connecting to relay...'}</p>;
  }
  return (
    <DemoView
      manifest={live.manifest}
      state={live.state}
      badge={<p className="environment live">{`LIVE from ${relayUrl} (${live.status})`}</p>}
      footer={<ControlBar controls={live.manifest.controls} enabled={live.status === 'open'} onControl={live.sendControl} />}
      media={media}
    />
  );
};
