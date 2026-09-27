export const computeFreshnessLagMs = (heartbeatWrittenAtMs: number, observedAtMs: number): number =>
  Math.max(0, observedAtMs - heartbeatWrittenAtMs);

export const computeFullLoopSeconds = (eventWrittenAtMs: number, scoreWrittenAtMs: number): number =>
  Math.max(0, (scoreWrittenAtMs - eventWrittenAtMs) / 1000);

export const parseDatabricksTimestamp = (value: string): number => {
  const isoLike = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`;
  const parsed = Date.parse(withZone);
  if (Number.isNaN(parsed)) throw new Error(`invalid timestamp: ${value}`);
  return parsed;
};
