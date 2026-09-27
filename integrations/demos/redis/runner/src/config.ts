import { z } from 'zod';

const EnvSchema = z.object({
  REDIS_URL: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  KAFKA_TOPIC: z.string().min(1),
  KAFKA_GROUP_ID: z.string().min(1),
  REDIS_DEMO_ROW_COUNT: z.coerce.number().int().positive(),
  REDIS_DEMO_TTL_SECONDS: z.coerce.number().int().positive(),
  REDIS_DEMO_WRITE_RATE_MS: z.coerce.number().int().positive(),
  REDIS_DEMO_READ_RATE_MS: z.coerce.number().int().positive(),
  REDIS_DEMO_HOT_KEY_ID: z.coerce.number().int().positive(),
  REDIS_DEMO_BURST_SIZE: z.coerce.number().int().positive(),
});

export type DemoConfig = {
  readonly redisUrl: string;
  readonly kafkaBrokers: readonly string[];
  readonly kafkaTopic: string;
  readonly kafkaGroupId: string;
  readonly rowCount: number;
  readonly ttlSeconds: number;
  readonly writeRateMs: number;
  readonly readRateMs: number;
  readonly hotKeyId: number;
  readonly burstSize: number;
};

export const loadDemoConfig = (env: Record<string, string | undefined>): DemoConfig => {
  const parsed = EnvSchema.parse(env);
  return {
    redisUrl: parsed.REDIS_URL,
    kafkaBrokers: parsed.KAFKA_BROKERS.split(','),
    kafkaTopic: parsed.KAFKA_TOPIC,
    kafkaGroupId: parsed.KAFKA_GROUP_ID,
    rowCount: parsed.REDIS_DEMO_ROW_COUNT,
    ttlSeconds: parsed.REDIS_DEMO_TTL_SECONDS,
    writeRateMs: parsed.REDIS_DEMO_WRITE_RATE_MS,
    readRateMs: parsed.REDIS_DEMO_READ_RATE_MS,
    hotKeyId: parsed.REDIS_DEMO_HOT_KEY_ID,
    burstSize: parsed.REDIS_DEMO_BURST_SIZE,
  };
};
