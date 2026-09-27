import { ControlBar } from '../components/ControlBar';
import { DemoView } from '../components/DemoView';
import { useLive } from '../sources/use-live';

export const LivePage = ({ relayUrl }: { readonly relayUrl: string }) => {
  const live = useLive(relayUrl);
  if (live.manifest === undefined || live.state === undefined) {
    return <p className="status">{live.status === 'error' ? `Cannot reach relay at ${relayUrl}. Is pnpm lab run active?` : 'Connecting to relay...'}</p>;
  }
  return (
    <DemoView
      manifest={live.manifest}
      state={live.state}
      badge={<p className="environment live">{`LIVE from ${relayUrl} (${live.status})`}</p>}
      footer={<ControlBar controls={live.manifest.controls} enabled={live.status === 'open'} onControl={live.sendControl} />}
    />
  );
};
