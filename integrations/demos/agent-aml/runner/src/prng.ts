export type Rng = {
  readonly next: () => number;
  readonly int: (minInclusive: number, maxInclusive: number) => number;
  readonly pick: <T>(items: readonly T[]) => T;
  readonly chance: (probability: number) => boolean;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const createRng = (seed: number): Rng => {
  const next = mulberry32(seed);
  const int = (minInclusive: number, maxInclusive: number): number =>
    minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  };
  const chance = (probability: number): boolean => next() < probability;
  return { next, int, pick, chance };
};

export const deriveSeed = (seed: number, label: string): number =>
  [...label].reduce((acc, char) => (Math.imul(acc, 31) + char.charCodeAt(0)) >>> 0, seed >>> 0);
