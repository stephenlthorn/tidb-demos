export type SseId = { readonly runId: string; readonly index: number };

export const formatSseId = (runId: string, index: number): string => `${runId}.${index}`;

export const parseSseId = (id: string | undefined): SseId | undefined => {
  const match = /^([a-z0-9]+)\.(\d+)$/.exec(id ?? '');
  const runId = match?.[1];
  const index = match?.[2];
  if (runId === undefined || index === undefined) return undefined;
  return { runId, index: Number(index) };
};
