export type EvalRow = {
  readonly triggerText: string;
  readonly expectedFactId: string;
};

export type EvalRowResult = {
  readonly triggerText: string;
  readonly expectedFactId: string;
  readonly actualFactId: string | undefined;
  readonly matched: boolean;
};

export type EvalScore = {
  readonly matched: number;
  readonly total: number;
  readonly results: readonly EvalRowResult[];
};

export const scoreHybridEval = (options: {
  readonly rows: readonly EvalRow[];
  readonly topFactIdForTrigger: ReadonlyMap<string, string | undefined>;
}): EvalScore => {
  const results = options.rows.map((row) => {
    const actualFactId = options.topFactIdForTrigger.get(row.triggerText);
    return {
      triggerText: row.triggerText,
      expectedFactId: row.expectedFactId,
      actualFactId,
      matched: actualFactId === row.expectedFactId,
    };
  });
  return {
    matched: results.filter((result) => result.matched).length,
    total: results.length,
    results,
  };
};

export const formatEvalObserved = (score: EvalScore): string => `${score.matched}/${score.total} matched`;
