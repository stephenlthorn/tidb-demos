import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { createTidbPool } from '@lab/runner-kit';

export type Row = Readonly<Record<string, unknown>>;

export type Sql = {
  readonly rows: (sql: string, params?: readonly unknown[]) => Promise<readonly Row[]>;
  readonly insert: (sql: string, params: readonly (string | number)[]) => Promise<number>;
  readonly exec: (sql: string, params?: readonly unknown[]) => Promise<void>;
  readonly end: () => Promise<void>;
};

export const fromMysql = (pool: ReturnType<typeof createTidbPool>): Sql => ({
  rows: async (sql, params = []) => {
    const [rows] = await pool.query<RowDataPacket[]>(sql, [...params]);
    return rows;
  },
  insert: async (sql, params) => {
    const [result] = await pool.execute<ResultSetHeader>(sql, [...params]);
    return result.insertId;
  },
  exec: async (sql, params = []) => {
    await pool.query(sql, [...params]);
  },
  end: () => pool.end(),
});
