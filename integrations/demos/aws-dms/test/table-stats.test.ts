import { describe, expect, it } from 'vitest';
import { parseTableStatistics, tableProgressPercent } from '../runner/src/table-stats';

const sampleResponse = {
  TableStatistics: [
    {
      TableName: 'orders',
      SchemaName: 'lab',
      FullLoadRows: 8000,
      AppliedInserts: 120,
      AppliedUpdates: 4,
      AppliedDeletes: 0,
      ValidationFailedRecords: 0,
      TableState: 'Table completed',
    },
    {
      TableName: 'accounts',
      SchemaName: 'lab',
      FullLoadRows: 500,
      AppliedInserts: 2,
      AppliedUpdates: 0,
      AppliedDeletes: 0,
      ValidationFailedRecords: 1,
      TableState: 'Full load',
    },
  ],
};

describe('parseTableStatistics', () => {
  it('extracts a normalized per-table progress record for every table', () => {
    const parsed = parseTableStatistics(sampleResponse);
    expect(parsed).toEqual([
      {
        tableName: 'orders',
        fullLoadRows: 8000,
        appliedInserts: 120,
        appliedUpdates: 4,
        appliedDeletes: 0,
        validationFailedRecords: 0,
        tableState: 'Table completed',
        isFullLoadComplete: true,
      },
      {
        tableName: 'accounts',
        fullLoadRows: 500,
        appliedInserts: 2,
        appliedUpdates: 0,
        appliedDeletes: 0,
        validationFailedRecords: 1,
        tableState: 'Full load',
        isFullLoadComplete: false,
      },
    ]);
  });

  it('returns an empty array for a response with no TableStatistics field', () => {
    expect(parseTableStatistics({})).toEqual([]);
  });

  it('defaults missing numeric fields to zero rather than throwing', () => {
    const parsed = parseTableStatistics({ TableStatistics: [{ TableName: 'heartbeat', TableState: 'Table completed' }] });
    expect(parsed[0]).toEqual({
      tableName: 'heartbeat',
      fullLoadRows: 0,
      appliedInserts: 0,
      appliedUpdates: 0,
      appliedDeletes: 0,
      validationFailedRecords: 0,
      tableState: 'Table completed',
      isFullLoadComplete: true,
    });
  });
});

describe('tableProgressPercent', () => {
  it('computes percent complete against a known source row count', () => {
    expect(tableProgressPercent({ fullLoadRows: 250, sourceRowCount: 1000 })).toBe(25);
  });

  it('caps at 100 when fullLoadRows exceeds sourceRowCount (late-arriving CDC rows during full load)', () => {
    expect(tableProgressPercent({ fullLoadRows: 1050, sourceRowCount: 1000 })).toBe(100);
  });

  it('returns 0 when sourceRowCount is 0 rather than dividing by zero', () => {
    expect(tableProgressPercent({ fullLoadRows: 0, sourceRowCount: 0 })).toBe(0);
  });
});
