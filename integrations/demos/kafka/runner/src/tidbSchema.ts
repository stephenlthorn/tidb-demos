import type { Pool } from 'mysql2/promise';
import { quoteIdentifier } from '@lab/runner-kit';

export const ensurePaymentsTable = async (pool: Pool, tableName: string = 'payments'): Promise<void> => {
  const table = quoteIdentifier(tableName);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
      payment_id VARCHAR(32) PRIMARY KEY,
      account_id VARCHAR(32) NOT NULL,
      amount_cents BIGINT NOT NULL,
      currency VARCHAR(8) NOT NULL,
      produce_ts BIGINT NOT NULL
    )`,
  );
};
