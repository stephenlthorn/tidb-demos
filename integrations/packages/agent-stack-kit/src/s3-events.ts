export const linesToBody = (lines: readonly string[]): string => `${lines.join('\n')}\n`;

export const toNdjson = (events: readonly object[]): string =>
  events.length === 0 ? '' : linesToBody(events.map((event) => JSON.stringify(event)));

export const eventObjectKey = (options: {
  readonly prefix: string;
  readonly nowMs: number;
  readonly id: string;
}): string => {
  const prefix = options.prefix.replace(/^\/+|\/+$/g, '');
  const stamp = new Date(options.nowMs).toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${options.id}.ndjson`;
  return prefix === '' ? name : `${prefix}/${name}`;
};
