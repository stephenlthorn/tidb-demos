import type { PoolOptions } from 'mysql2';
import { createPool, type Pool } from 'mysql2/promise';

const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? '4000');
  if (!Number.isInteger(port)) throw new Error('TIDB_PORT must be a number');
  return port;
};

export const tidbConfigFromEnv = (env: NodeJS.ProcessEnv): PoolOptions => {
  const base: PoolOptions = {
    host: env.TIDB_HOST ?? '127.0.0.1',
    port: parsePort(env.TIDB_PORT),
    user: env.TIDB_USER ?? 'root',
    password: env.TIDB_PASSWORD ?? '',
    database: env.TIDB_DATABASE ?? 'lab',
    enableKeepAlive: true,
    supportBigNumbers: true,
  };
  if (env.TIDB_TLS !== 'true') return base;
  return { ...base, ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } };
};

export const createTidbPool = (env: NodeJS.ProcessEnv = process.env): Pool =>
  createPool({ ...tidbConfigFromEnv(env), connectionLimit: Number(env.TIDB_POOL_SIZE ?? '10') });

export const quoteIdentifier = (name: string): string => `\`${name.replaceAll('`', '``')}\``;
