import type { ManifestPhase } from '@lab/contract';

export const PhaseTimeline = ({ phases, current }: { readonly phases: readonly ManifestPhase[]; readonly current: string | undefined }) => {
  const currentIndex = phases.findIndex((phase) => phase.id === current);
  const reached = currentIndex + 1;
  return (
    <nav className="rail" aria-label="Demo phases">
      <p className="rail-overline">Demo phases</p>
      <div
        className="rail-progress"
        role="progressbar"
        aria-label="Phase progress"
        aria-valuemin={0}
        aria-valuemax={phases.length}
        aria-valuenow={reached}
      >
        <i style={{ width: `${(reached / Math.max(phases.length, 1)) * 100}%` }} />
      </div>
      <ol>
        {phases.map((phase, index) => (
          <li key={phase.id} className="rail-item" aria-current={index === currentIndex ? 'step' : undefined} data-done={String(currentIndex > index)}>
            <span className="marker">{currentIndex > index ? '✓' : String(index + 1)}</span>
            <span className="rail-label">{phase.label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
};
