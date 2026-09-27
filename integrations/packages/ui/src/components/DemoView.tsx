import type { ReactNode } from 'react';
import type { DemoManifest } from '@lab/contract';
import { FlowDiagram } from '../diagram/FlowDiagram';
import type { DemoState } from '../state/demo-state';
import { ChecksPanel } from './ChecksPanel';
import { LogConsole } from './LogConsole';
import { MetricTile } from './MetricTile';
import { PhaseTimeline } from './PhaseTimeline';

export const DemoView = (props: {
  readonly manifest: DemoManifest;
  readonly state: DemoState;
  readonly badge: ReactNode;
  readonly footer: ReactNode;
}) => (
  <div className="demo">
    <header className="demo-header">
      <a href="#/" className="back">All demos</a>
      <h1>{`${String(props.manifest.number).padStart(2, '0')} ${props.manifest.title}`}</h1>
      <p className="tagline">{props.manifest.tagline}</p>
      <ul className="chips">{props.manifest.integrations.map((name) => <li key={name}>{name}</li>)}</ul>
      {props.badge}
    </header>
    <main className="demo-grid">
      <FlowDiagram manifest={props.manifest} state={props.state} />
      <section className="metrics" aria-label="Metrics">
        {props.manifest.metrics.map((metric) => (
          <MetricTile key={metric.id} metric={metric} points={props.state.metrics[metric.id] ?? []} />
        ))}
      </section>
    </main>
    <PhaseTimeline phases={props.manifest.phases} current={props.state.phase} />
    <div className="demo-bottom">
      <ChecksPanel manifest={props.manifest} state={props.state} />
      <LogConsole logs={props.state.logs} />
    </div>
    <footer className="demo-footer">{props.footer}</footer>
  </div>
);
