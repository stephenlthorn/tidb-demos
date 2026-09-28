import { quoteIdentifier } from '@lab/runner-kit';

export type ChecksumDialect = 'postgres' | 'mysql';

export type ColumnType = 'text' | 'boolean' | 'timestamptz' | 'numeric' | 'json';

export type ChecksumColumn = {
  readonly column: string;
  readonly type: ColumnType;
  readonly precision?: number;
  readonly scale?: number;
};

export type NormalizedColumnOptions = ChecksumColumn & {
  readonly dialect: ChecksumDialect;
};

const NULL_TOKEN = "'\x01__NULL__\x01'";

export const POSTGRES_JSON_CANONICAL_FUNCTION = 'lab_jsonb_canonical';

export const quotePostgresIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const quoteIdentifierForDialect = (dialect: ChecksumDialect, name: string): string =>
  dialect === 'postgres' ? quotePostgresIdentifier(name) : quoteIdentifier(name);

export const normalizedColumnExpression = (options: NormalizedColumnOptions): string => {
  const { dialect, column, type, precision, scale } = options;
  const quotedColumn = quoteIdentifierForDialect(dialect, column);

  if (type === 'boolean') {
    const raw =
      dialect === 'postgres'
        ? `CASE WHEN ${quotedColumn} IS NULL THEN NULL WHEN ${quotedColumn} THEN '1' ELSE '0' END`
        : `CAST(${quotedColumn} AS CHAR)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'timestamptz') {
    const raw =
      dialect === 'postgres'
        ? `to_char(${quotedColumn} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
        : `DATE_FORMAT(${quotedColumn}, '%Y-%m-%d %H:%i:%s')`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'numeric') {
    const p = precision ?? 18;
    const s = scale ?? 2;
    const raw =
      dialect === 'postgres'
        ? `CAST(${quotedColumn} AS NUMERIC(${p},${s}))::text`
        : `CAST(CAST(${quotedColumn} AS DECIMAL(${p},${s})) AS CHAR)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'json') {
    const raw =
      dialect === 'postgres'
        ? `${POSTGRES_JSON_CANONICAL_FUNCTION}(${quotedColumn})`
        : `CAST(${quotedColumn} AS JSON)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  const raw = dialect === 'postgres' ? `${quotedColumn}::text` : `CAST(${quotedColumn} AS CHAR)`;
  return `COALESCE(${raw}, ${NULL_TOKEN})`;
};

export type ChecksumQueryOptions = {
  readonly dialect: ChecksumDialect;
  readonly table: string;
  readonly primaryKey: string;
  readonly columns: readonly ChecksumColumn[];
};

export const buildChecksumQuery = (options: ChecksumQueryOptions): string => {
  const normalizedColumns = options.columns
    .map((column) => normalizedColumnExpression({ ...column, dialect: options.dialect }))
    .join(', ');
  const concatExpression = `CONCAT_WS('|', ${normalizedColumns})`;

  const hashExpression =
    options.dialect === 'postgres'
      ? `('x' || substr(md5(${concatExpression}), 1, 8))::bit(32)::bigint`
      : `CONV(SUBSTRING(MD5(${concatExpression}), 1, 8), 16, 10)`;

  const quotedTable = quoteIdentifierForDialect(options.dialect, options.table);

  return `SELECT COALESCE(SUM(${hashExpression}), 0) AS checksum FROM ${quotedTable}`;
};
