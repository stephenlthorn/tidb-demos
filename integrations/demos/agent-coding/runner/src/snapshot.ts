import { quoteIdentifier } from '@lab/runner-kit';

export type BranchSnapshot = {
  readonly dbTime: string;
  readonly rowCount: number;
  readonly checksum: string;
};

export const normalizeDbTime = (raw: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(raw);
  if (match === null) throw new Error(`unexpected db_time format: ${raw}`);
  const fraction = (match[2] ?? '').padEnd(3, '0').slice(0, 3);
  return `${match[1]}.${fraction}Z`;
};

export const buildSnapshotSql = (database: string): string =>
  `SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS db_time, COUNT(*) AS row_count, CAST(BIT_XOR(CRC32(CONCAT_WS('|', id, customer, amount_cents, status))) AS CHAR) AS checksum FROM ${quoteIdentifier(database)}.orders`;

export const parseSnapshotRow = (row: Readonly<Record<string, unknown>>): BranchSnapshot => {
  const rowCount = Number(row.row_count);
  if (!Number.isInteger(rowCount)) throw new Error(`unexpected row_count: ${String(row.row_count)}`);
  return {
    dbTime: normalizeDbTime(String(row.db_time)),
    rowCount,
    checksum: String(row.checksum),
  };
};
