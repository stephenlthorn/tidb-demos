import { z } from 'zod';
import { createEmitter, every, onControl, createTidbPool } from '@lab/runner-kit';
import { createConnectApi } from './src/connectApi';
import { createTicdcApi } from './src/ticdcApi';
import { createPostgresClient } from './src/postgresClient';
import { createSharedConsumer } from './src/kafkaConsumer';
import { parseDebeziumEnvelope } from './src/debeziumEnvelope';
import { computeHeartbeatLagMs } from './src/heartbeat';
import { summarizeConnectorStatus } from './src/connectStatus';
import { createParseRateTracker } from './src/parseRate';
import { computeSchemaPropagationMs } from './src/schemaPropagation';

const PG_CHANGES_TOPIC = 'pg.public.accounts';
const TIDB_CHANGES_TOPIC = 'tidb-changes-dbz';
const TICDC_CHANGEFEED_ID = 'debezium-tidb-source';

const emitter = createEmitter();
const pool = createTidbPool();
const connect = createConnectApi({ baseUrl: process.env.KAFKA_CONNECT_API ?? 'http://127.0.0.1:8083' });
const ticdc = createTicdcApi({ baseUrl: process.env.TICDC_API ?? 'http://127.0.0.1:8300' });
const postgres = createPostgresClient({
  connectionString: process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/lab',
});
const kafkaBrokers = (process.env.KAFKA_BROKERS ?? '127.0.0.1:9092').split(',').map((broker) => broker.trim());
const sharedConsumer = createSharedConsumer({
  brokers: kafkaBrokers,
  groupId: 'debezium-demo-consumer',
  topics: [PG_CHANGES_TOPIC, TIDB_CHANGES_TOPIC],
});
const parseRate = createParseRateTracker();

const controller = new AbortController();

let addColumnPressedAtMs: number | undefined;
let riskTierObservedAtMs: number | undefined;
let previousPostgresAccountCount: number | undefined;
let previousTidbAccountCount: number | undefined;
let idleReplicationTicks = 0;
let messagesConsumedTotal = 0;

const HeartbeatRowsSchema = z.array(z.object({ source_commit_ms: z.coerce.number() }));
const ColumnRowsSchema = z.array(z.object({ COLUMN_NAME: z.string() }));
const AccountCountRowsSchema = z.array(z.object({ count: z.coerce.number() }));

const countTidbAccounts = async (): Promise<number> => {
  const [rows] = await pool.query('SELECT COUNT(*) AS count FROM accounts');
  return AccountCountRowsSchema.parse(rows)[0]?.count ?? 0;
};

emitter.phase('warm-up');
emitter.node('postgres', 'starting');
emitter.node('debezium-pg-source', 'starting');
emitter.node('jdbc-sink', 'starting');
emitter.node('tidb', 'starting');
emitter.node('ticdc-debezium', 'idle');
emitter.node('consumer', 'starting');
emitter.check('postgres-rows-equal-tidb-rows-act-a', 'pending');
emitter.check('consumer-parses-both-topics', 'pending');
emitter.check('schema-change-propagated', 'pending');

onControl((id) => {
  if (id === 'insert-burst') {
    emitter.phase('act-a-replication');
    postgres.insertAccounts(200).catch((error: unknown) => emitter.log('error', `insert-burst failed: ${String(error)}`));
  }
  if (id === 'start-ticdc-debezium') {
    (async () => {
      const exists = await ticdc.changefeedExists(TICDC_CHANGEFEED_ID);
      if (!exists) {
        await ticdc.createDebeziumChangefeed({
          id: TICDC_CHANGEFEED_ID,
          sinkUri: `kafka://127.0.0.1:9092/${TIDB_CHANGES_TOPIC}?protocol=debezium&kafka-version=3.0.0`,
        });
      }
      emitter.node('ticdc-debezium', 'healthy');
      emitter.phase('act-b-tidb-as-source');
    })().catch((error: unknown) => emitter.log('error', `start-ticdc-debezium failed: ${String(error)}`));
  }
  if (id === 'add-column') {
    addColumnPressedAtMs = emitter.elapsedMs();
    postgres.addRiskTierColumn().catch((error: unknown) => emitter.log('error', `add-column failed: ${String(error)}`));
    emitter.phase('act-c-schema-change');
  }
});

