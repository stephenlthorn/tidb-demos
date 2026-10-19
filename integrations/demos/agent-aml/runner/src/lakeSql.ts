import { assertAccountId, assertSafeInteger, sqlStringLiteral } from './sqlLiteral';
import { formatDateTime } from './time';

export type LakeSetupOptions = {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly warehouse: string;
};

export const LAKE_DATABASE = 'harbor';
export const LOAD_TASK = 'harbor_load';
export const executeLoadTask = `EXECUTE TASK ${LOAD_TASK}`;

const tableStatements: readonly string[] = [
  `CREATE DATABASE IF NOT EXISTS ${LAKE_DATABASE}`,
  `CREATE TABLE IF NOT EXISTS ${LAKE_DATABASE}.txn_history (
    txn_id BIGINT, account_id STRING, counterparty_id STRING, txn_type STRING,
    amount_cents BIGINT, txn_ts TIMESTAMP, branch_code STRING, memo STRING
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAKE_DATABASE}.ground_truth (
    account_id STRING, pattern STRING, injected_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAKE_DATABASE}.flag_log (
    flag_id STRING, rule_id STRING, rule_version STRING, account_id STRING,
    scope STRING, verdict STRING, simulated INT, raised_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ${LAKE_DATABASE}.run_events (
    run_id STRING, seq BIGINT, kind STRING, case_id STRING, detail STRING, emitted_at TIMESTAMP
  )`,
];

const copyStatement = (table: string, path: string, format: 'PARQUET' | 'NDJSON'): string => {
  const extension = format === 'PARQUET' ? 'parquet' : 'ndjson';
  return `COPY INTO ${LAKE_DATABASE}.${table} FROM @harbor_lake/${path} PATTERN = '.*[.]${extension}' FILE_FORMAT = (TYPE = ${format})`;
};

export const loadTaskBody = [
  copyStatement('txn_history', 'export/transactions/', 'PARQUET'),
  copyStatement('ground_truth', 'events/truth/', 'NDJSON'),
  copyStatement('flag_log', 'events/flags/', 'NDJSON'),
  copyStatement('run_events', 'events/run/', 'NDJSON'),
]
  .map((statement) => `${statement};`)
  .join('\n  ');

export const buildLakeSetupStatements = (options: LakeSetupOptions): readonly string[] => [
  ...tableStatements,
  `CREATE CONNECTION IF NOT EXISTS harbor_s3 STORAGE_TYPE = 's3' ACCESS_KEY_ID = ${sqlStringLiteral(options.accessKeyId)} SECRET_ACCESS_KEY = ${sqlStringLiteral(options.secretAccessKey)} REGION = ${sqlStringLiteral(options.region)}`,
  `CREATE STAGE IF NOT EXISTS harbor_lake URL = ${sqlStringLiteral(`s3://${options.bucket}/lake/`)} CONNECTION = (CONNECTION_NAME = 'harbor_s3')`,
  `CREATE TASK IF NOT EXISTS ${LOAD_TASK} WAREHOUSE = ${sqlStringLiteral(options.warehouse)} SCHEDULE = 1 MINUTE AS\nBEGIN\n  ${loadTaskBody}\nEND;`,
  `ALTER TASK ${LOAD_TASK} RESUME`,
];

export const resetLakeStatements: readonly string[] = [
  `TRUNCATE TABLE ${LAKE_DATABASE}.txn_history`,
  `TRUNCATE TABLE ${LAKE_DATABASE}.ground_truth`,
  `TRUNCATE TABLE ${LAKE_DATABASE}.flag_log`,
  `TRUNCATE TABLE ${LAKE_DATABASE}.run_events`,
];

export const teardownStatements: readonly string[] = [
  `ALTER TASK ${LOAD_TASK} SUSPEND`,
  `DROP TASK IF EXISTS ${LOAD_TASK}`,
  'DROP STAGE IF EXISTS harbor_lake',
  'DROP CONNECTION IF EXISTS harbor_s3',
  `DROP DATABASE IF EXISTS ${LAKE_DATABASE}`,
];

export const countHistoryUpTo = (txnId: number): string =>
  `SELECT COUNT(*) AS n FROM ${LAKE_DATABASE}.txn_history WHERE txn_id <= ${assertSafeInteger('txnId', txnId)}`;

