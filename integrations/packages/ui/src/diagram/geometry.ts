import type { ManifestNode } from '@lab/contract';

export type Point = { readonly x: number; readonly y: number };

export const CANVAS = { width: 1000, height: 560 } as const;

export const toCanvas = (node: ManifestNode): Point => ({
  x: (node.x / 100) * CANVAS.width,
  y: (node.y / 100) * CANVAS.height,
});

export const edgePath = (from: Point, to: Point): string => {
  const dx = (to.x - from.x) / 2;
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
};

export const midpoint = (from: Point, to: Point): Point => ({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });

export const particleSpec = (ratePerSecond: number): { readonly count: number; readonly durationS: number } => {
  if (ratePerSecond <= 0) return { count: 0, durationS: 0 };
  const magnitude = Math.log10(ratePerSecond + 1);
  return {
    count: Math.min(12, Math.max(1, Math.ceil(magnitude * 3))),
    durationS: Math.max(0.6, 3 - magnitude * 0.6),
  };
};
