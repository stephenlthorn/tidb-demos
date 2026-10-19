import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { exportState, parseExportId } from '../src/exportParse';
import { createSerialQueue } from '../src/queue';

const baseEnv = {
  AML_CLUSTER_ID: 'c-1',
  S3_BUCKET: 'harbor-lab-bucket',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'shh',
  LAKE_WAREHOUSE: 'harbor_wh',
};

describe('loadConfig', () => {
  it('applies defaults and reads the reporting threshold as a configurable constant', () => {
    const config = loadConfig(baseEnv);
    expect(config).toMatchObject({
      region: 'us-east-1',
      historyDays: 90,
      tickMs: 2000,
      thresholdCents: 1_000_000,
      reset: false,
      firstDayStartMs: Date.UTC(2026, 0, 5),
    });
  });

  it('lets the environment override the threshold and the seed', () => {
    const config = loadConfig({ ...baseEnv, AML_REPORTING_THRESHOLD_CENTS: '500000', AML_SEED: '7', AML_RESET: 'true' });
    expect(config).toMatchObject({ thresholdCents: 500_000, seed: 7, reset: true });
  });

  it('names the missing variable when a required one is absent', () => {
    expect(() => loadConfig({ ...baseEnv, S3_BUCKET: undefined })).toThrow('S3_BUCKET');
  });
});

describe('createSerialQueue', () => {
  it('runs tasks one at a time in submission order', async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    const slow = queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    const fast = queue.enqueue(async () => {
      order.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('keeps running later tasks after one fails, and still rejects the failed caller', async () => {
    const queue = createSerialQueue();
    const failed = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const later = queue.enqueue(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(later).resolves.toBe('ok');
  });
});

describe('export output parsing', () => {
  it('reads an export id from labelled text or JSON', () => {
    expect(parseExportId('Export ID: exp_8f3a21c0')).toBe('exp_8f3a21c0');
    expect(parseExportId('{"id":"exp-123abc","state":"RUNNING"}')).toBe('exp-123abc');
    expect(parseExportId('nothing useful')).toBeUndefined();
  });

  it('classifies export status text', () => {
    expect(exportState('state: RUNNING')).toBe('running');
    expect(exportState('state: SUCCEEDED')).toBe('done');
    expect(exportState('state: FAILED')).toBe('failed');
  });
});
