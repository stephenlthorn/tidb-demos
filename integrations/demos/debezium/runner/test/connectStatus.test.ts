import { describe, expect, it } from 'vitest';
import { summarizeConnectorStatus } from '../src/connectStatus';

describe('summarizeConnectorStatus', () => {
  it('returns 1 when every task is RUNNING', () => {
    const status = { connector: { state: 'RUNNING' }, tasks: [{ id: 0, state: 'RUNNING' }, { id: 1, state: 'RUNNING' }] };
    expect(summarizeConnectorStatus(status)).toBe(1);
  });

  it('returns 0 when any task is not RUNNING', () => {
    const status = { connector: { state: 'RUNNING' }, tasks: [{ id: 0, state: 'RUNNING' }, { id: 1, state: 'FAILED' }] };
    expect(summarizeConnectorStatus(status)).toBe(0);
  });

  it('returns 0 when there are no tasks', () => {
    expect(summarizeConnectorStatus({ connector: { state: 'RUNNING' }, tasks: [] })).toBe(0);
  });
});
