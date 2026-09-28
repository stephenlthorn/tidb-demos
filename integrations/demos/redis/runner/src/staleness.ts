export type HitRatioInput = { readonly hits: number; readonly misses: number };
export const computeHitRatioPercent = ({ hits, misses }: HitRatioInput): number => {
  const total = hits + misses;
  if (total === 0) return 0;
  return Math.round((hits / total) * 10_000) / 100;
};

export type StaleReadInput = { readonly cachedVersion: number; readonly tidbVersion: number };
export const isStaleRead = ({ cachedVersion, tidbVersion }: StaleReadInput): boolean =>
  cachedVersion < tidbVersion;

export type VersionMismatchInput = { readonly cachedVersion: number; readonly tidbVersion: number };
export const versionsMismatch = ({ cachedVersion, tidbVersion }: VersionMismatchInput): boolean =>
  cachedVersion !== tidbVersion;

export type InvalidationLagInput = { readonly deletedAtMs: number; readonly writtenAtMs: number };
export const computeInvalidationLagMs = ({ deletedAtMs, writtenAtMs }: InvalidationLagInput): number =>
  Math.max(0, deletedAtMs - writtenAtMs);
