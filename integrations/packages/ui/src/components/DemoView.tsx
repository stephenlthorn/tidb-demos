import type { ReactNode } from 'react';
import type { CatalogMedia, DemoManifest } from '@lab/contract';
import { FlowDiagram } from '../diagram/FlowDiagram';
import type { DemoState } from '../state/demo-state';
import { ChecksPanel } from './ChecksPanel';
import { LogConsole } from './LogConsole';
import { MediaGallery } from './MediaGallery';
import { MetricTile } from './MetricTile';
import { PhaseTimeline } from './PhaseTimeline';

const Narration = ({ manifest, current }: { readonly manifest: DemoManifest; readonly current: string | undefined }) => {
  const index = manifest.phases.findIndex((phase) => phase.id === current);
  const phase = manifest.phases[index];
  return (
    <section className="narration-card" aria-label="What is happening now">
      <p className="eyebrow">{phase === undefined ? 'Not started' : `Phase ${index + 1} of ${manifest.phases.length} · ${phase.label}`}</p>
      <p className="narration">{phase?.narration ?? 'Waiting for the demo to start.'}</p>
    </section>
  );
};

export const DemoView = (props: {
  readonly manifest: DemoManifest;
  readonly state: DemoState;
  readonly badge: ReactNode;
  readonly footer: ReactNode;
  readonly media?: CatalogMedia;
}) => (
  <div className="demo">
    <PhaseTimeline phases={props.manifest.phases} current={props.state.phase} />
    <main className="demo-main">
      <header className="demo-hero">
        <p className="eyebrow">{props.manifest.integrations.join(' · ')}</p>
        <h1>{props.manifest.title}</h1>
        <p className="lead">{props.manifest.tagline}</p>
        {props.badge}
      </header>
      <Narration manifest={props.manifest} current={props.state.phase} />
      <section className="panel flow-panel" aria-label="Data flow">
        <FlowDiagram manifest={props.manifest} state={props.state} />
      </section>
      <section className="metrics" aria-label="Metrics">
        {props.manifest.metrics.map((metric) => (
          <MetricTile key={metric.id} metric={metric} points={props.state.metrics[metric.id] ?? []} />
        ))}
      </section>
      <ChecksPanel manifest={props.manifest} state={props.state} />
      <LogConsole logs={props.state.logs} />
      <MediaGallery media={props.media} />
    </main>
    <footer className="demo-footer">{props.footer}</footer>
  </div>
);
