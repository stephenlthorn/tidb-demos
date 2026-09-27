export type ScoredRow = {
  readonly customerId: number;
  readonly score: number;
  readonly rule: string;
  readonly updatedAtMs: number;
};

export type UpsertStatement = {
  readonly sql: string;
  readonly params: readonly unknown[];
};

const toDateTimeMs = (ms: number): string => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');

export const buildUpsertStatement = (rows: readonly ScoredRow[]): UpsertStatement => {
  if (rows.length === 0) return { sql: '', params: [] };
  const placeholders = rows.map(() => '(?, ?, ?, ?)').join(', ');
  const params = rows.flatMap((row) => [row.customerId, row.score, row.rule, toDateTimeMs(row.updatedAtMs)]);
  const sql =
    `INSERT INTO customer_risk_scores (customer_id, score, rule, updated_at) VALUES ${placeholders} ` +
    'ON DUPLICATE KEY UPDATE score = VALUES(score), rule = VALUES(rule), updated_at = VALUES(updated_at)';
  return { sql, params };
};
