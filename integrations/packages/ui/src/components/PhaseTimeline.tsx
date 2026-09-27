import type { ManifestPhase } from '@lab/contract';

export const PhaseTimeline = ({ phases, current }: { readonly phases: readonly ManifestPhase[]; readonly current: string | undefined }) => {
  const currentIndex = phases.findIndex((phase) => phase.id === current);
  const active = phases[currentIndex];
  return (
    <section className="phases" aria-label="Demo phases">
      <ol>
        {phases.map((phase, index) => (
          <li key={phase.id} aria-current={index === currentIndex ? 'step' : undefined} data-done={String(currentIndex > index)}>
            {`${index + 1}. ${phase.label}`}
          </li>
        ))}
      </ol>
      <p className="narration">{active?.narration ?? 'Waiting for the demo to start.'}</p>
    </section>
  );
};
