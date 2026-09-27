import { describe, expect, it } from 'vitest';
import { buildChecksumQuery, normalizedColumnExpression } from '../runner/src/checksum';

describe('normalizedColumnExpression', () => {
  it('wraps a boolean column with dialect-specific 0/1 normalization and NULL handling', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'is_active', type: 'boolean' })).toBe(
      "COALESCE(CASE WHEN is_active THEN '1' ELSE '0' END, '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'is_active', type: 'boolean' })).toBe(
      "COALESCE(CAST(is_active AS CHAR), '\\N')",
    );
  });

  it('wraps a timestamp column normalized to UTC with no zone suffix', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'opened_at', type: 'timestamptz' })).toBe(
      "COALESCE(to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'opened_at', type: 'timestamptz' })).toBe(
      "COALESCE(DATE_FORMAT(opened_at, '%Y-%m-%d %H:%i:%s'), '\\N')",
    );
  });

  it('wraps a numeric column with a fixed precision/scale cast', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'amount', type: 'numeric', precision: 18, scale: 2 })).toBe(
      "COALESCE(CAST(amount AS NUMERIC(18,2))::text, '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'amount', type: 'numeric', precision: 18, scale: 2 })).toBe(
      "COALESCE(CAST(CAST(amount AS DECIMAL(18,2)) AS CHAR), '\\N')",
    );
  });

  it('wraps a plain text/json/uuid column with a simple NULL-safe cast', () => {
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'metadata', type: 'json' })).toBe(
      "COALESCE(metadata::jsonb::text, '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'mysql', column: 'metadata', type: 'json' })).toBe(
      "COALESCE(CAST(metadata AS JSON), '\\N')",
    );
    expect(normalizedColumnExpression({ dialect: 'postgres', column: 'external_ref', type: 'text' })).toBe(
      "COALESCE(external_ref::text, '\\N')",
    );
  });
});

describe('buildChecksumQuery', () => {
  it('builds a postgres checksum query over normalized, order-by-pk columns', () => {
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
        "COALESCE(order_id::text, '\\N'), " +
        "COALESCE(CAST(amount AS NUMERIC(18,2))::text, '\\N'), " +
        "COALESCE(status::text, '\\N'))), 1, 8))::bit(32)::bigint), 0) AS checksum " +
        'FROM orders ORDER BY order_id',
    );
  });

  it('builds a mysql-compatible checksum query using the same hash shape', () => {
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
        "COALESCE(CAST(order_id AS CHAR), '\\N'), " +
        "COALESCE(CAST(CAST(amount AS DECIMAL(18,2)) AS CHAR), '\\N'), " +
        "COALESCE(CAST(status AS CHAR), '\\N'))), 1, 8), 16, 10)), 0) AS checksum " +
        'FROM orders ORDER BY order_id',
    );
  });
});
