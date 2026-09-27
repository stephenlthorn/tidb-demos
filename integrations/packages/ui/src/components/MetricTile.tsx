import type { ManifestMetric } from '@lab/contract';
import { Sparkline } from '../charts/Sparkline';
import { formatValue, isOnTarget } from '../format';
import type { SeriesPoint } from '../state/demo-state';

export const MetricTile = ({ metric, points }: { readonly metric: ManifestMetric; readonly points: readonly SeriesPoint[] }) => {
  const latest = points.at(-1)?.value;
  const onTarget = latest === undefined ? undefined : isOnTarget(metric, latest);
  return (
    <figure className="tile" data-on-target={onTarget === undefined ? 'n/a' : String(onTarget)}>
      <figcaption>{metric.label}</figcaption>
      <div className="tile-value">{latest === undefined ? '-' : formatValue(latest, metric.unit)}</div>
      {metric.target === undefined ? null : (
        <div className="tile-target">target {metric.better === 'lower' ? '≤' : '≥'} {formatValue(metric.target, metric.unit)}</div>
      )}
      {metric.display === 'tile' ? null : <Sparkline points={points} />}
      <details className="tile-how">
        <summary>How measured</summary>
        <p>{metric.howMeasured}</p>
      </details>
    </figure>
  );
};
