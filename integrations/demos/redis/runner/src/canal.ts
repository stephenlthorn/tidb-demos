export type RowChange = {
  readonly table: string;
  readonly rowId: number;
  readonly writtenAtMs: number;
};

export type ParsedCanalMessage =
  | { readonly ok: true; readonly change: RowChange }
  | { readonly ok: false; readonly error: string };

const parseJson = (raw: string): unknown | undefined => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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
  const rowId = Number(row.id);
  const writtenAtMs = Number(row.written_at_ms);
  if (!Number.isFinite(rowId) || !Number.isFinite(writtenAtMs)) {
    return { ok: false, error: 'missing row id or written_at_ms' };
  }
  return { ok: true, change: { table, rowId, writtenAtMs } };
};
