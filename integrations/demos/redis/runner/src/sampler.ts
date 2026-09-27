import { z } from 'zod';
import type { Pool } from 'mysql2/promise';
import type { Emitter } from '@lab/runner-kit';
import type { RedisClient } from './redis-cache';
import { getCachedPayload } from './redis-cache';
import { readRowById } from './tidb-repo';
import { redisKeyForRow } from './keys';
import { isStaleRead } from './staleness';

const CachedPayloadSchema = z.object({ version: z.number() });

export const sampleStaleness = async (
  pool: Pool,
  redis: RedisClient,
  emitter: Emitter,
  sampleIds: readonly number[],
): Promise<number> => {
  let staleCount = 0;
  for (const id of sampleIds) {
    const cachedRaw = await getCachedPayload(redis, redisKeyForRow(id));
    const tidbRow = await readRowById(pool, id);
    emitter.flow('sampler-tidb', 1);
    emitter.flow('sampler-redis', 1);
    if (cachedRaw === undefined || tidbRow === undefined) continue;
    const cachedPayload = CachedPayloadSchema.safeParse(JSON.parse(cachedRaw));
    if (!cachedPayload.success) continue;
    if (isStaleRead({ cachedVersion: cachedPayload.data.version, tidbVersion: tidbRow.version })) staleCount += 1;
  }
  return sampleIds.length === 0 ? 0 : Math.round((staleCount / sampleIds.length) * 10_000) / 100;
};
