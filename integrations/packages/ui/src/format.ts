import type { ManifestMetric, MetricUnit } from '@lab/contract';

export const formatRate = (value: number): string => {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toLocaleString('en-US');
};

export const formatValue = (value: number, unit: MetricUnit): string => {
  if (unit === '%') return `${value.toFixed(1)}%`;
  if (unit === 'USD') return `$${value.toFixed(2)}`;
  if (unit === 's') return `${value.toFixed(1)} s`;
  if (unit === 'ms') return value < 10 ? `${value.toFixed(2)} ms` : `${Math.round(value).toLocaleString('en-US')} ms`;
  return `${formatRate(value)} ${unit}`;
};

export const formatClock = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

export const isOnTarget = (metric: ManifestMetric, value: number): boolean | undefined => {
  if (metric.target === undefined || metric.better === 'neutral') return undefined;
  return metric.better === 'higher' ? value >= metric.target : value <= metric.target;
};
