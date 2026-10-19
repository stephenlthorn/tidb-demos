import { describe, expect, it } from 'vitest';
import { isReadStatement, lakeConfigFromEnv, zipRecord } from '../src/lake-config';

const baseEnv = {
  LAKE_HOST: 'tenant.lake.example.com',
  LAKE_USER: 'lab',
  LAKE_PASSWORD: 'p@ss:word',
  LAKE_WAREHOUSE: 'agent-coding-wh',
  LAKE_DATABASE: 'agent_coding',
};

describe('lakeConfigFromEnv', () => {
  it('builds a DSN with encoded credentials and the warehouse parameter', () => {
    expect(lakeConfigFromEnv(baseEnv)).toEqual({
      dsn: 'lake://lab:p%40ss%3Aword@tenant.lake.example.com:443/agent_coding?warehouse=agent-coding-wh',
      warehouse: 'agent-coding-wh',
      database: 'agent_coding',
    });
  });

  it('honours an explicit port and defaults the database', () => {
    const config = lakeConfigFromEnv({ ...baseEnv, LAKE_PORT: '8443', LAKE_DATABASE: undefined });
    expect(config.dsn).toContain('@tenant.lake.example.com:8443/default?');
  });

  it('treats an empty database and port as unset', () => {
    const config = lakeConfigFromEnv({ ...baseEnv, LAKE_DATABASE: '', LAKE_PORT: '' });
    expect(config.dsn).toContain('@tenant.lake.example.com:443/default?');
  });

  it('names the missing variable', () => {
    expect(() => lakeConfigFromEnv({ ...baseEnv, LAKE_HOST: undefined })).toThrow('missing required env var: LAKE_HOST');
  });
});

describe('isReadStatement', () => {
  it('treats queries as reads', () => {
    expect(isReadStatement('  SELECT 1')).toBe(true);
    expect(isReadStatement('with x as (select 1) select * from x')).toBe(true);
    expect(isReadStatement('SHOW TASKS')).toBe(true);
  });

  it('treats DDL and DML as writes', () => {
    expect(isReadStatement('CREATE TABLE t (a INT)')).toBe(false);
    expect(isReadStatement('COPY INTO t FROM @s')).toBe(false);
    expect(isReadStatement('ALTER TASK x RESUME')).toBe(false);
  });
});

describe('zipRecord', () => {
  it('pairs column names with values', () => {
    expect(zipRecord(['a', 'b'], [1, 'x'])).toEqual({ a: 1, b: 'x' });
  });

  it('leaves a missing value undefined', () => {
    expect(zipRecord(['a', 'b'], [1])).toEqual({ a: 1, b: undefined });
  });
});