export const buildBandPeersSql = (options: {
  readonly lowerCents: number;
  readonly upperCents: number;
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly minDeposits: number;
}): string =>
  `SELECT account_id, COUNT(*) AS deposits, COUNT(DISTINCT branch_code) AS branches, SUM(amount_cents) AS total_cents
FROM ${LAKE_DATABASE}.txn_history
WHERE txn_type = 'cash_deposit'
  AND amount_cents >= ${assertSafeInteger('lowerCents', options.lowerCents)}
  AND amount_cents < ${assertSafeInteger('upperCents', options.upperCents)}
  AND txn_ts >= '${formatDateTime(options.sinceMs)}'
  AND txn_ts < '${formatDateTime(options.untilMs)}'
GROUP BY account_id
HAVING COUNT(*) >= ${assertSafeInteger('minDeposits', options.minDeposits)}
ORDER BY deposits DESC, account_id
LIMIT 50`;

export const buildAccountLookbackSql = (options: {
  readonly accountId: string;
  readonly sinceMs: number;
  readonly untilMs: number;
}): string =>
  `SELECT txn_type, COUNT(*) AS txns, SUM(amount_cents) AS total_cents, COUNT(DISTINCT counterparty_id) AS counterparties, COUNT(DISTINCT branch_code) AS branches, MIN(txn_ts) AS first_seen, MAX(txn_ts) AS last_seen
FROM ${LAKE_DATABASE}.txn_history
WHERE account_id = '${assertAccountId(options.accountId)}'
  AND txn_ts >= '${formatDateTime(options.sinceMs)}'
  AND txn_ts < '${formatDateTime(options.untilMs)}'
GROUP BY txn_type
ORDER BY txn_type`;

export const lookbackMonthsToMs = (months: number): number => assertSafeInteger('months', months) * 30 * 86_400_000;

export const ruleEvalSql =
  `SELECT rule_id, rule_version, scope, COUNT(*) AS flags,
  SUM(CASE WHEN verdict = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
  SUM(CASE WHEN verdict = 'false-positive' THEN 1 ELSE 0 END) AS false_positives
FROM ${LAKE_DATABASE}.flag_log
GROUP BY rule_id, rule_version, scope
ORDER BY rule_id, rule_version, scope`;

export const buildPlantedRecallSql = (ruleVersion: string): string => {
  if (!/^v\d+$/.test(ruleVersion)) throw new Error(`not a rule version: ${ruleVersion}`);
  return `SELECT g.pattern, COUNT(DISTINCT g.account_id) AS planted, COUNT(DISTINCT f.account_id) AS flagged
FROM ${LAKE_DATABASE}.ground_truth g
LEFT JOIN ${LAKE_DATABASE}.flag_log f
  ON f.account_id = g.account_id AND f.rule_id = g.pattern AND f.rule_version = '${ruleVersion}'
GROUP BY g.pattern
ORDER BY g.pattern`;
};

export type LakeRuleEval = {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly scope: string;
  readonly flags: number;
  readonly confirmed: number;
  readonly falsePositives: number;
  readonly precision: number | undefined;
};

export const parseRuleEval = (rows: readonly Readonly<Record<string, unknown>>[]): readonly LakeRuleEval[] =>
  rows.map((row) => {
    const flags = Number(row.flags);
    const confirmed = Number(row.confirmed);
    return {
      ruleId: String(row.rule_id),
      ruleVersion: String(row.rule_version),
      scope: String(row.scope),
      flags,
      confirmed,
      falsePositives: Number(row.false_positives),
      precision: flags === 0 ? undefined : confirmed / flags,
    };
  });

export type LakePlantedRecall = {
  readonly pattern: string;
  readonly planted: number;
  readonly flagged: number;
  readonly recall: number | undefined;
};

export const parsePlantedRecall = (rows: readonly Readonly<Record<string, unknown>>[]): readonly LakePlantedRecall[] =>
  rows.map((row) => {
    const planted = Number(row.planted);
    const flagged = Number(row.flagged);
    return { pattern: String(row.pattern), planted, flagged, recall: planted === 0 ? undefined : flagged / planted };
  });
