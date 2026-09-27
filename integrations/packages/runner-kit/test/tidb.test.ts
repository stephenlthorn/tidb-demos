import { describe, expect, it } from 'vitest';
import { quoteIdentifier, tidbConfigFromEnv } from '../src/tidb';

describe('tidbConfigFromEnv', () => {
  it('defaults to a local playground', () => {
    expect(tidbConfigFromEnv({})).toEqual({
      host: '127.0.0.1',
      port: 4000,
      user: 'root',
      password: '',
      database: 'lab',
      enableKeepAlive: true,
      supportBigNumbers: true,
    });
  });

  it('reads host, port, user, password and database', () => {
    const config = tidbConfigFromEnv({
      TIDB_HOST: 'gateway.example.com',
      TIDB_PORT: '4001',
      TIDB_USER: 'demo.root',
      TIDB_PASSWORD: 'secret',
      TIDB_DATABASE: 'shop',
    });
    expect(config).toMatchObject({ host: 'gateway.example.com', port: 4001, user: 'demo.root', password: 'secret', database: 'shop' });
  });

  it('enables verified TLS when TIDB_TLS is true', () => {
    expect(tidbConfigFromEnv({ TIDB_TLS: 'true' }).ssl).toEqual({ minVersion: 'TLSv1.2', rejectUnauthorized: true });
  });

  it('leaves TLS off otherwise', () => {
    expect(tidbConfigFromEnv({ TIDB_TLS: 'false' }).ssl).toBeUndefined();
  });

  it('rejects a port that is not a number', () => {
    expect(() => tidbConfigFromEnv({ TIDB_PORT: 'four' })).toThrow('TIDB_PORT must be a number');
  });
});

describe('quoteIdentifier', () => {
  it('wraps a name in backticks', () => {
    expect(quoteIdentifier('orders')).toBe('`orders`');
  });

  it('doubles embedded backticks', () => {
    expect(quoteIdentifier('a`b')).toBe('`a``b`');
  });
});
