export type BuiltSql = {
  readonly sql: string;
  readonly params: readonly number[];
};

export const buildHeartbeatUpsertSql = (options: { readonly sourceCommitMs: number }): BuiltSql => ({
  sql: 'INSERT INTO heartbeat (id, source_commit_ms) VALUES (1, ?) ON DUPLICATE KEY UPDATE source_commit_ms = VALUES(source_commit_ms)',
  params: [options.sourceCommitMs],
});

export type HeartbeatLagInput = {
  readonly observedAtMs: number;
  readonly sourceCommitMs: number;
};

export const computeHeartbeatLagMs = (input: HeartbeatLagInput): number =>
  Math.max(0, input.observedAtMs - input.sourceCommitMs);
