import type { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { createTableSql } from './schema.sql';

export type CacheRow = {
  readonly id: number;
  readonly payload: string;
  readonly version: number;
  readonly writtenAtMs: number;
};

const CacheRowSchema = z.object({
  id: z.coerce.number(),
  payload: z.string(),
  version: z.coerce.number(),
  writtenAtMs: z.coerce.number(),
});

export const initSchema = async (pool: Pool): Promise<void> => {
  await pool.query(createTableSql);
};

export const seedRows = async (pool: Pool, rowCount: number): Promise<void> => {
  const values = Array.from({ length: rowCount }, (_, index) => [index + 1, 'seed', 1, Date.now()]);
  await pool.query('INSERT IGNORE INTO cache_demo_rows (id, payload, version, written_at_ms) VALUES ?', [values]);
};

export const readRowById = async (pool: Pool, id: number): Promise<CacheRow | undefined> => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, payload, version, written_at_ms AS writtenAtMs FROM cache_demo_rows WHERE id = ?',
    [id],
  );
  const row = rows[0];
  return row === undefined ? undefined : CacheRowSchema.parse(row);
};

export const writeRowById = async (pool: Pool, id: number, payload: string, writtenAtMs: number): Promise<void> => {
  await pool.execute(
    'UPDATE cache_demo_rows SET payload = ?, version = version + 1, written_at_ms = ? WHERE id = ?',
    [payload, writtenAtMs, id],
  );
};
