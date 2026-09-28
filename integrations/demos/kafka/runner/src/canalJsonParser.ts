import { z } from 'zod';

export const CANAL_JSON_FIELDS = {
  database: 'database',
  table: 'table',
  type: 'type',
  isDdl: 'isDdl',
  data: 'data',
  old: 'old',
  tidbExtension: '_tidb',
  commitTs: 'commitTs',
} as const;

export type ParsedRowEvent = {
  readonly ok: true;
  readonly table: string;
  readonly type: string;
  readonly commitTs: bigint;
  readonly row: Readonly<Record<string, string>>;
};

export type ParseFailure = {
  readonly ok: false;
  readonly reason: 'invalid JSON' | 'not a row event';
};

export type ParseResult = ParsedRowEvent | ParseFailure;

const CanalJsonRowSchema = z.record(z.string(), z.string());

const CanalJsonMessageSchema = z.object({
  [CANAL_JSON_FIELDS.database]: z.string().optional(),
  [CANAL_JSON_FIELDS.table]: z.string().optional(),
  [CANAL_JSON_FIELDS.type]: z.string().optional(),
  [CANAL_JSON_FIELDS.isDdl]: z.boolean().optional(),
  [CANAL_JSON_FIELDS.data]: z.array(CanalJsonRowSchema).nullable().optional(),
  [CANAL_JSON_FIELDS.old]: z.array(CanalJsonRowSchema).nullable().optional(),
});

const parseJson = (raw: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

const commitTsPattern = new RegExp(
  `"${CANAL_JSON_FIELDS.tidbExtension}"\\s*:\\s*\\{[^}]*"${CANAL_JSON_FIELDS.commitTs}"\\s*:\\s*(-?\\d+)`,
);

const extractCommitTs = (raw: string): bigint | undefined => {
  const found = commitTsPattern.exec(raw);
  if (found === null) return undefined;
  const digits = found[1];
  if (digits === undefined) return undefined;
  return BigInt(digits);
};

export const tsoPhysicalMillis = (tso: bigint): bigint => tso >> 18n;

export const parseCanalJsonMessage = (raw: string): ParseResult => {
  const json = parseJson(raw);
  if (!json.ok) return { ok: false, reason: 'invalid JSON' };
  const parsed = CanalJsonMessageSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, reason: 'not a row event' };
  const message = parsed.data;
  const rows = message[CANAL_JSON_FIELDS.data];
  if (message[CANAL_JSON_FIELDS.isDdl] === true || rows === null || rows === undefined || rows.length === 0) {
    return { ok: false, reason: 'not a row event' };
  }
  const firstRow = rows[0];
  if (firstRow === undefined) {
    return { ok: false, reason: 'not a row event' };
  }
  const commitTs = extractCommitTs(raw);
  if (commitTs === undefined) {
    return { ok: false, reason: 'not a row event' };
  }
  return {
    ok: true,
    table: message[CANAL_JSON_FIELDS.table] ?? '',
    type: message[CANAL_JSON_FIELDS.type] ?? '',
    commitTs,
    row: firstRow,
  };
};
