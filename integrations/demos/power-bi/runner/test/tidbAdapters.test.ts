import { describe, expect, it } from 'vitest';
import { readTotalAsOf } from '../src/tidbAdapters';

type RecordedCall = { readonly method: 'execute' | 'query'; readonly sql: string };

const createFakeConnection = (totalRows: readonly { readonly total: number }[]) => {
  const calls: RecordedCall[] = [];
  return {
    calls,
    execute: async (sql: string): Promise<readonly [unknown, unknown]> => {
      calls.push({ method: 'execute', sql });
      return [[], []];
    },
    query: async (sql: string): Promise<readonly [unknown, unknown]> => {
      calls.push({ method: 'query', sql });
      return [totalRows, []];
    },
  };
};

describe('readTotalAsOf', () => {
  it('sets the session time zone to UTC on the same connection before the AS OF TIMESTAMP query', async () => {
    const connection = createFakeConnection([{ total: 42 }]);
    const snapshot = new Date('2024-03-05T12:34:56.789Z');

    const total = await readTotalAsOf(connection, 'tikv', snapshot);

    expect(connection.calls).toEqual([
      { method: 'execute', sql: "SET time_zone = '+00:00'" },
      { method: 'execute', sql: "SET SESSION tidb_isolation_read_engines = 'tikv'" },
      {
        method: 'query',
        sql: "SELECT COALESCE(SUM(amount), 0) AS total FROM orders AS OF TIMESTAMP '2024-03-05 12:34:56.789' WHERE is_heartbeat = 0",
      },
    ]);
    expect(total).toBe(42);
  });

  it('returns 0 when the snapshot has no matching rows', async () => {
    const connection = createFakeConnection([]);

    const total = await readTotalAsOf(connection, 'tiflash', new Date('2024-01-01T00:00:00.000Z'));

    expect(total).toBe(0);
  });
});

describe('readTotalAsOf with connections acquired from a pool', () => {
  const createFakePool = (rowsByEngine: {
    readonly tikv: readonly { readonly total: number }[];
    readonly tiflash: readonly { readonly total: number }[];
  }) => {
    const poolLevelCalls: RecordedCall[] = [];
    const connections = {
      tikv: createFakeConnection(rowsByEngine.tikv),
      tiflash: createFakeConnection(rowsByEngine.tiflash),
    };
    return {
      poolLevelCalls,
      connections,
      getConnection: async (engine: 'tikv' | 'tiflash') => connections[engine],
      query: async (sql: string): Promise<readonly [unknown, unknown]> => {
        poolLevelCalls.push({ method: 'query', sql });
        return [[], []];
      },
    };
  };

  it('keeps the UTC time zone SET and the AS OF query on each engine own dedicated connection', async () => {
    const pool = createFakePool({ tikv: [{ total: 10 }], tiflash: [{ total: 10 }] });
    const snapshot = new Date('2024-06-01T00:00:00.000Z');

    const [tikvConnection, tiflashConnection] = await Promise.all([
      pool.getConnection('tikv'),
      pool.getConnection('tiflash'),
    ]);
    const [tikvTotal, tiflashTotal] = await Promise.all([
      readTotalAsOf(tikvConnection, 'tikv', snapshot),
      readTotalAsOf(tiflashConnection, 'tiflash', snapshot),
    ]);

    expect(tikvTotal).toBe(10);
    expect(tiflashTotal).toBe(10);
    expect(tikvConnection.calls[0]).toEqual({ method: 'execute', sql: "SET time_zone = '+00:00'" });
    expect(tiflashConnection.calls[0]).toEqual({ method: 'execute', sql: "SET time_zone = '+00:00'" });
    expect(tikvConnection.calls.map((call) => call.method)).toEqual(['execute', 'execute', 'query']);
    expect(tiflashConnection.calls.map((call) => call.method)).toEqual(['execute', 'execute', 'query']);
    expect(pool.poolLevelCalls).toEqual([]);
  });
});
