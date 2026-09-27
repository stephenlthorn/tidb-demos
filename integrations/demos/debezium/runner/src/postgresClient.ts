import { Pool } from 'pg';
import { z } from 'zod';

const CountRowsSchema = z.array(z.object({ count: z.coerce.number() }));

export type PostgresClient = {
  readonly insertAccounts: (count: number) => Promise<void>;
  readonly upsertHeartbeat: (sourceCommitMs: number) => Promise<void>;
  readonly addRiskTierColumn: () => Promise<void>;
  readonly countAccounts: () => Promise<number>;
};

export const createPostgresClient = (options: { readonly connectionString: string }): PostgresClient => {
  const pool = new Pool({ connectionString: options.connectionString });
  const insertAccounts = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      await pool.query('INSERT INTO accounts (name) VALUES ($1)', [`acct-${Date.now()}-${i}`]);
    }
  };
  const upsertHeartbeat = async (sourceCommitMs: number): Promise<void> => {
    await pool.query(
      'INSERT INTO heartbeat (id, source_commit_ms) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET source_commit_ms = EXCLUDED.source_commit_ms',
      [sourceCommitMs],
    );
  };
  const addRiskTierColumn = async (): Promise<void> => {
    await pool.query('ALTER TABLE accounts ADD COLUMN risk_tier VARCHAR(16)');
  };
  const countAccounts = async (): Promise<number> => {
    const result = await pool.query('SELECT COUNT(*) AS count FROM accounts');
    return CountRowsSchema.parse(result.rows)[0]?.count ?? 0;
  };
  return { insertAccounts, upsertHeartbeat, addRiskTierColumn, countAccounts };
};
