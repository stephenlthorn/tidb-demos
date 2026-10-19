import { describe, expect, it } from 'vitest';
import { makeRunId, runConfigFromEnv } from '../src/config';

const env = {
  AGENT_ORG_CLUSTER_ID: 'org-1',
  AGENT_FIXTURE_CLUSTER_ID: 'fix-1',
  FIXTURE_SQL_USER: 'reader',
  FIXTURE_SQL_PASSWORD: 'pw',
  S3_BUCKET: 'lab-bucket',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  LAKE_WAREHOUSE: 'agent-coding-wh',
};

const options = { fixturesDir: '/repo/fixtures', now: new Date('2026-10-17T10:11:12Z'), homeDir: '/home/lab' };

describe('makeRunId', () => {
  it('encodes the start time to the second', () => {
    expect(makeRunId(new Date('2026-10-17T10:11:12Z'))).toBe('run-20261017-101112');
  });
});

describe('runConfigFromEnv', () => {
  it('applies the documented defaults', () => {
    const config = runConfigFromEnv(env, options);
    expect(config).toMatchObject({
      runId: 'run-20261017-101112',
      ticket: { id: 'KIT-8812', title: 'fix double charge on retried payments' },
      workDir: '/home/lab/lab-agent-coding-work',
      fixtureDatabase: 'fixture',
      branchQuota: 5,
      stepWaitMs: 1000,
      autoRun: false,
      executeLakeTask: false,
      region: 'us-east-1',
      prefix: 'agent-coding',
      lakeDatabase: 'agent_coding',
    });
  });

  it('reads overrides', () => {
    const config = runConfigFromEnv(
      { ...env, STEP_WAIT_MS: '1500', AUTO_RUN: 'true', LAKE_EXECUTE_TASK: 'true', WORK_DIR: '/data/w' },
      options,
    );
    expect(config).toMatchObject({ stepWaitMs: 1500, autoRun: true, executeLakeTask: true, workDir: '/data/w' });
  });

  it('treats empty optional variables as unset', () => {
    const config = runConfigFromEnv({ ...env, WORK_DIR: '', S3_REGION: '', S3_PREFIX: '', LAKE_DATABASE: '', FIXTURE_DATABASE: '' }, options);
    expect(config).toMatchObject({
      workDir: '/home/lab/lab-agent-coding-work',
      region: 'us-east-1',
      prefix: 'agent-coding',
      lakeDatabase: 'agent_coding',
      fixtureDatabase: 'fixture',
    });
  });

  it('names a missing required variable', () => {
    expect(() => runConfigFromEnv({ ...env, S3_BUCKET: undefined }, options)).toThrow('missing required env var: S3_BUCKET');
  });

  it('rejects a number that is not numeric', () => {
    expect(() => runConfigFromEnv({ ...env, BRANCH_QUOTA: 'five' }, options)).toThrow('BRANCH_QUOTA must be a number');
  });
});
