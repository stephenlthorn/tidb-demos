import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createEmitter, createSampleWindow, createTidbPool, every, onControl, summarize } from '@lab/runner-kit';
import { loadDemoConfig } from './src/config';
import { initSchema, seedRows } from './src/tidb-repo';
import { createDemoRedisClient } from './src/redis-cache';
import { runInvalidator } from './src/invalidator';
import { sampleStaleness, sampleVersionsConverge } from './src/sampler';
import { runCacheReadTick, runDirectReadTick, runWriteTick } from './src/workload';
import { applyControl, initialDemoState } from './src/mode';
import {
  evaluateCdcZeroStale,
  evaluateVersionsConverge,
  initialCheckLatchState,
  nextCheckState,
} from './src/checks';
import { computeOffsetDelta, sumHighWatermarks } from './src/topic-offsets';
import { withTimeout } from './src/shutdown';

const SAMPLE_TICK_MS = 1_000;
const SAMPLE_SIZE = 20;
const HOT_KEY_STORM_DURATION_MS = 10_000;

const main = async (): Promise<void> => {
  const config = loadDemoConfig(process.env);
  const emitter = createEmitter();
  const pool = createTidbPool(process.env);
  const redis = createDemoRedisClient(config.redisUrl);
  await redis.connect();

  emitter.node('tidb', 'starting');
  await initSchema(pool);
  await seedRows(pool, config.rowCount);
  emitter.node('tidb', 'healthy');
  emitter.node('redis', 'healthy');
  emitter.node('workload', 'healthy');
  emitter.node('sampler', 'healthy');
  emitter.node('invalidator', 'idle');
  emitter.check('cdc-zero-stale', 'pending');
  emitter.check('versions-converge', 'pending');

  let state = initialDemoState();
  const getState = () => state;
  let lastBurstAtMs: number | undefined;
  let burstRowIds: readonly number[] = [];
  let lastKnownLagP99Ms: number | undefined;
  let frozenLagP99Ms: number | undefined;
  let cdcZeroStaleLatch = initialCheckLatchState();
  let versionsConvergeLatch = initialCheckLatchState();
  let previousTopicOffsetTotal: number | undefined;

  const cacheReadLatencies = createSampleWindow();
  const tidbReadLatencies = createSampleWindow();
  const lagSamples = createSampleWindow();
  const cacheHits = { count: 0 };
  const cacheMisses = { count: 0 };
  const tidbReadCount = { count: 0 };
  const redisOpCount = { count: 0 };

  const workloadDeps = {
    pool,
    redis,
    emitter,
    rowCount: config.rowCount,
    ttlSeconds: config.ttlSeconds,
    hotKeyId: config.hotKeyId,
    getState,
    cacheReadLatencies,
    tidbReadLatencies,
    cacheHits,
    cacheMisses,
    tidbReadCount,
    redisOpCount,
  };

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  onControl((id) => {
    const nowMs = emitter.elapsedMs();
    if (id === 'toggle-mode') {
      state = applyControl(state, { id: 'toggle-mode', nowMs });
      emitter.node('invalidator', state.invalidationMode === 'cdc' ? 'busy' : 'idle');
      emitter.phase(state.invalidationMode === 'cdc' ? 'cdc-invalidation' : 'ttl-only');
    }
    if (id === 'hot-key-storm') {
      state = applyControl(state, { id: 'hot-key-storm', nowMs, hotKeyStormDurationMs: HOT_KEY_STORM_DURATION_MS });
      emitter.phase('tidb-direct');
    }
    if (id === 'write-burst') {
      lastBurstAtMs = nowMs;
      frozenLagP99Ms = lastKnownLagP99Ms;
      const ids = Array.from({ length: config.burstSize }, () => Math.floor(Math.random() * config.rowCount) + 1);
      burstRowIds = ids;
      cdcZeroStaleLatch = initialCheckLatchState();
      versionsConvergeLatch = initialCheckLatchState();
      emitter.check('cdc-zero-stale', cdcZeroStaleLatch.status);
      emitter.check('versions-converge', versionsConvergeLatch.status);
      ids.forEach((rowId) => {
        void runWriteTick(workloadDeps, rowId);
      });
    }
  });

  const invalidatorHandle = await runInvalidator({
    kafkaBrokers: config.kafkaBrokers,
    topic: config.kafkaTopic,
    groupId: config.kafkaGroupId,
    redis,
    emitter,
    lagSamples,
    getState,
    signal: controller.signal,
  });

  const topicAdminKafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [...config.kafkaBrokers], logLevel: KafkaJS.logLevel.NOTHING },
  });
  const topicAdmin = topicAdminKafka.admin();
  await topicAdmin.connect();

  emitter.phase('ttl-only');

  const metricsLoop = every({
    intervalMs: SAMPLE_TICK_MS,
    signal: controller.signal,
    task: async () => {
      const sampleIds = Array.from({ length: SAMPLE_SIZE }, () => Math.floor(Math.random() * config.rowCount) + 1);
      const staleSample = await sampleStaleness(pool, redis, emitter, sampleIds);
      emitter.metric('stale-read-rate', staleSample.ratePercent);
      const totalCacheReads = cacheHits.count + cacheMisses.count;
      emitter.metric(
        'cache-hit-ratio',
        totalCacheReads === 0 ? 0 : Math.round((cacheHits.count / totalCacheReads) * 10_000) / 100,
      );
      emitter.metric('tidb-qps', tidbReadCount.count);
      emitter.metric('redis-ops-s', redisOpCount.count);
      const cacheSummary = summarize(cacheReadLatencies.drain());
      if (cacheSummary !== undefined) {
        emitter.metric('redis-read-p50', cacheSummary.p50);
        emitter.metric('redis-read-p99', cacheSummary.p99);
      }
      const tidbSummary = summarize(tidbReadLatencies.drain());
      if (tidbSummary !== undefined) {
        emitter.metric('tidb-read-p50', tidbSummary.p50);
        emitter.metric('tidb-read-p99', tidbSummary.p99);
      }
      const lagSummary = summarize(lagSamples.drain());
      if (lagSummary !== undefined) {
        emitter.metric('invalidation-lag-p50', lagSummary.p50);
        emitter.metric('invalidation-lag-p99', lagSummary.p99);
        lastKnownLagP99Ms = lagSummary.p99;
        if (frozenLagP99Ms === undefined && lastBurstAtMs !== undefined) {
          frozenLagP99Ms = lagSummary.p99;
        }
      }
      tidbReadCount.count = 0;
      redisOpCount.count = 0;
      cacheHits.count = 0;
      cacheMisses.count = 0;

      const msSinceLastBurst = lastBurstAtMs === undefined ? undefined : emitter.elapsedMs() - lastBurstAtMs;

      if (!cdcZeroStaleLatch.settled) {
        const cdcZeroStale = evaluateCdcZeroStale({
          mode: state.invalidationMode,
          msSinceLastBurst,
          invalidationLagP99Ms: frozenLagP99Ms,
          staleCount: staleSample.staleCount,
          sampleCount: staleSample.sampleCount,
        });
        const next = nextCheckState({ current: cdcZeroStaleLatch, outcome: cdcZeroStale.status });
        cdcZeroStaleLatch = next.state;
        if (next.emit) emitter.check('cdc-zero-stale', next.state.status, cdcZeroStale.observed);
      }

      if (!versionsConvergeLatch.settled) {
        const convergeSample =
          lastBurstAtMs === undefined
            ? { mismatchedRowIds: [], sampledRowCount: 0 }
            : await sampleVersionsConverge(pool, redis, emitter, burstRowIds);
        const versionsConverge = evaluateVersionsConverge({
          mode: state.invalidationMode,
          msSinceLastBurst,
          invalidationLagP99Ms: frozenLagP99Ms,
          ttlMs: config.ttlSeconds * 1_000,
          mismatchedRowIds: convergeSample.mismatchedRowIds,
          sampledRowCount: convergeSample.sampledRowCount,
        });
        const next = nextCheckState({ current: versionsConvergeLatch, outcome: versionsConverge.status });
        versionsConvergeLatch = next.state;
        if (next.emit) emitter.check('versions-converge', next.state.status, versionsConverge.observed);
      }
    },
  });

  const topicOffsetLoop = every({
    intervalMs: SAMPLE_TICK_MS,
    signal: controller.signal,
    task: async () => {
      try {
        const offsets = await topicAdmin.fetchTopicOffsets(config.kafkaTopic);
        const currentTotal = sumHighWatermarks(offsets);
        const delta = computeOffsetDelta({ previousTotal: previousTopicOffsetTotal, currentTotal });
        previousTopicOffsetTotal = currentTotal;
        emitter.flow('row-changes', delta);
        emitter.flow('change-events', delta);
      } catch (error: unknown) {
        emitter.log('warn', `failed to fetch topic offsets for ${config.kafkaTopic}: ${String(error)}`);
      }
    },
  });

  await Promise.all([
    every({
      intervalMs: config.writeRateMs,
      signal: controller.signal,
      task: async () => {
        await runWriteTick(workloadDeps);
      },
    }),
    every({ intervalMs: config.readRateMs, signal: controller.signal, task: () => runCacheReadTick(workloadDeps) }),
    every({ intervalMs: config.readRateMs, signal: controller.signal, task: () => runDirectReadTick(workloadDeps) }),
    metricsLoop,
    topicOffsetLoop,
    invalidatorHandle.drainLoop,
  ]);

  const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;
  await withTimeout(invalidatorHandle.stop(), SHUTDOWN_STEP_TIMEOUT_MS, undefined);
  await withTimeout(topicAdmin.disconnect(), SHUTDOWN_STEP_TIMEOUT_MS, undefined);
  await withTimeout(redis.quit(), SHUTDOWN_STEP_TIMEOUT_MS, undefined);
  await withTimeout(pool.end(), SHUTDOWN_STEP_TIMEOUT_MS, undefined);
  process.exit(0);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
