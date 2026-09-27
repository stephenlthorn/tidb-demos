import { describe, expect, it } from 'vitest';
import { buildUpsertSql } from '../src/upsertSql';
import type { PaymentEvent } from '../src/paymentEvent';

describe('buildUpsertSql', () => {
  it('builds one idempotent INSERT ... ON DUPLICATE KEY UPDATE statement for a batch', () => {
    const events: readonly PaymentEvent[] = [
      { paymentId: 'payment-000001', accountId: 'acct-1', amountCents: 500, currency: 'USD', produceTs: 1000 },
      { paymentId: 'payment-000002', accountId: 'acct-2', amountCents: 700, currency: 'USD', produceTs: 1001 },
    ];
    const built = buildUpsertSql(events);
    expect(built.sql).toBe(
      'INSERT INTO `payments` (`payment_id`, `account_id`, `amount_cents`, `currency`, `produce_ts`) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE `account_id` = VALUES(`account_id`), `amount_cents` = VALUES(`amount_cents`), `currency` = VALUES(`currency`), `produce_ts` = VALUES(`produce_ts`)',
    );
    expect(built.params).toEqual([
      'payment-000001', 'acct-1', 500, 'USD', 1000,
      'payment-000002', 'acct-2', 700, 'USD', 1001,
    ]);
  });

  it('returns an empty statement for an empty batch', () => {
    const built = buildUpsertSql([]);
    expect(built.sql).toBe('');
    expect(built.params).toEqual([]);
  });

  it('is idempotent: applying the same batch twice produces the same statement and params', () => {
    const events: readonly PaymentEvent[] = [
      { paymentId: 'payment-000001', accountId: 'acct-1', amountCents: 500, currency: 'USD', produceTs: 1000 },
    ];
    expect(buildUpsertSql(events)).toEqual(buildUpsertSql(events));
  });
});
