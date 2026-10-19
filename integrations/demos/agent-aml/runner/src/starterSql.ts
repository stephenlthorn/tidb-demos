import { quoteIdentifier } from '@lab/runner-kit';
import type { Account, Alert, GroundTruthEntry, Transaction } from './domain';
import { sqlStringLiteral } from './sqlLiteral';
import { formatDateTimeMs } from './time';
import type { RuleDefinition } from './rules';

export type Statement = { readonly sql: string; readonly params: readonly unknown[] };

export const BULK_BATCH_SIZE = 500;

export const buildBulkInsert = (options: {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly ignoreDuplicates?: boolean;
}): Statement => {
  if (options.rows.length === 0) return { sql: '', params: [] };
  const columnList = options.columns.map(quoteIdentifier).join(', ');
  const group = `(${options.columns.map(() => '?').join(', ')})`;
  const verb = options.ignoreDuplicates === true ? 'INSERT IGNORE INTO' : 'INSERT INTO';
  return {
    sql: `${verb} ${quoteIdentifier(options.table)} (${columnList}) VALUES ${options.rows.map(() => group).join(', ')}`,
    params: options.rows.flat(),
  };
};

export const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export const transactionInserts = (transactions: readonly Transaction[]): readonly Statement[] =>
  chunk(transactions, BULK_BATCH_SIZE).map((batch) =>
    buildBulkInsert({
      table: 'transactions',
      columns: ['txn_id', 'account_id', 'counterparty_id', 'txn_type', 'amount_cents', 'txn_ts', 'branch_code', 'memo'],
      rows: batch.map((txn) => [
        txn.txnId,
        txn.accountId,
        txn.counterpartyId,
        txn.txnType,
        txn.amountCents,
        formatDateTimeMs(txn.txnTsMs),
        txn.branchCode,
        txn.memo,
      ]),
    }),
  );

export const accountInsert = (accounts: readonly Account[]): Statement =>
  buildBulkInsert({
    table: 'accounts',
    columns: ['account_id', 'holder_name', 'kind', 'home_branch'],
    rows: accounts.map((account) => [account.accountId, account.holderName, account.kind, account.homeBranch]),
    ignoreDuplicates: true,
  });

export const groundTruthInsert = (entries: readonly GroundTruthEntry[]): Statement =>
  buildBulkInsert({
    table: 'ground_truth',
    columns: ['account_id', 'pattern', 'injected_at'],
    rows: entries.map((entry) => [entry.accountId, entry.pattern, formatDateTimeMs(entry.injectedAtMs)]),
    ignoreDuplicates: true,
  });

export const alertInsert = (alerts: readonly Alert[]): Statement =>
  buildBulkInsert({
    table: 'alerts',
    columns: [
      'rule_id',
      'rule_version',
      'account_id',
      'bucket',
      'window_start',
      'window_end',
      'score',
      'txn_ids',
      'raised_at',
    ],
    rows: alerts.map((alert) => [
      alert.ruleId,
      alert.ruleVersion,
      alert.accountId,
      alert.bucket,
      formatDateTimeMs(alert.windowStartMs),
      formatDateTimeMs(alert.windowEndMs),
      alert.score,
      JSON.stringify(alert.txnIds),
      formatDateTimeMs(alert.raisedAtMs),
    ]),
    ignoreDuplicates: true,
  });

export const ruleUpsert = (rule: RuleDefinition): Statement => ({
  sql:
    'INSERT INTO rules (rule_id, version, params, active) VALUES (?, ?, ?, 1) ' +
    'ON DUPLICATE KEY UPDATE params = VALUES(params), active = VALUES(active)',
  params: [rule.ruleId, rule.version, JSON.stringify(rule.params)],
});

const datetimeText = (column: string): string => `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s.%f')`;

export const selectTransactionsSince = `SELECT txn_id, account_id, counterparty_id, txn_type, amount_cents, ${datetimeText('txn_ts')} AS txn_ts_text, branch_code, memo FROM transactions WHERE txn_ts > ? ORDER BY txn_id`;

