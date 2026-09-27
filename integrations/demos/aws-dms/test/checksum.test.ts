import { describe, expect, it } from 'vitest';
import { buildChecksumQuery, normalizedColumnExpression } from '../runner/src/checksum';

describe('normalizedColumnExpression', () => {
  it('wraps a boolean column with dialect-specific 0/1 normalization and NULL handling', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'is_active', type: 'boolean' })).toBe(
      "COALESCE(CASE WHEN \"is_active\" IS NULL THEN NULL WHEN \"is_active\" THEN '1' ELSE '0' END, '\x01__NULL__\x01')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'is_active', type: 'boolean' })).toBe(
      "COALESCE(CAST(`is_active` AS CHAR), '\x01__NULL__\x01')",
    );
  });

  it('never lets a NULL boolean collide with a false boolean on the postgres side', () => {
    const expression = normalizedColumnExpression({ dialect: 'postgres', column: 'is_active', type: 'boolean' });
    expect(expression).toContain('IS NULL THEN NULL');
  });

  it('wraps a timestamp column normalized to UTC with no zone suffix', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'opened_at', type: 'timestamptz' })).toBe(
      "COALESCE(to_char(\"opened_at\" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '\x01__NULL__\x01')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'opened_at', type: 'timestamptz' })).toBe(
      "COALESCE(DATE_FORMAT(`opened_at`, '%Y-%m-%d %H:%i:%s'), '\x01__NULL__\x01')",
    );
  });

  it('wraps a numeric column with a fixed precision/scale cast', () => {
    expect(
      normalizedColumnExpression({ dialect: 'postgres', column: 'amount', type: 'numeric', precision: 18, scale: 2 }),
    ).toBe("COALESCE(CAST(\"amount\" AS NUMERIC(18,2))::text, '\x01__NULL__\x01')");
    expect(
      normalizedColumnExpression({ dialect: 'mysql', column: 'amount', type: 'numeric', precision: 18, scale: 2 }),
    ).toBe("COALESCE(CAST(CAST(`amount` AS DECIMAL(18,2)) AS CHAR), '\x01__NULL__\x01')");
  });

  it('wraps a json column with a canonical, recursively key-sorted serializer on postgres and native JSON casting on mysql', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'metadata', type: 'json' })).toBe(
      "COALESCE(lab_jsonb_canonical(\"metadata\"), '\x01__NULL__\x01')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'metadata', type: 'json' })).toBe(
      "COALESCE(CAST(`metadata` AS JSON), '\x01__NULL__\x01')",
    );
  });

  it('wraps a plain text/uuid column with a simple NULL-safe cast', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'external_ref', type: 'text' })).toBe(
      "COALESCE(\"external_ref\"::text, '\x01__NULL__\x01')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'external_ref', type: 'text' })).toBe(
      "COALESCE(CAST(`external_ref` AS CHAR), '\x01__NULL__\x01')",
    );
  });

  it('quotes an identifier that collides with a reserved word or contains embedded quote characters', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'weird"col', type: 'text' })).toBe(
      "COALESCE(\"weird\"\"col\"::text, '\x01__NULL__\x01')",
    );
  });
});

describe('buildChecksumQuery', () => {
  it('builds a postgres checksum query over normalized columns without an invalid ORDER BY on a bare aggregate', () => {
    const query = buildChecksumQuery({
      dialect: 'postgres',
      table: 'orders',
      primaryKey: 'order_id',
      columns: [
        { column: 'order_id', type: 'text' },
        { column: 'amount', type: 'numeric', precision: 18, scale: 2 },
        { column: 'status', type: 'text' },
      ],
    });
    expect(query).toBe(
      "SELECT COALESCE(SUM(('x' || substr(md5(CONCAT_WS('|', " +
        "COALESCE(\"order_id\"::text, '\x01__NULL__\x01'), " +
        "COALESCE(CAST(\"amount\" AS NUMERIC(18,2))::text, '\x01__NULL__\x01'), " +
        "COALESCE(\"status\"::text, '\x01__NULL__\x01'))), 1, 8))::bit(32)::bigint), 0) AS checksum " +
        'FROM "orders"',
    );
    expect(query).not.toContain('ORDER BY');
  });

  it('builds a mysql-compatible checksum query using the same hash shape and quoted identifiers', () => {
    const query = buildChecksumQuery({
      dialect: 'mysql',
      table: 'orders',
      primaryKey: 'order_id',
      columns: [
        { column: 'order_id', type: 'text' },
        { column: 'amount', type: 'numeric', precision: 18, scale: 2 },
        { column: 'status', type: 'text' },
      ],
    });
    expect(query).toBe(
      "SELECT COALESCE(SUM(CONV(SUBSTRING(MD5(CONCAT_WS('|', " +
        "COALESCE(CAST(`order_id` AS CHAR), '\x01__NULL__\x01'), " +
        "COALESCE(CAST(CAST(`amount` AS DECIMAL(18,2)) AS CHAR), '\x01__NULL__\x01'), " +
        "COALESCE(CAST(`status` AS CHAR), '\x01__NULL__\x01'))), 1, 8), 16, 10)), 0) AS checksum " +
        'FROM `orders`',
    );
    expect(query).not.toContain('ORDER BY');
  });

  it('quotes the table identifier for both dialects', () => {
    const pg = buildChecksumQuery({ dialect: 'postgres', table: 'orders', primaryKey: 'order_id', columns: [] });
    const mysql = buildChecksumQuery({ dialect: 'mysql', table: 'orders', primaryKey: 'order_id', columns: [] });
    expect(pg).toContain('FROM "orders"');
    expect(mysql).toContain('FROM `orders`');
  });
});
