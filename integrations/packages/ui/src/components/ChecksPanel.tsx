import type { CheckStatus, DemoManifest } from '@lab/contract';
import type { DemoState } from '../state/demo-state';

const TONES: Record<CheckStatus, { readonly tone: string; readonly glyph: string }> = {
  pass: { tone: 'fresh', glyph: '●' },
  fail: { tone: 'warn', glyph: '✕' },
  pending: { tone: 'stale', glyph: '○' },
};

export const ChecksPanel = ({ manifest, state }: { readonly manifest: DemoManifest; readonly state: DemoState }) => (
  <section className="panel checks" aria-label="Correctness checks">
    <p className="panel-label">Checks</p>
    <ul>
      {manifest.checks.map((check) => {
        const current = state.checks[check.id];
        const status = current?.status ?? 'pending';
        return (
          <li key={check.id} data-status={status} title={check.description}>
            <span className="pill" data-tone={TONES[status].tone}>
              <span aria-hidden="true">{TONES[status].glyph}</span>
              <span>{status.toUpperCase()}</span>
            </span>
            <span className="check-label">{check.label}</span>
            {current?.observed === undefined ? null : <span className="check-observed">{current.observed}</span>}
          </li>
        );
      })}
    </ul>
  </section>
);
