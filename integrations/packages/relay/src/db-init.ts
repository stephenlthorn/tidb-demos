import { createConnection } from 'mysql2/promise';
import { z } from 'zod';
import { quoteIdentifier, tidbConfigFromEnv } from '@lab/runner-kit';

const VersionRowsSchema = z.array(z.object({ version: z.string() }));

export const createDatabaseSql = (name: string): string => `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(name)}`;

export const runDbInit = async (env: NodeJS.ProcessEnv): Promise<{ readonly database: string; readonly version: string }> => {
  const database = env.TIDB_DATABASE ?? 'lab';
  const connection = await createConnection({ ...tidbConfigFromEnv(env), database: undefined });
  try {
    await connection.query(createDatabaseSql(database));
    const [rows] = await connection.query('SELECT VERSION() AS version');
    return { database, version: VersionRowsSchema.parse(rows)[0]?.version ?? 'unknown' };
  } finally {
    await connection.end();
  }
};
