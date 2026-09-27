import { z } from 'zod';

export type StatementState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'CLOSED';

export type StatementResponse = {
  readonly statementId: string;
  readonly state: StatementState;
  readonly rowCount: number | undefined;
  readonly rows: readonly (readonly string[])[];
  readonly errorMessage: string | undefined;
};

const StatementStateSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'CLOSED']);

const RawStatementResponseSchema = z.object({
  statement_id: z.string().optional(),
  status: z
    .object({
      state: StatementStateSchema.optional(),
      error: z.object({ message: z.string().optional() }).optional(),
    })
    .optional(),
  result: z
    .object({
      data_array: z.array(z.array(z.unknown())).optional(),
      row_count: z.number().optional(),
    })
    .optional(),
});

type RawStatementResponse = z.infer<typeof RawStatementResponseSchema>;

const emptyRawResponse: RawStatementResponse = {};

const toRawStatementResponse = (value: unknown): RawStatementResponse => {
  const parsed = RawStatementResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyRawResponse;
};

const toStringRows = (
  rows: ReadonlyArray<ReadonlyArray<unknown>> | undefined,
): readonly (readonly string[])[] => (rows ?? []).map((row) => row.map((cell) => String(cell)));

export const parseStatementResponse = (json: unknown): StatementResponse => {
  const raw = toRawStatementResponse(json);
  const state = raw.status?.state ?? 'FAILED';
  const rows = toStringRows(raw.result?.data_array);
  const rowCount = raw.result?.row_count;
  const errorMessage = raw.status?.error?.message;
  const statementId = raw.statement_id ?? '';
  return { statementId, state, rowCount, rows, errorMessage };
};

export type PollDecision = 'poll' | 'ready' | 'failed' | 'timeout';

export const decidePoll = (state: StatementState, elapsedMs: number, timeoutMs: number): PollDecision => {
  if (state === 'SUCCEEDED') return 'ready';
  if (state === 'FAILED' || state === 'CANCELED' || state === 'CLOSED') return 'failed';
  if (elapsedMs >= timeoutMs) return 'timeout';
  return 'poll';
};
