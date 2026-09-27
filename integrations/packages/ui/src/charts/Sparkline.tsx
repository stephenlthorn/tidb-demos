import type { SeriesPoint } from '../state/demo-state';
import { downsample, seriesPath } from './path';

const SIZE = { width: 160, height: 40 } as const;

export const Sparkline = ({ points }: { readonly points: readonly SeriesPoint[] }) => (
  <svg className="spark" viewBox={`0 0 ${SIZE.width} ${SIZE.height}`} preserveAspectRatio="none" aria-hidden="true">
    <path d={seriesPath(downsample(points, 120), SIZE)} />
  </svg>
);
