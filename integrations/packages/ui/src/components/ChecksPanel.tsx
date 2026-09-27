import type { DemoManifest } from '@lab/contract';
import type { DemoState } from '../state/demo-state';

export const ChecksPanel = ({ manifest, state }: { readonly manifest: DemoManifest; readonly state: DemoState }) => (
  <section className="checks" aria-label="Correctness checks">
    <h2>Checks</h2>
    <ul>
      {manifest.checks.map((check) => {
        const current = state.checks[check.id];
        const status = current?.status ?? 'pending';
        return (
          <li key={check.id} data-status={status} title={check.description}>
            <span className="check-status">{status.toUpperCase()}</span>
            <span className="check-label">{check.label}</span>
            {current?.observed === undefined ? null : <span className="check-observed">{current.observed}</span>}
          </li>
        );
      })}
    </ul>
  </section>
);
