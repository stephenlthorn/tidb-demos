import { describe, expect, it } from 'vitest';
import { loadDemoConfig } from '../src/config';

const baseEnv = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  KAFKA_BROKERS: '127.0.0.1:9092',
  KAFKA_TOPIC: 'redis-demo.cache_rows',
  KAFKA_GROUP_ID: 'redis-demo-invalidator',
  REDIS_DEMO_ROW_COUNT: '500',
  REDIS_DEMO_TTL_SECONDS: '5',
  REDIS_DEMO_WRITE_RATE_MS: '200',
  REDIS_DEMO_READ_RATE_MS: '50',
  REDIS_DEMO_HOT_KEY_ID: '1',
  REDIS_DEMO_BURST_SIZE: '25',
};

describe('loadDemoConfig', () => {
  it('parses a complete env into typed config', () => {
    const config = loadDemoConfig(baseEnv);
    expect(config.rowCount).toBe(500);
    expect(config.ttlSeconds).toBe(5);
    expect(config.hotKeyId).toBe(1);
  });

  it('throws when a required variable is missing', () => {
    const { REDIS_URL, ...rest } = baseEnv;
    expect(() => loadDemoConfig(rest)).toThrow();
  });
});
