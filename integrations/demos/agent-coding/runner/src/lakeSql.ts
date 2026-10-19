import { vectorLiteral } from './embedding';
import type { FailureRow } from './history';

export type LakeSetup = {
  readonly warehouse: string;
  readonly database: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

const safeName = (value: string, what: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${what} may contain only letters, digits, hyphen and underscore`);
  return value;
};

const safeLiteral = (value: string, what: string): string => {
  if (/['\\]/.test(value) || value === '') throw new Error(`${what} must be non-empty and contain no quote or backslash`);
  return value;
};

const safeBucket = (value: string): string => {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)) throw new Error('bucket is not a valid S3 bucket name');
  return value;
};

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

export const runEventsTable = 'run_events';
export const ledgerTable = 'ledger_lake';
export const failuresTable = 'run_failures';

export const eventsTaskName = 'ingest_run_events';

export const lakeBootstrapStatements = (setup: Pick<LakeSetup, 'database'>): readonly string[] => [
  `CREATE DATABASE IF NOT EXISTS ${safeName(setup.database, 'database')}`,
];

export const createWarehouseSql = (warehouse: string): string =>
  `CREATE WAREHOUSE IF NOT EXISTS '${safeName(warehouse, 'warehouse')}' WITH warehouse_size = XSmall auto_suspend = 300`;

export const lakeSetupStatements = (setup: LakeSetup): readonly string[] => {
  const warehouse = safeName(setup.warehouse, 'warehouse');
  const root = `s3://${safeBucket(setup.bucket)}/${trimSlashes(setup.prefix)}`;
  return [
    `CREATE OR REPLACE CONNECTION agent_s3 STORAGE_TYPE = 's3' ACCESS_KEY_ID = '${safeLiteral(setup.accessKeyId, 'access key id')}' SECRET_ACCESS_KEY = '${safeLiteral(setup.secretAccessKey, 'secret access key')}'`,
    `CREATE OR REPLACE STAGE events_stage URL = '${root}/events/' CONNECTION = (CONNECTION_NAME = 'agent_s3')`,
    `CREATE OR REPLACE STAGE ledger_stage URL = '${root}/ledger/' CONNECTION = (CONNECTION_NAME = 'agent_s3')`,
    `CREATE OR REPLACE TABLE ${runEventsTable} (
  run_id STRING, attempt_id STRING, step INT, kind STRING, status STRING, model STRING,
  cost_usd DOUBLE, merged BOOLEAN, message STRING, emitted_at TIMESTAMP, source STRING
)`,
    `CREATE INVERTED INDEX idx_run_events_message ON ${runEventsTable}(message)`,
    `CREATE OR REPLACE TABLE ${ledgerTable} (
  run_id STRING, attempt_id STRING, step INT, checkpoint_id STRING, db_time STRING,
  tree_hash STRING, db_checksum STRING, db_rows INT
)`,
    `CREATE OR REPLACE TABLE ${failuresTable} (
  run_id STRING, attempt_id STRING, message STRING, vec VECTOR(64),
  VECTOR INDEX idx_failure_vec(vec) distance = 'cosine'
)`,
    `CREATE OR REPLACE TASK ${eventsTaskName} WAREHOUSE = '${warehouse}' SCHEDULE = 1 MINUTE AS COPY INTO ${runEventsTable} FROM @events_stage PATTERN = '.*[.]ndjson' FILE_FORMAT = (TYPE = NDJSON)`,
    `ALTER TASK ${eventsTaskName} RESUME`,
  ];
};

export const copyLedgerSql = `COPY INTO ${ledgerTable} FROM @ledger_stage PATTERN = '.*[.]parquet' FILE_FORMAT = (TYPE = PARQUET)`;

export const executeEventsTaskSql = `EXECUTE TASK ${eventsTaskName}`;

export const buildFailureInsert = (rows: readonly FailureRow[]): string => {
  if (rows.length === 0) throw new RangeError('at least one failure row is required');
  const values = rows
    .map(
      (row) =>
        `('${safeLiteral(row.run_id, 'run id')}', '${safeLiteral(row.attempt_id, 'attempt id')}', '${safeLiteral(row.message, 'message')}', ${vectorLiteral(row.vector)})`,
    )
    .join(',\n');
  return `INSERT INTO ${failuresTable} (run_id, attempt_id, message, vec) VALUES\n${values}`;
};

export const countRunEventsSql = (runId: string): string =>
  `SELECT COUNT(*) AS n FROM ${runEventsTable} WHERE run_id = '${safeLiteral(runId, 'run id')}' AND source = 'live'`;

export const countMarkerSql = (options: { readonly runId: string; readonly markerId: string }): string =>
  `SELECT COUNT(*) AS n FROM ${runEventsTable} WHERE run_id = '${safeLiteral(options.runId, 'run id')}' AND kind = 'marker' AND message = '${safeLiteral(options.markerId, 'marker id')}'`;

export const countLedgerSql = (runId: string): string =>
  `SELECT COUNT(*) AS n FROM ${ledgerTable} WHERE run_id = '${safeLiteral(runId, 'run id')}'`;

export const matchResetSql = `SELECT COUNT(*) AS matches, COUNT(DISTINCT run_id) AS runs FROM ${runEventsTable} WHERE MATCH(message, 'ECONNRESET')`;

export const mergedPerDollarSql = `SELECT model, SUM(CASE WHEN merged THEN 1 ELSE 0 END) AS merged_attempts, SUM(cost_usd) AS cost_usd, SUM(CASE WHEN merged THEN 1 ELSE 0 END) / SUM(cost_usd) AS merged_per_dollar FROM ${runEventsTable} WHERE kind = 'attempt.finished' GROUP BY model ORDER BY merged_per_dollar DESC`;

export const similarFailuresSql = (options: {
  readonly runId: string;
  readonly vector: readonly number[];
  readonly limit: number;
}): string => {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError('limit must be a positive integer');
  return `SELECT run_id, attempt_id, message, COSINE_DISTANCE(vec, ${vectorLiteral(options.vector)}) AS distance FROM ${failuresTable} WHERE run_id <> '${safeLiteral(options.runId, 'run id')}' ORDER BY distance ASC LIMIT ${options.limit}`;
};

export const lakeTeardownStatements = (setup: Pick<LakeSetup, 'warehouse' | 'database'>): readonly string[] => {
  const warehouse = safeName(setup.warehouse, 'warehouse');
  return [
    `ALTER TASK ${eventsTaskName} SUSPEND`,
    `DROP TASK IF EXISTS ${eventsTaskName}`,
    `DROP DATABASE IF EXISTS ${safeName(setup.database, 'database')}`,
    `DROP CONNECTION IF EXISTS agent_s3`,
    `ALTER WAREHOUSE '${warehouse}' SUSPEND`,
    `DROP WAREHOUSE IF EXISTS '${warehouse}'`,
  ];
};
