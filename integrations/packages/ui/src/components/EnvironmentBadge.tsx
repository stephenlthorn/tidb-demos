import type { Trace } from '@lab/contract';

export const EnvironmentBadge = ({ trace }: { readonly trace: Trace }) => {
  const components = Object.entries(trace.environment.components).map(([name, version]) => `${name} ${version}`);
  return (
    <p className="environment">
      {`Recorded ${trace.recordedAt.slice(0, 10)} on ${trace.environment.tidb}`}
      {components.length === 0 ? '' : ` with ${components.join(', ')}`}
      {trace.environment.notes === '' ? '' : `. ${trace.environment.notes}`}
    </p>
  );
};
