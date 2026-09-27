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

const NULL_TOKEN = "'\\N'";

export const normalizedColumnExpression = (options: NormalizedColumnOptions): string => {
  const { dialect, column, type, precision, scale } = options;

  if (type === 'boolean') {
    const raw =
      dialect === 'postgres'
        ? `CASE WHEN ${column} THEN '1' ELSE '0' END`
        : `CAST(${column} AS CHAR)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'timestamptz') {
    const raw =
      dialect === 'postgres'
        ? `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
        : `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s')`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'numeric') {
    const p = precision ?? 18;
    const s = scale ?? 2;
    const raw =
      dialect === 'postgres'
        ? `CAST(${column} AS NUMERIC(${p},${s}))::text`
        : `CAST(CAST(${column} AS DECIMAL(${p},${s})) AS CHAR)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  if (type === 'json') {
    const raw = dialect === 'postgres' ? `${column}::jsonb::text` : `CAST(${column} AS JSON)`;
    return `COALESCE(${raw}, ${NULL_TOKEN})`;
  }

  const raw = dialect === 'postgres' ? `${column}::text` : `CAST(${column} AS CHAR)`;
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

  return (
    `SELECT COALESCE(SUM(${hashExpression}), 0) AS checksum ` +
    `FROM ${options.table} ORDER BY ${options.primaryKey}`
  );
};
