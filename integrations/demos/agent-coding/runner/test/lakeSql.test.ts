import { describe, expect, it } from 'vitest';
import {
  buildFailureInsert,
  countLedgerSql,
  countMarkerSql,
  countRunEventsSql,
  createWarehouseSql,
  lakeBootstrapStatements,
  lakeSetupStatements,
  lakeTeardownStatements,
  matchResetSql,
  mergedPerDollarSql,
  similarFailuresSql,
} from '../src/lakeSql';

const setup = {
  warehouse: 'agent-coding-wh',
  database: 'agent_coding',
  bucket: 'lab-agent-coding-123',
  prefix: '/agent-coding/',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret/with+chars',
};

describe('lakeSetupStatements', () => {
  const statements = lakeSetupStatements(setup);

  it('points the stages at the events and ledger prefixes', () => {
    expect(statements.some((sql) => sql.includes("URL = 's3://lab-agent-coding-123/agent-coding/events/'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("URL = 's3://lab-agent-coding-123/agent-coding/ledger/'"))).toBe(true);
  });

  it('creates a task that loads NDJSON every minute and then resumes it', () => {
    const task = statements.find((sql) => sql.startsWith('CREATE OR REPLACE TASK'));
    expect(task).toContain("WAREHOUSE = 'agent-coding-wh'");
    expect(task).toContain('SCHEDULE = 1 MINUTE');
    expect(task).toContain("PATTERN = '.*[.]ndjson'");
    expect(statements.at(-1)).toBe('ALTER TASK ingest_run_events RESUME');
  });

  it('indexes the message column for full-text search and the failure vector for similarity', () => {
    expect(statements.some((sql) => sql.includes('CREATE INVERTED INDEX idx_run_events_message ON run_events(message)'))).toBe(true);
    expect(statements.some((sql) => sql.includes("VECTOR INDEX idx_failure_vec(vec) distance = 'cosine'"))).toBe(true);
  });

  it('rejects a secret that would break out of the literal', () => {
    expect(() => lakeSetupStatements({ ...setup, secretAccessKey: "x' OR 1=1" })).toThrow('secret access key');
  });

  it('rejects an invalid warehouse name', () => {
    expect(() => lakeSetupStatements({ ...setup, warehouse: "a'b" })).toThrow('warehouse');
  });
});

describe('bootstrap and warehouse statements', () => {
  it('creates the database', () => {
    expect(lakeBootstrapStatements(setup)).toEqual(['CREATE DATABASE IF NOT EXISTS agent_coding']);
  });

  it('creates an extra small warehouse that suspends after the minimum idle time', () => {
    expect(createWarehouseSql('agent-coding-wh')).toBe(
      "CREATE WAREHOUSE IF NOT EXISTS 'agent-coding-wh' WITH warehouse_size = XSmall auto_suspend = 300",
    );
  });
});

describe('eval and count queries', () => {
  it('counts live events for one run', () => {
    expect(countRunEventsSql('run-1')).toBe("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'run-1' AND source = 'live'");
  });

  it('counts exported ledger rows for one run', () => {
    expect(countLedgerSql('run-1')).toBe("SELECT COUNT(*) AS n FROM ledger_lake WHERE run_id = 'run-1'");
  });

  it('counts a marker by id', () => {
    expect(countMarkerSql({ runId: 'run-1', markerId: 'mk-1' })).toContain("message = 'mk-1'");
  });

  it('finds gateway resets with full-text match', () => {
    expect(matchResetSql).toContain("MATCH(message, 'ECONNRESET')");
  });

  it('prices merged attempts per model', () => {
    expect(mergedPerDollarSql).toContain('GROUP BY model');
    expect(mergedPerDollarSql).toContain('/ SUM(cost_usd)');
  });

  it('ranks past failures by cosine distance and skips the current run', () => {
    const sql = similarFailuresSql({ runId: 'run-1', vector: [0.5, 0.5], limit: 3 });
    expect(sql).toContain('COSINE_DISTANCE(vec, [0.5,0.5])');
    expect(sql).toContain("run_id <> 'run-1'");
    expect(sql).toContain('LIMIT 3');
  });

  it('rejects an id with a quote', () => {
    expect(() => countRunEventsSql("a'b")).toThrow('run id');
  });
});

describe('buildFailureInsert', () => {
  it('writes one tuple per row with a vector literal', () => {
    const sql = buildFailureInsert([
      { run_id: 'r1', attempt_id: 'attempt-1', message: 'ECONNRESET at step 7', vector: [1, 0] },
      { run_id: 'r2', attempt_id: 'attempt-2', message: 'AssertionError at step 4', vector: [0, 1] },
    ]);
    expect(sql).toBe(
      "INSERT INTO run_failures (run_id, attempt_id, message, vec) VALUES\n('r1', 'attempt-1', 'ECONNRESET at step 7', [1,0]),\n('r2', 'attempt-2', 'AssertionError at step 4', [0,1])",
    );
  });

  it('refuses an empty batch', () => {
    expect(() => buildFailureInsert([])).toThrow(RangeError);
  });
});

describe('lakeTeardownStatements', () => {
  it('suspends the task and warehouse and drops what the demo created', () => {
    expect(lakeTeardownStatements(setup)).toEqual([
      'ALTER TASK ingest_run_events SUSPEND',
      'DROP TASK IF EXISTS ingest_run_events',
      'DROP DATABASE IF EXISTS agent_coding',
      'DROP CONNECTION IF EXISTS agent_s3',
      "ALTER WAREHOUSE 'agent-coding-wh' SUSPEND",
      "DROP WAREHOUSE IF EXISTS 'agent-coding-wh'",
    ]);
  });
});
