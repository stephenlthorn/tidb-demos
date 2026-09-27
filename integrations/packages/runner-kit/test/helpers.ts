export const clockFrom = (times: readonly number[]): (() => number) => {
  const iterator = times[Symbol.iterator]();
  const last = times[times.length - 1] ?? 0;
  return () => {
    const next = iterator.next();
    return next.done ? last : next.value;
  };
};

export const captureLines = (): { readonly lines: readonly string[]; readonly write: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, write: (line: string) => { lines.push(line); } };
};
