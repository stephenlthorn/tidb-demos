import type { Pool, PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { timed } from '@lab/runner-kit';
import { DASHBOARD_QUERIES } from './dashboardQueries';
import { setIsolationEnginesStatement, type RoutingEngine } from './routing';
import type { Order } from './orderGenerator';

const INSERT_ORDER_SQL =
  'INSERT INTO orders (order_id, region, product_category, amount, is_heartbeat) VALUES (?, ?, ?, ?, ?)';

export const insertOrder = async (pool: Pool, order: Order): Promise<void> => {
  await pool.execute(INSERT_ORDER_SQL, [
    order.orderId,
    order.region,
    order.productCategory,
    order.amount,
    order.isHeartbeat ? 1 : 0,
  ]);
};

export const runDashboardQuerySet = async (
  connection: PoolConnection,
  engine: RoutingEngine,
): Promise<readonly number[]> => {
  await connection.execute(setIsolationEnginesStatement(engine));
  const timings: number[] = [];
  for (const query of DASHBOARD_QUERIES) {
    const { ms } = await timed(() => connection.execute(query.sql));
    timings.push(ms);
  }
  return timings;
};

const HeartbeatVisibleRowsSchema = z.array(z.object({ found: z.coerce.number() }));

export const probeHeartbeatVisible = async (connection: PoolConnection, orderId: string): Promise<boolean> => {
  await connection.execute(setIsolationEnginesStatement('tiflash'));
  const [rows] = await connection.execute('SELECT 1 AS found FROM orders WHERE order_id = ? AND is_heartbeat = 1', [
    orderId,
  ]);
  return HeartbeatVisibleRowsSchema.parse(rows).length > 0;
};

const ReplicaStatusRowsSchema = z.array(
  z.object({
    AVAILABLE: z.coerce.number(),
    PROGRESS: z.coerce.number(),
  }),
);

export type ReplicaStatus = {
  readonly available: boolean;
  readonly progress: number;
};

export const readTiflashReplicaStatus = async (pool: Pool): Promise<ReplicaStatus> => {
  const [rows] = await pool.query(
    "SELECT AVAILABLE, PROGRESS FROM information_schema.tiflash_replica WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'",
  );
  const replica = ReplicaStatusRowsSchema.parse(rows)[0];
  if (replica === undefined) return { available: false, progress: 0 };
  return { available: replica.AVAILABLE === 1, progress: replica.PROGRESS };
};

export const setTiflashReplica = async (pool: Pool, replicaCount: number): Promise<void> => {
  await pool.query(`ALTER TABLE orders SET TIFLASH REPLICA ${replicaCount}`);
};

const TotalRowsSchema = z.array(z.object({ total: z.coerce.number() }));

const snapshotLiteral = (snapshot: Date): string => {
  const iso = snapshot.toISOString();
  if (iso.includes("'") || iso.includes('\\')) throw new Error('unexpected snapshot literal characters');
  return `'${iso.slice(0, 23).replace('T', ' ')}'`;
};

export const readTotalAsOf = async (
  connection: PoolConnection,
  engine: RoutingEngine,
  snapshot: Date,
): Promise<number> => {
  await connection.execute(setIsolationEnginesStatement(engine));
  const [rows] = await connection.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM orders AS OF TIMESTAMP ${snapshotLiteral(snapshot)} WHERE is_heartbeat = 0`,
  );
  return TotalRowsSchema.parse(rows)[0]?.total ?? 0;
};
