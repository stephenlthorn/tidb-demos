import { describe, expect, it } from 'vitest';
import { tidbConfigFromEnv } from '@lab/runner-kit';
import { branchEnv, branchUser } from '../src/branchEnv';

describe('branchUser', () => {
  it('prefixes a bare user name', () => {
    expect(branchUser({ userPrefix: '3pTAoNNegb47Uc8', user: 'reader' })).toBe('3pTAoNNegb47Uc8.reader');
  });

  it('swaps the instance prefix for the branch prefix on a prefixed user', () => {
    expect(branchUser({ userPrefix: 'branchpfx', user: 'instpfx.reader' })).toBe('branchpfx.reader');
  });

  it('keeps a user that already carries the branch prefix', () => {
    expect(branchUser({ userPrefix: 'abc', user: 'abc.reader' })).toBe('abc.reader');
  });

  it('keeps the user when no prefix is known', () => {
    expect(branchUser({ userPrefix: undefined, user: 'reader' })).toBe('reader');
  });
});

describe('branchEnv', () => {
  const env = branchEnv({
    base: { TIDB_HOST: 'org-host', S3_BUCKET: 'b', UNSET: undefined },
    host: 'branch-host',
    port: 4000,
    user: 'p.reader',
    password: 'pw',
    database: 'harbor_core',
  });

  it('points the standard TiDB variables at the branch with TLS on', () => {
    expect(env).toMatchObject({
      TIDB_HOST: 'branch-host',
      TIDB_PORT: '4000',
      TIDB_USER: 'p.reader',
      TIDB_PASSWORD: 'pw',
      TIDB_DATABASE: 'harbor_core',
      TIDB_TLS: 'true',
      TIDB_POOL_SIZE: '2',
    });
  });

  it('keeps unrelated variables and drops undefined ones', () => {
    expect(env.S3_BUCKET).toBe('b');
    expect('UNSET' in env).toBe(false);
  });

  it('is accepted by the shared connection config builder', () => {
    expect(tidbConfigFromEnv(env)).toMatchObject({ host: 'branch-host', port: 4000, user: 'p.reader' });
  });
});
