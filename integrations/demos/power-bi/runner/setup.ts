import { createTidbPool } from '@lab/runner-kit';
import { createOrder } from './src/orderGenerator';
import { ORDERS_TABLE_DDL } from './src/schema';
import { insertOrder } from './src/tidbAdapters';

const SEED_ROW_COUNT = 2_000;

const seed = async (): Promise<void> => {
  const pool = createTidbPool(process.env);
  await pool.query(ORDERS_TABLE_DDL);
  for (let sequence = 1; sequence <= SEED_ROW_COUNT; sequence += 1) {
    const order = createOrder({ sequence, randomSource: Math.random });
    await insertOrder(pool, order);
  }
  await pool.end();
  console.log(`seeded ${SEED_ROW_COUNT} orders`);
};

seed().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
