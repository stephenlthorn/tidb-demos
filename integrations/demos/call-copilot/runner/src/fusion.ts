export type FusedRow = { readonly id: string; readonly score: number };

const rankScore = (rank: number, k: number): number => 1 / (k + rank + 1);

export const reciprocalRankFusion = (options: {
  readonly vectorResults: readonly string[];
  readonly fulltextResults: readonly string[];
  readonly k: number;
}): readonly FusedRow[] => {
  const scores = new Map<string, number>();
  options.vectorResults.forEach((id, rank) => {
    scores.set(id, (scores.get(id) ?? 0) + rankScore(rank, options.k));
  });
  options.fulltextResults.forEach((id, rank) => {
    scores.set(id, (scores.get(id) ?? 0) + rankScore(rank, options.k));
  });
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
};
