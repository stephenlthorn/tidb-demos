import type { ManifestNode } from '@lab/contract';

export type Point = { readonly x: number; readonly y: number };

export const CANVAS = { width: 1000, height: 560 } as const;

export const NODE_SIZE = { width: 170, height: 64 } as const;

const LANE_PX = 60;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const toCanvas = (node: ManifestNode): Point => ({
  x: clamp((node.x / 100) * CANVAS.width, NODE_SIZE.width / 2, CANVAS.width - NODE_SIZE.width / 2),
  y: clamp((node.y / 100) * CANVAS.height, NODE_SIZE.height / 2, CANVAS.height - NODE_SIZE.height / 2),
});

export const edgePath = (from: Point, to: Point): string => {
  const dx = (to.x - from.x) / 2;
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
};

export const edgeCurve = (from: Point, to: Point, bend: number): { readonly d: string; readonly mid: Point } => {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
  const dx = (to.x - from.x) / 2;
  const first = { x: from.x + dx + normal.x * bend, y: from.y + normal.y * bend };
  const second = { x: to.x - dx + normal.x * bend, y: to.y + normal.y * bend };
  return {
    d: `M ${from.x} ${from.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${to.x} ${to.y}`,
    mid: {
      x: (from.x + 3 * first.x + 3 * second.x + to.x) / 8,
      y: (from.y + 3 * first.y + 3 * second.y + to.y) / 8,
    },
  };
};

type EdgeEnds = { readonly id: string; readonly from: string; readonly to: string };

const pairKey = (edge: EdgeEnds): string => [edge.from, edge.to].sort().join('\u0000');

export const laneBends = (edges: readonly EdgeEnds[]): ReadonlyMap<string, number> => {
  const groups = edges.reduce<ReadonlyMap<string, readonly EdgeEnds[]>>(
    (acc, edge) => new Map([...acc, [pairKey(edge), [...(acc.get(pairKey(edge)) ?? []), edge]]]),
    new Map(),
  );
  return new Map(
    [...groups.values()].flatMap((group) =>
      group.map((edge, index): [string, number] => {
        const bend = (index - (group.length - 1) / 2) * LANE_PX;
        return [edge.id, edge.from <= edge.to || bend === 0 ? bend : -bend];
      }),
    ),
  );
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
