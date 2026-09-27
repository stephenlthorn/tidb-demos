export const msSincePublished = (publishedIso: string, completedAtMs: number): number => {
  const publishedMs = Date.parse(publishedIso);
  if (Number.isNaN(publishedMs)) {
    throw new Error(`invalid ISO timestamp: ${publishedIso}`);
  }
  return completedAtMs - publishedMs;
};
