const hasSubMillisecondFraction = (value: string): boolean => {
  const extra = /\.\d{3}(\d+)/.exec(value)?.[1];
  return extra !== undefined && /[1-9]/.test(extra);
};

export const rfc3339Second = (value: string | Date): string => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`not a timestamp: ${String(value)}`);
  const exactMs = typeof value === 'string' && hasSubMillisecondFraction(value) ? ms + 0.5 : ms;
  const ceiled = Math.ceil(exactMs / 1000) * 1000;
  return new Date(ceiled).toISOString().replace('.000Z', 'Z');
};
