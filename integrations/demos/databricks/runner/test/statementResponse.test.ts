import { describe, expect, it } from 'vitest';
import { parseStatementResponse, decidePoll } from '../src/statementResponse';

describe('parseStatementResponse', () => {
  it('extracts rows and row count from a succeeded response', () => {
    const parsed = parseStatementResponse({
      statement_id: 'abc123',
      status: { state: 'SUCCEEDED' },
      result: { data_array: [['2026-09-25 12:00:00.000']], row_count: 1 },
    });
    expect(parsed).toEqual({
      statementId: 'abc123',
      state: 'SUCCEEDED',
      rowCount: 1,
      rows: [['2026-09-25 12:00:00.000']],
      errorMessage: undefined,
    });
  });

  it('extracts the error message from a failed response', () => {
    const parsed = parseStatementResponse({
      statement_id: 'abc123',
      status: { state: 'FAILED', error: { message: 'table not found' } },
    });
    expect(parsed.state).toBe('FAILED');
    expect(parsed.errorMessage).toBe('table not found');
    expect(parsed.rows).toEqual([]);
  });

  it('defaults to FAILED for a response with no recognizable state', () => {
    const parsed = parseStatementResponse({});
    expect(parsed.state).toBe('FAILED');
    expect(parsed.statementId).toBe('');
  });

  it('defaults to FAILED when the payload is not an object at all', () => {
    const parsed = parseStatementResponse('not an object');
    expect(parsed.state).toBe('FAILED');
    expect(parsed.statementId).toBe('');
    expect(parsed.rows).toEqual([]);
  });

  it('ignores an unrecognized state string rather than trust it', () => {
    const parsed = parseStatementResponse({ status: { state: 'BANANA' } });
    expect(parsed.state).toBe('FAILED');
  });

  it('stringifies non-string cell values in a row', () => {
    const parsed = parseStatementResponse({
      status: { state: 'SUCCEEDED' },
      result: { data_array: [[42, null]] },
    });
    expect(parsed.rows).toEqual([['42', 'null']]);
  });
});

describe('decidePoll', () => {
  it('keeps polling while the statement is still running and under the timeout', () => {
    expect(decidePoll('RUNNING', 1000, 60000)).toBe('poll');
  });

  it('is ready once the statement succeeds, even close to the timeout', () => {
    expect(decidePoll('SUCCEEDED', 59999, 60000)).toBe('ready');
  });

  it('fails immediately on a FAILED state regardless of elapsed time', () => {
    expect(decidePoll('FAILED', 100, 60000)).toBe('failed');
  });

  it('times out once elapsed time reaches the timeout while still pending', () => {
    expect(decidePoll('PENDING', 60000, 60000)).toBe('timeout');
  });
});