export const selectAccounts = 'SELECT account_id, holder_name, kind, home_branch FROM accounts ORDER BY account_id';

export const selectGroundTruth = `SELECT account_id, pattern, ${datetimeText('injected_at')} AS injected_at_text FROM ground_truth ORDER BY account_id`;

export const selectAlerts = `SELECT rule_id, rule_version, account_id, bucket, ${datetimeText('window_start')} AS window_start_text, ${datetimeText('window_end')} AS window_end_text, score, txn_ids, ${datetimeText('raised_at')} AS raised_at_text FROM alerts ORDER BY alert_id`;

export const selectActiveRules = 'SELECT rule_id, version, params FROM rules WHERE active = 1 ORDER BY rule_id, version';

export const countNonPlantedTransactions =
  'SELECT COUNT(*) AS n FROM transactions WHERE account_id NOT IN (SELECT account_id FROM ground_truth)';

export const countTransactionsUpTo = 'SELECT COUNT(*) AS n FROM transactions WHERE txn_id <= ?';

export const maxTransactionId = 'SELECT COALESCE(MAX(txn_id), 0) AS max_id FROM transactions';

export const alertVolumeByVersion =
  'SELECT rule_version, COUNT(*) AS alerts FROM alerts WHERE rule_id = ? GROUP BY rule_version ORDER BY rule_version';

export const isolationProbe =
  "SELECT (SELECT COUNT(*) FROM rules WHERE version = 'v2') AS v2_rules, (SELECT COUNT(*) FROM alerts WHERE rule_version = 'v2') AS v2_alerts";

export const selectWatchlistCandidates = (ftsQuery: string): string => {
  const literal = sqlStringLiteral(ftsQuery);
  return `SELECT entry_id, full_name, list_tag FROM watchlist WHERE fts_match_word(${literal}, full_name) ORDER BY fts_match_word(${literal}, full_name) DESC LIMIT 5`;
};

export const entityFactsInsert = (accounts: readonly Account[]): Statement =>
  buildBulkInsert({
    table: 'entity_facts',
    columns: ['entity_id', 'fact_key', 'fact_value'],
    rows: accounts.flatMap((account) => [
      [account.accountId, 'holder_name', account.holderName],
      [account.accountId, 'kind', account.kind],
      [account.accountId, 'home_branch', account.homeBranch],
    ]),
    ignoreDuplicates: true,
  });

export const selectEntityFacts = 'SELECT fact_key, fact_value FROM entity_facts WHERE entity_id = ? ORDER BY fact_key';

export const watchlistInsert = (entries: readonly { readonly fullName: string; readonly listTag: string }[]): Statement =>
  buildBulkInsert({
    table: 'watchlist',
    columns: ['full_name', 'list_tag'],
    rows: entries.map((entry) => [entry.fullName, entry.listTag]),
  });

export const episodicInsert = (
  items: readonly { readonly caseId: string; readonly pattern: string; readonly outcome: string; readonly summary: string }[],
): Statement =>
  buildBulkInsert({
    table: 'episodic_memory',
    columns: ['case_id', 'pattern', 'outcome', 'summary'],
    rows: items.map((item) => [item.caseId, item.pattern, item.outcome, item.summary]),
  });

export const caseInsert = (record: {
  readonly caseId: string;
  readonly accountId: string;
  readonly pattern: string;
  readonly openedAtMs: number;
  readonly layerId: string;
  readonly branchId: string;
  readonly journalId: string;
}): Statement => ({
  sql:
    'INSERT INTO cases (case_id, alert_id, account_id, pattern, status, opened_at, layer_id, branch_id, journal_id) ' +
    "VALUES (?, 0, ?, ?, 'open', ?, ?, ?, ?)",
  params: [
    record.caseId,
    record.accountId,
    record.pattern,
    formatDateTimeMs(record.openedAtMs),
    record.layerId,
    record.branchId,
    record.journalId,
  ],
});
