import { createEmitter, createSampleWindow, createTidbPool, every, onControl, summarize, timed } from '@lab/runner-kit';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { createKafkaClients } from './src/kafkaClient';
import { createTicdcApi } from './src/ticdcApi';
import { createPaymentEvent, decodePaymentEvent, encodePaymentEvent, type PaymentEvent } from './src/paymentEvent';
import { buildUpsertSql } from './src/upsertSql';
import { parseCanalJsonMessage } from './src/canalJsonParser';
import { computeE2eLatencyMs } from './src/latency';
import { changefeedLagMs } from './src/checkpointLag';
import { createDedupeTracker } from './src/dedupe';
import { ensurePaymentsTable } from './src/tidbSchema';
import { z } from 'zod';

const CountRowsSchema = z.array(z.object({ count: z.coerce.number() }));

const PAYMENTS_TOPIC = 'payments';
const CHANGES_TOPIC = 'tidb-changes';
const INGESTER_GROUP_ID = 'kafka-demo-ingester';
const RISK_CONSUMER_GROUP_ID = 'kafka-demo-risk-consumer';
const BASE_PRODUCE_EVENTS_PER_TICK = 5;
const BURST_MULTIPLIER = 10;
const BURST_DURATION_MS = 30_000;

const emitter = createEmitter();
const pool = createTidbPool();
const kafka = createKafkaClients({ brokers: [process.env.KAFKA_BROKERS ?? '127.0.0.1:9092'] });
const ticdc = createTicdcApi({ baseUrl: process.env.TICDC_API ?? 'http://127.0.0.1:8300' });
const changefeedId = process.env.CHANGEFEED_ID ?? 'kafka-fintech-risk';
const dedupe = createDedupeTracker();
const distinctCdcKeys = new Set<string>();
const upsertLatencySamples = createSampleWindow();
const e2eLatencySamples = createSampleWindow();

const controller = new AbortController();

let producerRateMultiplier = 1;
let sequence = 0;
let producedCount = 0;
let ingestBuffer: PaymentEvent[] = [];
let ticksSinceLastUpsertBatch = 0;
let lastTidbWriteP99 = 0;
let lastE2eLatencyP50 = 0;
let lastE2eLatencyP99 = 0;
let cdcRowEventsThisTick = 0;
let duplicatesObservedTotal = 0;
let ingesterConsumer: KafkaJS.Consumer | undefined;
let riskConsumer: KafkaJS.Consumer | undefined;

const onIngesterMessage = async (payload: KafkaJS.EachMessagePayload): Promise<void> => {
  if (payload.message.value === null) return;
  const decoded = decodePaymentEvent(payload.message.value.toString('utf-8'));
  ingestBuffer.push(decoded);
};

const onRiskConsumerMessage = async (payload: KafkaJS.EachMessagePayload): Promise<void> => {
  if (payload.message.value === null) return;
  const parsed = parseCanalJsonMessage(payload.message.value.toString('utf-8'));
  if (!parsed.ok) return;
  cdcRowEventsThisTick += 1;
  const key = `${parsed.row.payment_id ?? ''}:${parsed.commitTs.toString()}`;
  const dedupeResult = dedupe.observe(key);
  if (dedupeResult.isDuplicate) duplicatesObservedTotal += 1;
  distinctCdcKeys.add(key);
  const produceTs = Number(parsed.row.produce_ts ?? '0');
  e2eLatencySamples.add(computeE2eLatencyMs({ produceTs, consumeTs: emitter.elapsedMs() }));
};

const startIngesterConsumer = async (): Promise<void> => {
  ingesterConsumer = await kafka.createConsumer({
    groupId: INGESTER_GROUP_ID,
    topic: PAYMENTS_TOPIC,
    onMessage: onIngesterMessage,
  });
};

const startRiskConsumer = async (): Promise<void> => {
  riskConsumer = await kafka.createConsumer({
    groupId: RISK_CONSUMER_GROUP_ID,
    topic: CHANGES_TOPIC,
    onMessage: onRiskConsumerMessage,
  });
};

const setPhaseAfter = (phase: string, delayMs: number): void => {
  setTimeout(() => emitter.phase(phase), delayMs);
};

onControl((id) => {
  if (id === 'burst') {
    emitter.phase('burst');
    producerRateMultiplier = BURST_MULTIPLIER;
    setTimeout(() => {
      producerRateMultiplier = 1;
      emitter.phase('steady-state');
    }, BURST_DURATION_MS);
  }
  if (id === 'restart-ingester') {
    emitter.phase('ingester-restart');
    emitter.node('ingester', 'starting', 'tearing down and recreating consumer group');
    void (async () => {
      await ingesterConsumer?.disconnect();
      await startIngesterConsumer();
      emitter.node('ingester', 'healthy', 'consumer group rejoined, resumed from committed offset');
      setPhaseAfter('steady-state', 3_000);
    })();
  }
  if (id === 'pause-changefeed') {
    emitter.phase('changefeed-pause-resume');
    emitter.node('ticdc', 'degraded', 'paused by control');
    void ticdc.pause(changefeedId);
  }
  if (id === 'resume-changefeed') {
    emitter.node('ticdc', 'healthy', 'resumed, catching up from checkpoint');
    void ticdc.resume(changefeedId);
    setTimeout(() => {
      emitter.phase('wrap-up');
      producerRateMultiplier = 0;
      emitter.node('producer', 'done', 'stopped so every count can settle');
    }, 20_000);
  }
});

