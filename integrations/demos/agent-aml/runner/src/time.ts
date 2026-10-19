export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const formatDateTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export const formatDateTimeMs = (ms: number): string => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');

export const parseDateTime = (text: string): number => {
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  if (Number.isNaN(parsed)) throw new Error(`unparseable timestamp: ${text}`);
  return parsed;
};

export const weekBucket = (ms: number): number => Math.floor(ms / (7 * DAY_MS));

export const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
