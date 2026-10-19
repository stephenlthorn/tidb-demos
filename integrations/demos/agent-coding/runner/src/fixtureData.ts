import { quoteIdentifier } from '@lab/runner-kit';
import { mulberry32 } from './random';

export type OrderRow = {
  readonly id: number;
  readonly customer: string;
  readonly amountCents: number;
  readonly status: string;
};

const statuses: readonly string[] = ['paid', 'paid', 'paid', 'refunded', 'pending'];

export const generateOrders = (options: { readonly seed: number; readonly count: number }): readonly OrderRow[] => {
  const next = mulberry32(options.seed);
  return Array.from({ length: options.count }, (_, index) => ({
    id: index + 1,
    customer: `cust-${String(Math.floor(next() * 400)).padStart(4, '0')}`,
    amountCents: 500 + Math.floor(next() * 50000),
    status: statuses[Math.floor(next() * statuses.length)] ?? 'paid',
  }));
};

export const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export const orderRowsAsParams = (rows: readonly OrderRow[]): readonly (readonly (string | number)[])[] =>
  rows.map((row) => [row.id, row.customer, row.amountCents, row.status]);

export const fixtureStatements = (database: string): readonly string[] => [
  `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)}`,
  `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(database)}.orders (id INT PRIMARY KEY, customer VARCHAR(40) NOT NULL, amount_cents INT NOT NULL, status VARCHAR(16) NOT NULL)`,
];

export const insertOrdersSql = (database: string, rowCount: number): string =>
  `INSERT IGNORE INTO ${quoteIdentifier(database)}.orders (id, customer, amount_cents, status) VALUES ${Array.from({ length: rowCount }, () => '(?, ?, ?, ?)').join(', ')}`;
