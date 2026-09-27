import type { SeriesPoint } from '../state/demo-state';

export const seriesPath = (points: readonly SeriesPoint[], size: { readonly width: number; readonly height: number }): string => {
  if (points.length < 2) return '';
  const times = points.map((point) => point.t);
  const values = points.map((point) => point.value);
  const [tMin, tMax, vMin, vMax] = [Math.min(...times), Math.max(...times), Math.min(...values), Math.max(...values)];
  const x = (t: number): number => (tMax === tMin ? 0 : ((t - tMin) / (tMax - tMin)) * size.width);
  const y = (v: number): number => (vMax === vMin ? size.height / 2 : size.height - ((v - vMin) / (vMax - vMin)) * size.height);
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.t).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
};

export const downsample = (points: readonly SeriesPoint[], maxPoints: number): readonly SeriesPoint[] => {
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / maxPoints);
  return Array.from({ length: Math.ceil(points.length / bucketSize) }, (_, bucket) =>
    points.slice(bucket * bucketSize, (bucket + 1) * bucketSize),
  ).flatMap((bucket) => {
    const peak = bucket.reduce<SeriesPoint | undefined>((best, point) => (best === undefined || point.value > best.value ? point : best), undefined);
    return peak === undefined ? [] : [peak];
  });
};
