import type { Pool } from 'mysql2/promise';

export type WorkloadHandle = { readonly stop: () => void };

export type WorkloadOptions = { readonly pool: Pool; readonly intervalMs: number };

const ensureSchema = async (pool: Pool): Promise<void> => {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS lab_orders (id BIGINT PRIMARY KEY AUTO_RANDOM, customer_id BIGINT, amount_cents INT, notes VARCHAR(200))',
  );
};

export const startWorkload = async ({ pool, intervalMs }: WorkloadOptions): Promise<WorkloadHandle> => {
  await ensureSchema(pool);
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const customerId = Math.floor(Math.random() * 10_000);
    await pool.query('INSERT INTO lab_orders (customer_id, amount_cents, notes) VALUES (?, ?, ?)', [
      customerId,
      Math.floor(Math.random() * 100_000),
      'steady-state',
    ]);
    await pool.query('SELECT * FROM lab_orders WHERE customer_id = ?', [customerId]);
    setTimeout(() => {
      void tick();
    }, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
    },
  };
};

export const stopWorkload = (handle: WorkloadHandle): void => handle.stop();
