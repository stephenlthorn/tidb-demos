export type RowChange = {
  readonly table: string;
  readonly commitTs: bigint;
  readonly row: Readonly<Record<string, string>>;
};

export type ParsedCanalMessage =
  | { readonly ok: true; readonly change: RowChange }
  | { readonly ok: false; readonly error: string };

export type CacheDemoFields = {
  readonly rowId: number;
  readonly writtenAtMs: number;
};

const parseJson = (raw: string): unknown | undefined => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringRecord = (value: Record<string, unknown>): value is Record<string, string> =>
  Object.values(value).every((entry) => typeof entry === 'string');

const extractCommitTsDigits = (raw: string): string | undefined => raw.match(/"commitTs"\s*:\s*(\d+)/)?.[1];

export const parseCanalJsonMessage = (raw: string): ParsedCanalMessage => {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return { ok: false, error: 'not JSON' };
  const table = parsed.table;
  const data = parsed.data;
  if (typeof table !== 'string') return { ok: false, error: 'missing table' };
  if (!Array.isArray(data) || data.length === 0 || !isRecord(data[0])) {
    return { ok: false, error: 'missing data' };
  }
  const row = data[0];
  if (!isStringRecord(row)) return { ok: false, error: 'row data is not string-keyed' };
  const commitTsDigits = extractCommitTsDigits(raw);
  if (commitTsDigits === undefined) return { ok: false, error: 'missing commitTs' };
  return { ok: true, change: { table, commitTs: BigInt(commitTsDigits), row } };
};

export const extractCacheDemoFields = (row: Readonly<Record<string, string>>): CacheDemoFields | undefined => {
  const rowId = Number(row.id);
  const writtenAtMs = Number(row.written_at_ms);
  if (!Number.isFinite(rowId) || !Number.isFinite(writtenAtMs)) return undefined;
  return { rowId, writtenAtMs };
};
