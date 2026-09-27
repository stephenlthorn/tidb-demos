import { describe, expect, it } from 'vitest';
import { ORDERS_TABLE_DDL } from '../src/schema';

describe('ORDERS_TABLE_DDL', () => {
  it('creates the columns every dashboard query and check depends on', () => {
    expect(ORDERS_TABLE_DDL).toContain('order_id VARCHAR(32) NOT NULL');
    expect(ORDERS_TABLE_DDL).toContain('is_heartbeat TINYINT NOT NULL DEFAULT 0');
    expect(ORDERS_TABLE_DDL).toContain('PRIMARY KEY (order_id)');
  });
});
