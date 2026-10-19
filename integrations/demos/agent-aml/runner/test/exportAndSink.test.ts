import { describe, expect, it } from 'vitest';
import type { Alert } from '../src/domain';
import { pointInTimeMs } from '../src/branchPlan';
import { buildExportArgs, buildExportWhere, exportUri, redactArgs } from '../src/exportPlan';
import { flagRow, runEventRow, truthRow } from '../src/sinkRows';
import { alertsPerMinute, elapsedSeconds } from '../src/tickMath';

describe('export plan', () => {
  it('puts each export batch under its own prefix', () => {
    expect(exportUri({ bucket: 'b', batch: 2 })).toBe('s3://b/lake/export/transactions/batch-02/');
  });

  it('builds a bounded where clause for a second export', () => {
    expect(buildExportWhere({ afterTxnId: 12000, upToTxnId: 12900 })).toBe('txn_id > 12000 AND txn_id <= 12900');
    expect(buildExportWhere({})).toBeUndefined();
  });

  const args = buildExportArgs({
    clusterId: 'c1',
    database: 'harbor_core',
    table: 'transactions',
    s3Uri: 's3://b/lake/export/transactions/batch-01/',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'shh',
    afterTxnId: 0,
    upToTxnId: 10198,
  });

  it('exports one table as Parquet to S3 without prompting', () => {
    expect(args.slice(0, 3)).toEqual(['serverless', 'export', 'create']);
    expect(args).toContain('--filter');
    expect(args[args.indexOf('--filter') + 1]).toBe('harbor_core.transactions');
    expect(args[args.indexOf('--file-type') + 1]).toBe('PARQUET');
    expect(args[args.indexOf('--where') + 1]).toBe('txn_id > 0 AND txn_id <= 10198');
    expect(args.at(-1)).toBe('--force');
  });

  it('redacts the access key and secret before the arguments are logged', () => {
    const logged = redactArgs(args).join(' ');
    expect(logged).not.toContain('AKIAEXAMPLE');
    expect(logged).not.toContain('shh');
    expect(logged).toContain('--s3.access-key-id <redacted>');
  });
});

describe('pointInTimeMs', () => {
  it('branches one second after the commit when that is safely in the past', () => {
    expect(pointInTimeMs({ committedAtMs: 10_000, nowMs: 60_000 })).toBe(11_000);
  });

  it('never asks for a timestamp closer than two seconds to now', () => {
    expect(pointInTimeMs({ committedAtMs: 59_500, nowMs: 60_000 })).toBe(58_000);
  });
});

describe('tick math', () => {
  it('scales alerts per tick to alerts per minute', () => {
    expect(alertsPerMinute({ newAlerts: 3, tickWallMs: 2000 })).toBe(90);
    expect(alertsPerMinute({ newAlerts: 3, tickWallMs: 0 })).toBe(0);
  });

  it('reports elapsed seconds and clamps clock skew to zero', () => {
    expect(elapsedSeconds(1000, 3500)).toBe(2.5);
    expect(elapsedSeconds(3500, 1000)).toBe(0);
  });
});

describe('sink rows', () => {
  const alert: Alert = {
    ruleId: 'structuring',
    ruleVersion: 'v1',
    accountId: 'ACC-0001',
    windowStartMs: 0,
    windowEndMs: 0,
    raisedAtMs: Date.UTC(2026, 3, 1, 12, 30, 0),
    bucket: 2900,
    txnIds: [],
    score: 3,
  };

  it('labels every flag row as a simulated verdict with a scope', () => {
    expect(flagRow({ runId: 'r1', alert, scope: 'branch-shadow', verdict: 'confirmed' })).toEqual({
      flag_id: 'r1:branch-shadow:structuring:v1:ACC-0001:2900',
      rule_id: 'structuring',
      rule_version: 'v1',
      account_id: 'ACC-0001',
      scope: 'branch-shadow',
      verdict: 'confirmed',
      simulated: 1,
      raised_at: '2026-04-01 12:30:00',
    });
  });

  it('formats ground truth and run event rows with Lake-friendly timestamps', () => {
    expect(truthRow({ accountId: 'RNG-0001', pattern: 'structuring', injectedAtMs: Date.UTC(2026, 3, 1) })).toEqual({
      account_id: 'RNG-0001',
      pattern: 'structuring',
      injected_at: '2026-04-01 00:00:00',
    });
    expect(
      runEventRow({ runId: 'r1', seq: 4, kind: 'case.opened', caseId: 'CASE-0001', detail: 'ok', atMs: 0 }).emitted_at,
    ).toBe('1970-01-01 00:00:00');
  });
});
