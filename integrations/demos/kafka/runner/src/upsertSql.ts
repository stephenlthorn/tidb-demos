import { quoteIdentifier } from '@lab/runner-kit';
import type { PaymentEvent } from './paymentEvent';

export type BuiltSql = {
  readonly sql: string;
  readonly params: readonly (string | number)[];
};

const table = 'payments';
const columns = ['payment_id', 'account_id', 'amount_cents', 'currency', 'produce_ts'] as const;

const eventToParams = (event: PaymentEvent): readonly (string | number)[] => [
  event.paymentId,
  event.accountId,
  event.amountCents,
  event.currency,
  event.produceTs,
];

export const buildUpsertSql = (events: readonly PaymentEvent[]): BuiltSql => {
  if (events.length === 0) return { sql: '', params: [] };
  const quotedTable = quoteIdentifier(table);
  const quotedColumns = columns.map((column) => quoteIdentifier(column));
  const valuePlaceholders = events.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
  const updateClause = columns
    .filter((column) => column !== 'payment_id')
    .map((column) => `${quoteIdentifier(column)} = VALUES(${quoteIdentifier(column)})`)
    .join(', ');
  const sql =
    `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES ${valuePlaceholders} ` +
    `ON DUPLICATE KEY UPDATE ${updateClause}`;
  const params = events.flatMap(eventToParams);
  return { sql, params };
};
