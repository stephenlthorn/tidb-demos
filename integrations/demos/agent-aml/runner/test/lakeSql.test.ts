import { describe, expect, it } from 'vitest';
import {
  buildAccountLookbackSql,
  buildBandPeersSql,
  buildLakeSetupStatements,
  buildPlantedRecallSql,
  countHistoryUpTo,
  executeLoadTask,
  lookbackMonthsToMs,
  parsePlantedRecall,
  parseRuleEval,
  resetLakeStatements,
  teardownStatements,
} from '../src/lakeSql';

const setup = buildLakeSetupStatements({
  bucket: 'harbor-lab-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: "se'cret",
  warehouse: 'harbor_wh',
});

describe('buildLakeSetupStatements', () => {
  it('creates the database and four tables before any load object', () => {
    expect(setup[0]).toBe('CREATE DATABASE IF NOT EXISTS harbor');
    expect(setup.slice(1, 5).map((sql) => sql.match(/harbor\.(\w+)/)?.[1])).toEqual([
      'txn_history',
      'ground_truth',
      'flag_log',
      'run_events',
    ]);
  });

  it('escapes credentials and points the stage at the lake prefix', () => {
    const connection = setup.find((sql) => sql.startsWith('CREATE CONNECTION'));
    expect(connection).toContain("SECRET_ACCESS_KEY = 'se''cret'");
    expect(setup.find((sql) => sql.startsWith('CREATE STAGE'))).toContain("URL = 's3://harbor-lab-bucket/lake/'");
  });

  it('loads Parquet transactions and NDJSON events in one minute task, then resumes it', () => {
    const task = setup.find((sql) => sql.startsWith('CREATE TASK')) ?? '';
    expect(task).toContain("WAREHOUSE = 'harbor_wh' SCHEDULE = 1 MINUTE");
    expect(task).toContain("COPY INTO harbor.txn_history FROM @harbor_lake/export/transactions/ PATTERN = '.*[.]parquet' FILE_FORMAT = (TYPE = PARQUET);");
    expect(task).toContain("COPY INTO harbor.flag_log FROM @harbor_lake/events/flags/ PATTERN = '.*[.]ndjson' FILE_FORMAT = (TYPE = NDJSON);");
    expect(setup.at(-1)).toBe('ALTER TASK harbor_load RESUME');
    expect(executeLoadTask).toBe('EXECUTE TASK harbor_load');
  });
});

describe('resetLakeStatements', () => {
  it('truncates the four history tables so a re-record does not double count', () => {
    expect(resetLakeStatements.map((sql) => sql.replace('TRUNCATE TABLE harbor.', ''))).toEqual([
      'txn_history',
      'ground_truth',
      'flag_log',
      'run_events',
    ]);
  });
});

describe('teardownStatements', () => {
  it('suspends and drops the task before dropping what it reads from', () => {
    expect(teardownStatements[0]).toBe('ALTER TASK harbor_load SUSPEND');
    expect(teardownStatements.at(-1)).toBe('DROP DATABASE IF EXISTS harbor');
  });
});

describe('lookback builders', () => {
  it('counts history up to a transaction id cutoff', () => {
    expect(countHistoryUpTo(9000)).toBe('SELECT COUNT(*) AS n FROM harbor.txn_history WHERE txn_id <= 9000');
  });

  it('builds the band peers query over a months-wide range', () => {
    const until = Date.UTC(2026, 3, 1);
    const sql = buildBandPeersSql({
      lowerCents: 900_000,
      upperCents: 1_000_000,
      sinceMs: until - lookbackMonthsToMs(3),
      untilMs: until,
      minDeposits: 3,
    });
    expect(sql).toContain("txn_ts >= '2026-01-01 00:00:00'");
    expect(sql).toContain("txn_ts < '2026-04-01 00:00:00'");
    expect(sql).toContain('HAVING COUNT(*) >= 3');
  });

  it('refuses an account id that is not in the expected shape', () => {
    expect(() => buildAccountLookbackSql({ accountId: "ACC-0001' OR 1=1", sinceMs: 0, untilMs: 1 })).toThrow(
      'not an account id',
    );
  });

  it('refuses a non-integer month count', () => {
    expect(() => lookbackMonthsToMs(1.5)).toThrow('months must be a safe integer');
  });

  it('builds the planted recall query for one rule version only', () => {
    expect(buildPlantedRecallSql('v2')).toContain("f.rule_version = 'v2'");
    expect(() => buildPlantedRecallSql("v2' OR '1'='1")).toThrow('not a rule version');
  });
});

describe('result parsers', () => {
  it('derives precision from confirmed over flags', () => {
    expect(
      parseRuleEval([{ rule_id: 'structuring', rule_version: 'v1', scope: 'production', flags: '50', confirmed: '3', false_positives: '47' }]),
    ).toEqual([
      { ruleId: 'structuring', ruleVersion: 'v1', scope: 'production', flags: 50, confirmed: 3, falsePositives: 47, precision: 0.06 },
    ]);
  });

  it('derives recall from flagged over planted', () => {
    expect(parsePlantedRecall([{ pattern: 'structuring', planted: 3, flagged: 3 }])).toEqual([
      { pattern: 'structuring', planted: 3, flagged: 3, recall: 1 },
    ]);
  });
});
