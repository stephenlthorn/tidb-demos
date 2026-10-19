import type { Alert, GroundTruthEntry } from './domain';
import { formatDateTime } from './time';
import type { Verdict } from './scorer';

export type FlagScope = 'production' | 'branch-shadow';

export type FlagRow = {
  readonly flag_id: string;
  readonly rule_id: string;
  readonly rule_version: string;
  readonly account_id: string;
  readonly scope: FlagScope;
  readonly verdict: Verdict;
  readonly simulated: 1;
  readonly raised_at: string;
};

export type TruthRow = {
  readonly account_id: string;
  readonly pattern: string;
  readonly injected_at: string;
};

export type RunEventRow = {
  readonly run_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly case_id: string;
  readonly detail: string;
  readonly emitted_at: string;
};

export const flagRow = (options: {
  readonly runId: string;
  readonly alert: Alert;
  readonly scope: FlagScope;
  readonly verdict: Verdict;
}): FlagRow => ({
  flag_id: `${options.runId}:${options.scope}:${options.alert.ruleId}:${options.alert.ruleVersion}:${options.alert.accountId}:${options.alert.bucket}`,
  rule_id: options.alert.ruleId,
  rule_version: options.alert.ruleVersion,
  account_id: options.alert.accountId,
  scope: options.scope,
  verdict: options.verdict,
  simulated: 1,
  raised_at: formatDateTime(options.alert.raisedAtMs),
});

export const truthRow = (entry: GroundTruthEntry): TruthRow => ({
  account_id: entry.accountId,
  pattern: entry.pattern,
  injected_at: formatDateTime(entry.injectedAtMs),
});

export const runEventRow = (options: {
  readonly runId: string;
  readonly seq: number;
  readonly kind: string;
  readonly caseId: string;
  readonly detail: string;
  readonly atMs: number;
}): RunEventRow => ({
  run_id: options.runId,
  seq: options.seq,
  kind: options.kind,
  case_id: options.caseId,
  detail: options.detail,
  emitted_at: formatDateTime(options.atMs),
});
