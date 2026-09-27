import { createClient } from 'redis';

export type RedisClient = ReturnType<typeof createClient>;

export const createDemoRedisClient = (url: string): RedisClient => createClient({ url });

export const getCachedPayload = async (client: RedisClient, key: string): Promise<string | undefined> => {
  const value = await client.get(key);
  return value ?? undefined;
};

export const setCachedPayload = async (
  client: RedisClient,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> => {
  await client.set(key, value, { expiration: { type: 'EX', value: ttlSeconds } });
};

export const deleteCachedPayload = async (client: RedisClient, key: string): Promise<void> => {
  await client.del(key);
};
