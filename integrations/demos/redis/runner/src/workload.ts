import type { Pool } from 'mysql2/promise';
import type { Emitter, SampleWindow } from '@lab/runner-kit';
import { timed } from '@lab/runner-kit';
import type { RedisClient } from './redis-cache';
import { getCachedPayload, setCachedPayload } from './redis-cache';
import { readRowById, writeRowById } from './tidb-repo';
import { redisKeyForRow } from './keys';
import type { DemoState } from './mode';
import { isHotKeyStormActive } from './mode';

export type WorkloadCounters = {
  count: number;
};

export type WorkloadDeps = {
  readonly pool: Pool;
  readonly redis: RedisClient;
  readonly emitter: Emitter;
  readonly rowCount: number;
  readonly ttlSeconds: number;
  readonly hotKeyId: number;
  readonly getState: () => DemoState;
  readonly cacheReadLatencies: SampleWindow;
  readonly tidbReadLatencies: SampleWindow;
  readonly cacheHits: WorkloadCounters;
  readonly cacheMisses: WorkloadCounters;
  readonly tidbReadCount: WorkloadCounters;
  readonly redisOpCount: WorkloadCounters;
};

const randomRowId = (rowCount: number, hotKeyId: number, storming: boolean): number =>
  storming ? hotKeyId : Math.floor(Math.random() * rowCount) + 1;

export const runWriteTick = async (deps: WorkloadDeps): Promise<void> => {
  const id = randomRowId(deps.rowCount, deps.hotKeyId, false);
  await writeRowById(deps.pool, id, `payload-${Date.now()}`, Date.now());
  deps.emitter.flow('writes', 1);
};

export const runCacheReadTick = async (deps: WorkloadDeps): Promise<void> => {
  const storming = isHotKeyStormActive(deps.getState(), Date.now());
  const id = randomRowId(deps.rowCount, deps.hotKeyId, storming);
  const key = redisKeyForRow(id);
  const { value: cached, ms } = await timed(() => getCachedPayload(deps.redis, key));
  deps.cacheReadLatencies.add(ms);
  deps.redisOpCount.count += 1;
  if (cached === undefined) {
    deps.cacheMisses.count += 1;
    const row = await readRowById(deps.pool, id);
    if (row !== undefined) {
      await setCachedPayload(deps.redis, key, JSON.stringify(row), deps.ttlSeconds);
      deps.redisOpCount.count += 1;
    }
  } else {
    deps.cacheHits.count += 1;
  }
  deps.emitter.flow('cache-reads', 1);
};

export const runDirectReadTick = async (deps: WorkloadDeps): Promise<void> => {
  const storming = isHotKeyStormActive(deps.getState(), Date.now());
  const id = randomRowId(deps.rowCount, deps.hotKeyId, storming);
  const { ms } = await timed(() => readRowById(deps.pool, id));
  deps.tidbReadLatencies.add(ms);
  deps.tidbReadCount.count += 1;
  deps.emitter.flow('direct-reads', 1);
};
