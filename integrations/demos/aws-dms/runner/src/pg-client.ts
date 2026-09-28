import { Pool } from 'pg';
import { buildChecksumQuery, quotePostgresIdentifier, type ChecksumColumn } from './checksum';

export type PgClient = {
  readonly insertHeartbeat: () => Promise<{ readonly heartbeatId: number; readonly insertedAtMs: number }>;
  readonly countRows: (table: string) => Promise<number>;
  readonly runChecksum: (options: {
    readonly table: string;
    readonly primaryKey: string;
    readonly columns: readonly ChecksumColumn[];
  }) => Promise<number>;
  readonly insertAccountsAndOrders: (rowsPerTick: number) => Promise<void>;
  readonly close: () => Promise<void>;
};

type HeartbeatRow = { readonly heartbeat_id: number; readonly inserted_at: Date };
type CountRow = { readonly count: string };
type ChecksumRow = { readonly checksum: string };

export const createPgClient = (env: NodeJS.ProcessEnv = process.env): PgClient => {
  const pool = new Pool({
    host: env.PG_HOST,
    port: Number(env.PG_PORT ?? 5432),
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE,
    ssl: env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  const insertHeartbeat = async (): Promise<{ readonly heartbeatId: number; readonly insertedAtMs: number }> => {
    const result = await pool.query<HeartbeatRow>(
      'INSERT INTO heartbeat (inserted_at) VALUES (now()) RETURNING heartbeat_id, inserted_at',
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('heartbeat insert returned no row');
    return { heartbeatId: row.heartbeat_id, insertedAtMs: row.inserted_at.getTime() };
  };

  const countRows = async (table: string): Promise<number> => {
    const result = await pool.query<CountRow>(`SELECT COUNT(*) AS count FROM ${quotePostgresIdentifier(table)}`);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`count query returned no row for table ${table}`);
    return Number(row.count);
  };

  const runChecksum = async (options: {
    readonly table: string;
    readonly primaryKey: string;
    readonly columns: readonly ChecksumColumn[];
  }): Promise<number> => {
    const query = buildChecksumQuery({
      dialect: 'postgres',
      table: options.table,
      primaryKey: options.primaryKey,
      columns: options.columns,
    });
    const result = await pool.query<ChecksumRow>(query);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`checksum query returned no row for table ${options.table}`);
    return Number(row.checksum);
  };

  const insertAccountsAndOrders = async (rowsPerTick: number): Promise<void> => {
    await pool.query(
      `INSERT INTO accounts (display_name, is_active, risk_tags, metadata)
       SELECT 'acct-' || g, true, '{}', '{}'::jsonb FROM generate_series(1, $1) AS g`,
      [Math.max(1, Math.floor(rowsPerTick / 5))],
    );
    await pool.query(
      `INSERT INTO orders (account_id, amount, currency, status)
       SELECT (SELECT account_id FROM accounts ORDER BY random() LIMIT 1), (random() * 500)::numeric(18,2), 'USD', 'placed'
       FROM generate_series(1, $1) AS g`,
      [rowsPerTick],
    );
  };

  const close = async (): Promise<void> => {
    await pool.end();
  };

  return { insertHeartbeat, countRows, runChecksum, insertAccountsAndOrders, close };
};
