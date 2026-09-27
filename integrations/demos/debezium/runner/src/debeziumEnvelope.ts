import { z } from 'zod';

export type ParsedEnvelope = {
  readonly ok: true;
  readonly connector: string;
  readonly table: string;
  readonly op: string;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly tsMs: number;
};

export type EnvelopeParseFailure = {
  readonly ok: false;
  readonly reason: 'invalid JSON' | 'missing envelope fields';
};

export type EnvelopeParseResult = ParsedEnvelope | EnvelopeParseFailure;

const RawEnvelopeSchema = z.object({
  payload: z
    .object({
      after: z.record(z.string(), z.unknown()).nullable().optional(),
      source: z.object({ connector: z.string().optional(), table: z.string().optional() }).optional(),
      op: z.string().optional(),
      ts_ms: z.number().optional(),
    })
    .optional(),
});

const parseJson = (raw: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
};

export const parseDebeziumEnvelope = (raw: string): EnvelopeParseResult => {
  const json = parseJson(raw);
  if (!json.ok) return { ok: false, reason: 'invalid JSON' };
  const parsed = RawEnvelopeSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, reason: 'missing envelope fields' };
  const message = parsed.data;
  const source = message.payload?.source;
  const op = message.payload?.op;
  const tsMs = message.payload?.ts_ms;
  if (!source?.connector || !source.table || !op || tsMs === undefined) {
    return { ok: false, reason: 'missing envelope fields' };
  }
  return {
    ok: true,
    connector: source.connector,
    table: source.table,
    op,
    after: message.payload?.after ?? null,
    tsMs,
  };
};