const runProducerTick = async (): Promise<void> => {
  const eventsThisTick = BASE_PRODUCE_EVENTS_PER_TICK * producerRateMultiplier;
  for (let i = 0; i < eventsThisTick; i += 1) {
    sequence += 1;
    const event = createPaymentEvent({ sequence, now: () => emitter.elapsedMs() });
    await kafka.producer.send({ topic: PAYMENTS_TOPIC, messages: [{ value: encodePaymentEvent(event) }] });
  }
  producedCount += eventsThisTick;
  emitter.metric('produce-rate', eventsThisTick);
  emitter.flow('produce', eventsThisTick);
};

const runIngesterTick = async (): Promise<void> => {
  const batch = ingestBuffer;
  ingestBuffer = [];
  emitter.flow('consume-payments', batch.length);
  if (batch.length === 0) {
    ticksSinceLastUpsertBatch += 1;
    emitter.metric('ingest-rate', 0);
    emitter.metric('tidb-write-p99', lastTidbWriteP99);
    return;
  }
  ticksSinceLastUpsertBatch = 0;
  const built = buildUpsertSql(batch);
  const timedWrite = await timed(async () => pool.query(built.sql, [...built.params]));
  upsertLatencySamples.add(timedWrite.ms);
  const summary = summarize(upsertLatencySamples.drain());
  if (summary !== undefined) lastTidbWriteP99 = summary.p99;
  emitter.metric('ingest-rate', batch.length);
  emitter.metric('tidb-write-p99', lastTidbWriteP99);
  emitter.flow('upsert', batch.length);
};

const runConsumerLagTick = async (): Promise<void> => {
  const [payLag, changeLag] = await Promise.all([
    kafka.fetchGroupLag({ groupId: INGESTER_GROUP_ID, topic: PAYMENTS_TOPIC }),
    kafka.fetchGroupLag({ groupId: RISK_CONSUMER_GROUP_ID, topic: CHANGES_TOPIC }),
  ]);
  emitter.metric('consumer-lag-payments', payLag);
  emitter.metric('consumer-lag-changes', changeLag);
};

const runChangefeedMonitorTick = async (): Promise<void> => {
  const status = await ticdc.getChangefeed(changefeedId);
  const lag = changefeedLagMs({ checkpointTso: status.checkpointTso, nowEpochMs: Date.now() });
  emitter.metric('ticdc-checkpoint-lag', lag);
};

const runCdcFlowTick = async (): Promise<void> => {
  const count = cdcRowEventsThisTick;
  cdcRowEventsThisTick = 0;
  emitter.flow('capture', count);
  emitter.flow('publish-change', count);
  emitter.flow('consume-changes', count);
  const latencies = e2eLatencySamples.drain();
  const summary = summarize(latencies);
  if (summary !== undefined) {
    lastE2eLatencyP50 = summary.p50;
    lastE2eLatencyP99 = summary.p99;
  }
  emitter.metric('e2e-latency-p50', lastE2eLatencyP50);
  emitter.metric('e2e-latency-p99', lastE2eLatencyP99);
  emitter.metric('duplicates-observed', duplicatesObservedTotal);
};

const runChecksTick = async (): Promise<void> => {
  const [[countRows], [duplicateRowList]] = await Promise.all([
    pool.query('SELECT COUNT(*) AS count FROM payments'),
    pool.query('SELECT payment_id FROM payments GROUP BY payment_id HAVING COUNT(*) > 1'),
  ]);
  const tidbRowCount = CountRowsSchema.parse(countRows)[0]?.count ?? 0;
  const duplicateCount = Array.isArray(duplicateRowList) ? duplicateRowList.length : 0;
  emitter.check(
    'produced-equals-tidb-rows',
    producedCount === tidbRowCount ? 'pass' : 'pending',
    `produced=${producedCount} tidb_rows=${tidbRowCount}`,
  );
  emitter.check(
    'tidb-rows-equals-cdc-distinct',
    distinctCdcKeys.size === tidbRowCount ? 'pass' : 'pending',
    `tidb_rows=${tidbRowCount} distinct_cdc=${distinctCdcKeys.size}`,
  );
  emitter.check(
    'zero-duplicate-rows-in-tidb',
    duplicateCount === 0 ? 'pass' : 'fail',
    `duplicate_payment_ids=${duplicateCount}`,
  );
};

const start = async (): Promise<void> => {
  emitter.phase('warm-up');
  emitter.node('tidb', 'starting');
  await ensurePaymentsTable(pool);
  emitter.node('tidb', 'healthy');
  emitter.node('payments-topic', 'healthy');
  emitter.node('changes-topic', 'healthy');
  await kafka.connect();
  emitter.node('producer', 'healthy');
  emitter.node('ingester', 'starting');
  await startIngesterConsumer();
  emitter.node('ingester', 'healthy');
  emitter.node('risk-consumer', 'starting');
  await startRiskConsumer();
  emitter.node('risk-consumer', 'healthy');
  emitter.node('ticdc', 'healthy');
  setPhaseAfter('steady-state', 8_000);

  void every({ intervalMs: 1000, task: runProducerTick, signal: controller.signal });
  void every({ intervalMs: 1000, task: runIngesterTick, signal: controller.signal });
  void every({ intervalMs: 1000, task: runConsumerLagTick, signal: controller.signal });
  void every({ intervalMs: 1000, task: runChangefeedMonitorTick, signal: controller.signal });
  void every({ intervalMs: 1000, task: runCdcFlowTick, signal: controller.signal });
  void every({ intervalMs: 1000, task: runChecksTick, signal: controller.signal });
};

const shutdown = async (): Promise<void> => {
  controller.abort();
  await ingesterConsumer?.disconnect();
  await riskConsumer?.disconnect();
  await kafka.disconnect();
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

void start();
