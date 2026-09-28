import { z } from 'zod';
import type { Pool } from 'mysql2/promise';
import type { Emitter } from '@lab/runner-kit';
import type { RedisClient } from './redis-cache';
import { getCachedPayload } from './redis-cache';
import { readRowById } from './tidb-repo';
import { redisKeyForRow } from './keys';
import { isStaleRead, versionsMismatch } from './staleness';

const CachedPayloadSchema = z.object({ version: z.number() });

export type StalenessSample = {
  readonly ratePercent: number;
  readonly staleCount: number;
  readonly sampleCount: number;
};

export const sampleStaleness = async (
  pool: Pool,
  redis: RedisClient,
  emitter: Emitter,
  sampleIds: readonly number[],
): Promise<StalenessSample> => {
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
  const sampleCount = sampleIds.length;
  const ratePercent = sampleCount === 0 ? 0 : Math.round((staleCount / sampleCount) * 10_000) / 100;
  return { ratePercent, staleCount, sampleCount };
};

export type VersionsConvergeSample = {
  readonly mismatchedRowIds: readonly number[];
  readonly sampledRowCount: number;
};

export const sampleVersionsConverge = async (
  pool: Pool,
  redis: RedisClient,
  emitter: Emitter,
  rowIds: readonly number[],
): Promise<VersionsConvergeSample> => {
  const mismatchedRowIds: number[] = [];
  let sampledRowCount = 0;
  for (const id of rowIds) {
    const cachedRaw = await getCachedPayload(redis, redisKeyForRow(id));
    const tidbRow = await readRowById(pool, id);
    emitter.flow('sampler-tidb', 1);
    emitter.flow('sampler-redis', 1);
    if (cachedRaw === undefined || tidbRow === undefined) continue;
    const cachedPayload = CachedPayloadSchema.safeParse(JSON.parse(cachedRaw));
    if (!cachedPayload.success) continue;
    sampledRowCount += 1;
    if (versionsMismatch({ cachedVersion: cachedPayload.data.version, tidbVersion: tidbRow.version })) {
      mismatchedRowIds.push(id);
    }
  }
  return { mismatchedRowIds, sampledRowCount };
};
