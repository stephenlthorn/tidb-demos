import { describe, expect, it } from 'vitest';
import { buildExportArgs, parseExportId, parseExportState } from '../src/ticloudExport';

describe('buildExportArgs', () => {
  it('exports one table to S3 as Parquet without a prompt', () => {
    const args = buildExportArgs({
      clusterId: 'c1',
      s3Uri: 's3://b/agent-coding/ledger/run-1',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      filter: 'agent_coding.ledger',
    });
    expect(args.slice(0, 3)).toEqual(['serverless', 'export', 'create']);
    expect(args).toEqual(expect.arrayContaining(['--file-type', 'PARQUET', '--filter', 'agent_coding.ledger', '--force']));
    expect(args[args.indexOf('--s3.uri') + 1]).toBe('s3://b/agent-coding/ledger/run-1');
  });
});

describe('parseExportId', () => {
  it('reads a JSON id', () => {
    expect(parseExportId('{"exportId":"exp-123abc"}')).toBe('exp-123abc');
  });

  it('reads a text line', () => {
    expect(parseExportId('Export task created. Export ID: exp-456def')).toBe('exp-456def');
  });

  it('throws when nothing matches', () => {
    expect(() => parseExportId('ok')).toThrow('export id not found in output');
  });
});

describe('parseExportState', () => {
  it('classifies the three outcomes', () => {
    expect(parseExportState('state: COMPLETED')).toBe('completed');
    expect(parseExportState('state: FAILED')).toBe('failed');
    expect(parseExportState('state: RUNNING')).toBe('running');
  });
});
