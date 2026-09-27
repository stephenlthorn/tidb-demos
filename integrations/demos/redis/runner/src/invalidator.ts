import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Emitter, SampleWindow } from '@lab/runner-kit';
import { every } from '@lab/runner-kit';
import type { RedisClient } from './redis-cache';
import { deleteCachedPayload } from './redis-cache';
import { redisKeyForRow } from './keys';
import { extractCacheDemoFields, parseCanalJsonMessage } from './canal';
import { computeInvalidationLagMs } from './staleness';
import type { DemoState } from './mode';

const DRAIN_INTERVAL_MS = 100;

export type InvalidatorDeps = {
  readonly kafkaBrokers: readonly string[];
  readonly topic: string;
  readonly groupId: string;
  readonly redis: RedisClient;
  readonly emitter: Emitter;
  readonly lagSamples: SampleWindow;
  readonly getState: () => DemoState;
  readonly signal: AbortSignal;
};

export type InvalidatorHandle = {
  readonly drainLoop: Promise<void>;
  readonly stop: () => Promise<void>;
};

export const runInvalidator = async (deps: InvalidatorDeps): Promise<InvalidatorHandle> => {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [...deps.kafkaBrokers], logLevel: KafkaJS.logLevel.NOTHING },
  });
  const consumer = kafka.consumer({ kafkaJS: { groupId: deps.groupId } });
  await consumer.connect();
  await consumer.subscribe({ topics: [deps.topic] });

  const buffer: string[] = [];

  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString('utf8');
      if (raw !== undefined && raw !== '') buffer.push(raw);
    },
  });

  const drainLoop = every({
    intervalMs: DRAIN_INTERVAL_MS,
    signal: deps.signal,
    task: async () => {
      const pending = buffer.splice(0, buffer.length);
      for (const raw of pending) {
        deps.emitter.flow('consumed-events', 1);
        if (deps.getState().invalidationMode !== 'cdc') continue;
        const parsed = parseCanalJsonMessage(raw);
        if (!parsed.ok) {
          deps.emitter.log('warn', `unparseable canal-json message: ${parsed.error}`);
          continue;
        }
        const fields = extractCacheDemoFields(parsed.change.row);
        if (fields === undefined) {
          deps.emitter.log('warn', `canal-json row on table ${parsed.change.table} missing id or written_at_ms`);
          continue;
        }
        await deleteCachedPayload(deps.redis, redisKeyForRow(fields.rowId));
        deps.emitter.flow('invalidations', 1);
        deps.lagSamples.add(computeInvalidationLagMs({ deletedAtMs: Date.now(), writtenAtMs: fields.writtenAtMs }));
      }
    },
  });

  return {
    drainLoop,
    stop: async () => {
      await consumer.disconnect();
    },
  };
};
