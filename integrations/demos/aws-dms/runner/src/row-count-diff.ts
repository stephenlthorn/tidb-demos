export type RowCountDiffOptions = {
  readonly sourceCount: number;
  readonly targetCount: number;
};

export const rowCountDiff = (options: RowCountDiffOptions): number =>
  Math.abs(options.sourceCount - options.targetCount);
