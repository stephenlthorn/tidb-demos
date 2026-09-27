export type TableProgress = {
  readonly tableName: string;
  readonly fullLoadRows: number;
  readonly appliedInserts: number;
  readonly appliedUpdates: number;
  readonly appliedDeletes: number;
  readonly validationFailedRecords: number;
  readonly tableState: string;
  readonly isFullLoadComplete: boolean;
};

type RawTableStatistic = {
  readonly TableName?: string;
  readonly FullLoadRows?: number;
  readonly AppliedInserts?: number;
  readonly AppliedUpdates?: number;
  readonly AppliedDeletes?: number;
  readonly ValidationFailedRecords?: number;
  readonly TableState?: string;
};

type RawDescribeTableStatisticsResponse = {
  readonly TableStatistics?: readonly RawTableStatistic[];
};

const FULL_LOAD_COMPLETE_STATES = new Set(['Table completed']);

export const parseTableStatistics = (response: RawDescribeTableStatisticsResponse): readonly TableProgress[] =>
  (response.TableStatistics ?? []).map((raw) => ({
    tableName: raw.TableName ?? '',
    fullLoadRows: raw.FullLoadRows ?? 0,
    appliedInserts: raw.AppliedInserts ?? 0,
    appliedUpdates: raw.AppliedUpdates ?? 0,
    appliedDeletes: raw.AppliedDeletes ?? 0,
    validationFailedRecords: raw.ValidationFailedRecords ?? 0,
    tableState: raw.TableState ?? '',
    isFullLoadComplete: FULL_LOAD_COMPLETE_STATES.has(raw.TableState ?? ''),
  }));

export type TableProgressPercentOptions = {
  readonly fullLoadRows: number;
  readonly sourceRowCount: number;
};

export const tableProgressPercent = (options: TableProgressPercentOptions): number => {
  if (options.sourceRowCount === 0) return 0;
  return Math.min(100, Math.round((options.fullLoadRows / options.sourceRowCount) * 100));
};
