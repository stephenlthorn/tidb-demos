import { describe, expect, it } from 'vitest';
import { isolationEnginesFor, setIsolationEnginesStatement } from '../src/routing';

describe('isolationEnginesFor', () => {
  it('returns only tikv for the tikv engine', () => {
    expect(isolationEnginesFor('tikv')).toEqual(['tikv']);
  });

  it('returns only tiflash for the tiflash engine', () => {
    expect(isolationEnginesFor('tiflash')).toEqual(['tiflash']);
  });
});

describe('setIsolationEnginesStatement', () => {
  it('builds the exact SQL to force tikv', () => {
    expect(setIsolationEnginesStatement('tikv')).toBe(
      "SET SESSION tidb_isolation_read_engines = 'tikv'",
    );
  });

  it('builds the exact SQL to force tiflash', () => {
    expect(setIsolationEnginesStatement('tiflash')).toBe(
      "SET SESSION tidb_isolation_read_engines = 'tiflash'",
    );
  });
});
