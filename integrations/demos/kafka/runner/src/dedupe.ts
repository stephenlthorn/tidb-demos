export type DedupeObservation = {
  readonly isDuplicate: boolean;
  readonly duplicateCount: number;
};

export type DedupeTracker = {
  readonly observe: (key: string) => DedupeObservation;
};

export const createDedupeTracker = (): DedupeTracker => {
  const seen = new Map<string, number>();
  const observe = (key: string): DedupeObservation => {
    const priorCount = seen.get(key) ?? 0;
    seen.set(key, priorCount + 1);
    return priorCount === 0 ? { isDuplicate: false, duplicateCount: 0 } : { isDuplicate: true, duplicateCount: priorCount };
  };
  return { observe };
};