const runHeartbeatTick = async (): Promise<void> => {
  const sourceCommitMs = emitter.elapsedMs();
  await postgres.upsertHeartbeat(sourceCommitMs);
  const [rows] = await pool.query('SELECT source_commit_ms FROM heartbeat WHERE id = 1');
  const heartbeat = HeartbeatRowsSchema.parse(rows)[0];
  if (heartbeat !== undefined) {
    const lag = computeHeartbeatLagMs({ observedAtMs: emitter.elapsedMs(), sourceCommitMs: heartbeat.source_commit_ms });
    emitter.metric('replication-lag-ms', lag);
  }
};

const runConnectStatusTick = async (): Promise<void> => {
  const sourceStatus = await connect.getStatus('postgres-source');
  const sourceUp = summarizeConnectorStatus(sourceStatus);
  emitter.metric('connect-task-status-source', sourceUp);
  emitter.node('debezium-pg-source', sourceUp === 1 ? 'healthy' : 'degraded');

  const sinkStatus = await connect.getStatus('tidb-sink');
  const sinkUp = summarizeConnectorStatus(sinkStatus);
  emitter.metric('connect-task-status-sink', sinkUp);
  emitter.node('jdbc-sink', sinkUp === 1 ? 'healthy' : 'degraded');
};

const runThroughputAndReplicationCheckTick = async (): Promise<void> => {
  const postgresCount = await postgres.countAccounts();
  const tidbCount = await countTidbAccounts();

  const sourceDelta =
    previousPostgresAccountCount === undefined ? 0 : Math.max(0, postgresCount - previousPostgresAccountCount);
  const sinkDelta = previousTidbAccountCount === undefined ? 0 : Math.max(0, tidbCount - previousTidbAccountCount);
  emitter.metric('records-per-sec-source', sourceDelta);
  emitter.metric('records-per-sec-sink', sinkDelta);

  idleReplicationTicks = sourceDelta === 0 && sinkDelta === 0 ? idleReplicationTicks + 1 : 0;
  if (idleReplicationTicks >= 2 && postgresCount > 0) {
    emitter.check(
      'postgres-rows-equal-tidb-rows-act-a',
      postgresCount === tidbCount ? 'pass' : 'fail',
      `postgres=${postgresCount} tidb=${tidbCount}`,
    );
  }

  previousPostgresAccountCount = postgresCount;
  previousTidbAccountCount = tidbCount;
};

const runSchemaCheckTick = async (): Promise<void> => {
  if (addColumnPressedAtMs === undefined || riskTierObservedAtMs !== undefined) return;
  const [columnRows] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'lab' AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'risk_tier'",
  );
  const columns = ColumnRowsSchema.parse(columnRows);
  if (columns.length > 0) {
    riskTierObservedAtMs = emitter.elapsedMs();
    const propagationMs = computeSchemaPropagationMs({
      controlPressedAtMs: addColumnPressedAtMs,
      columnObservedAtMs: riskTierObservedAtMs,
      nowMs: emitter.elapsedMs(),
    });
    if (propagationMs !== undefined) {
      emitter.metric('schema-change-propagation-ms', propagationMs);
      emitter.check('schema-change-propagated', 'pass', `${propagationMs}ms`);
    }
  }
};

const runConsumerTick = async (): Promise<void> => {
  const messages = sharedConsumer.drain();
  messages.forEach((raw) => {
    const parsed = parseDebeziumEnvelope(raw);
    if (parsed.ok) parseRate.recordSuccess();
    else parseRate.recordFailure();
  });
  messagesConsumedTotal += messages.length;
  emitter.metric('consumer-parse-success-rate', parseRate.successRatePercent());
  if (messagesConsumedTotal > 0) {
    emitter.check(
      'consumer-parses-both-topics',
      parseRate.successRatePercent() === 100 ? 'pass' : 'fail',
      `${messagesConsumedTotal} messages consumed`,
    );
  }
};

sharedConsumer
  .start()
  .then(() => emitter.node('consumer', 'healthy'))
  .catch((error: unknown) => emitter.log('error', `shared consumer failed to start: ${String(error)}`));

void every({ intervalMs: 1000, task: runHeartbeatTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runConnectStatusTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runThroughputAndReplicationCheckTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runSchemaCheckTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runConsumerTick, signal: controller.signal });
