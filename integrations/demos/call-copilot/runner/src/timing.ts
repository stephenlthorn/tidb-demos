const nonNegativeDelta = (laterMs: number, earlierMs: number, label: string): number => {
  const delta = laterMs - earlierMs;
  if (delta < 0) throw new Error(`${label}: later timestamp is before earlier timestamp`);
  return delta;
};

export const timeToFirstTokenMs = (options: { readonly requestSentMs: number; readonly firstDeltaMs: number }): number =>
  nonNegativeDelta(options.firstDeltaMs, options.requestSentMs, 'timeToFirstTokenMs');

export const suggestionLatencyMs = (options: { readonly utteranceEndMs: number; readonly firstDeltaMs: number }): number =>
  nonNegativeDelta(options.firstDeltaMs, options.utteranceEndMs, 'suggestionLatencyMs');
