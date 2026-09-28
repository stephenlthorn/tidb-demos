export type WorkloadPool = {
  query(sql: string, values?: unknown[]): Promise<unknown>;
};

export type WorkloadHandle = {
  readonly stop: () => void;
  readonly completedQueries: () => number;
  readonly errors: () => number;
};

export type WorkloadOptions = { readonly pool: WorkloadPool; readonly intervalMs: number };

const ensureSchema = async (pool: WorkloadPool): Promise<void> => {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS lab_orders (id BIGINT PRIMARY KEY AUTO_RANDOM, customer_id BIGINT, amount_cents INT, notes VARCHAR(200))',
  );
};

export const startWorkload = async ({ pool, intervalMs }: WorkloadOptions): Promise<WorkloadHandle> => {
  await ensureSchema(pool);
  let stopped = false;
  let completedQueries = 0;
  let errors = 0;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const customerId = Math.floor(Math.random() * 10_000);
      await pool.query('INSERT INTO lab_orders (customer_id, amount_cents, notes) VALUES (?, ?, ?)', [
        customerId,
        Math.floor(Math.random() * 100_000),
        'steady-state',
      ]);
      completedQueries += 1;
      await pool.query('SELECT * FROM lab_orders WHERE customer_id = ?', [customerId]);
      completedQueries += 1;
    } catch {
      errors += 1;
    }
    setTimeout(() => {
      void tick();
    }, intervalMs);
  };
  setTimeout(() => {
    void tick();
  }, intervalMs);
  return {
    stop: () => {
      stopped = true;
    },
    completedQueries: () => completedQueries,
    errors: () => errors,
  };
};

export const stopWorkload = (handle: WorkloadHandle): void => handle.stop();
