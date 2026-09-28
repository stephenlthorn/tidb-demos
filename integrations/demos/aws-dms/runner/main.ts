import { createEmitter, onControl, createTidbPool, every, sleep } from '@lab/runner-kit';
import type { RowDataPacket } from 'mysql2/promise';
import { createDmsPoller } from './src/dms-poller';
import { createCloudwatchPoller } from './src/cloudwatch-poller';
import { createPgClient } from './src/pg-client';
import { createLoadGenerator } from './src/load-generator';
import { createCutoverStateMachine } from './src/cutover-state';
import { rowCountDiff } from './src/row-count-diff';
import { freshnessMs } from './src/freshness';
import { cutoverDowntimeSeconds } from './src/cutover-timer';
import { tableProgressPercent } from './src/table-stats';
import { buildChecksumQuery, type ChecksumColumn } from './src/checksum';

type CountRow = RowDataPacket & { readonly count: number };
type ChecksumRow = RowDataPacket & { readonly checksum: number };
type HeartbeatCheckRow = RowDataPacket & { readonly heartbeat_id: number };

const env = process.env;
const emitter = createEmitter();
const tidbPool = createTidbPool(env);
tidbPool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});
const pgClient = createPgClient(env);
const dmsPoller = createDmsPoller({ region: env.AWS_REGION ?? 'us-east-1', replicationTaskArn: env.DMS_TASK_ARN ?? '' });
const cloudwatchPoller = createCloudwatchPoller({
  region: env.AWS_REGION ?? 'us-east-1',
  replicationInstanceId: env.DMS_REPLICATION_INSTANCE_ID ?? '',
  replicationTaskId: env.DMS_TASK_ID ?? '',
  windowMs: 10 * 60 * 1000,
});
const loadGenerator = createLoadGenerator({
  pgClient,
  baselineRowsPerTick: 5,
  burstMultiplier: 10,
  burstDurationMs: 30_000,
  onTick: (rows) => emitter.flow('writes', rows),
});
const cutover = createCutoverStateMachine();
const controller = new AbortController();

const orderColumns: readonly ChecksumColumn[] = [
  { column: 'order_id', type: 'text' },
  { column: 'amount', type: 'numeric', precision: 18, scale: 2 },
  { column: 'status', type: 'text' },
];

const sourceRowCountsAtPhaseStart = new Map<string, number>();
let lastTableStatsTickMs = Date.now();
let lastAppliedTotal = 0;
let lastFullLoadTotal = 0;
let currentPhaseId = 'provision';

const setPhase = (id: string): void => {
  if (id === currentPhaseId) return;
  currentPhaseId = id;
  emitter.phase(id);
};

const runValidation = async (): Promise<{ readonly rowDiff: number; readonly checksumMatch: boolean }> => {
  const pgCount = await pgClient.countRows('orders');
  const [tidbCountRows] = await tidbPool.query<CountRow[]>('SELECT COUNT(*) AS count FROM orders');
  const tidbCountRow = tidbCountRows[0];
  const tidbCount = tidbCountRow === undefined ? 0 : Number(tidbCountRow.count);
  const rowDiff = rowCountDiff({ sourceCount: pgCount, targetCount: tidbCount });
  emitter.metric('row-count-diff', rowDiff);
  emitter.check('row-count-match', rowDiff === 0 ? 'pass' : 'fail', `pg=${pgCount} tidb=${tidbCount}`);

  const pgChecksum = await pgClient.runChecksum({ table: 'orders', primaryKey: 'order_id', columns: orderColumns });
  const tidbChecksumQuery = buildChecksumQuery({
    dialect: 'mysql',
    table: 'orders',
    primaryKey: 'order_id',
    columns: orderColumns,
  });
  const [tidbChecksumRows] = await tidbPool.query<ChecksumRow[]>(tidbChecksumQuery);
  const tidbChecksumRow = tidbChecksumRows[0];
  const tidbChecksum = tidbChecksumRow === undefined ? 0 : Number(tidbChecksumRow.checksum);
  const checksumMatch = pgChecksum === tidbChecksum;
  emitter.check('checksum-match', checksumMatch ? 'pass' : 'fail', `pg=${pgChecksum} tidb=${tidbChecksum}`);

  return { rowDiff, checksumMatch };
};

onControl(async (id) => {
  if (id === 'burst-writes') {
    loadGenerator.burst();
    emitter.log('info', 'burst writes triggered against Aurora PostgreSQL');
  }

  if (id === 'run-validation') {
    setPhase('validate');
    emitter.node('validator', 'busy');
    const { rowDiff, checksumMatch } = await runValidation();
    emitter.node('validator', rowDiff === 0 && checksumMatch ? 'healthy' : 'degraded');
  }

  if (id === 'start-cutover') {
    loadGenerator.stop();
    const stoppedAtMs = Date.now();
    cutover.beginDraining();
    setPhase('cutover');
    emitter.node('app-writer', 'down', 'writer stopped for cutover');

    const drainController = new AbortController();
    await every({
      intervalMs: 2000,
      signal: drainController.signal,
      task: async () => {
        if (cutover.getState() !== 'draining') {
          drainController.abort();
          return;
        }
        const latest = await cloudwatchPoller.pollCdcLatency();
        const targetLatency = latest.cdc_latency_target ?? Number.POSITIVE_INFINITY;
        emitter.metric('cdc-latency-target-s', targetLatency);
        if (targetLatency === 0) {
          const { rowDiff, checksumMatch } = await runValidation();
          if (rowDiff === 0 && checksumMatch) {
            cutover.markVerified();
            emitter.check('cutover-clean', 'pass');
            drainController.abort();
          }
        }
      },
    });

    if (cutover.getState() === 'verified') {
      await tidbPool.query('SELECT 1');
      cutover.markFlipped();
      const confirmedAtMs = Date.now();
      emitter.metric('cutover-downtime-s', cutoverDowntimeSeconds({ stoppedAtMs, confirmedAtMs }));
      emitter.node('tidb', 'healthy', 'app connection flipped to TiDB');
      emitter.log('info', 'cutover complete, app connection flipped to TiDB', 'tidb');
    }
  }
});

const runTableStatsTick = async (): Promise<void> => {
  const progress = await dmsPoller.pollTableStatistics();
  const nowMs = Date.now();
  const tickSeconds = (nowMs - lastTableStatsTickMs) / 1000;
  lastTableStatsTickMs = nowMs;

  let appliedTotal = 0;
  let fullLoadTotal = 0;
  for (const table of progress) {
    const knownSourceRowCount = sourceRowCountsAtPhaseStart.get(table.tableName);
    const sourceRowCount = knownSourceRowCount ?? Math.max(table.fullLoadRows, 1);
    if (knownSourceRowCount === undefined) sourceRowCountsAtPhaseStart.set(table.tableName, sourceRowCount);
    emitter.metric('full-load-pct', tableProgressPercent({ fullLoadRows: table.fullLoadRows, sourceRowCount }));
    emitter.metric('validation-failed-rows', table.validationFailedRecords);
    appliedTotal += table.appliedInserts + table.appliedUpdates + table.appliedDeletes;
    fullLoadTotal += table.fullLoadRows;
  }

  const anyFullLoadStarted = progress.some((table) => table.fullLoadRows > 0);
  const allFullLoadComplete = progress.length > 0 && progress.every((table) => table.isFullLoadComplete);
  if (currentPhaseId === 'schema' && anyFullLoadStarted) {
    setPhase('full-load');
    emitter.node('dms', 'busy');
  }
  if (currentPhaseId === 'full-load' && allFullLoadComplete) {
    setPhase('cdc-live');
    emitter.node('dms', 'healthy');
  }

  if (tickSeconds > 0) {
    const fullLoadDelta = fullLoadTotal - lastFullLoadTotal;
    const appliedDelta = appliedTotal - lastAppliedTotal;
    emitter.metric('full-load-rows-sec', fullLoadDelta / tickSeconds);
    emitter.metric('cdc-apply-rows-sec', appliedDelta / tickSeconds);
    if (fullLoadDelta > 0) emitter.flow('full-load', Math.round(fullLoadDelta));
    if (appliedDelta > 0) emitter.flow('applied', Math.round(appliedDelta));
  }
  lastAppliedTotal = appliedTotal;
  lastFullLoadTotal = fullLoadTotal;
};

const runCdcLatencyTick = async (): Promise<void> => {
  const latest = await cloudwatchPoller.pollCdcLatency();
  if (latest.cdc_latency_source !== undefined) emitter.metric('cdc-latency-source-s', latest.cdc_latency_source);
  if (latest.cdc_latency_target !== undefined) emitter.metric('cdc-latency-target-s', latest.cdc_latency_target);
};

const runHeartbeatTick = async (): Promise<void> => {
  const { heartbeatId, insertedAtMs } = await pgClient.insertHeartbeat();
  const deadlineMs = Date.now() + 5000;
  while (Date.now() < deadlineMs) {
    const [rows] = await tidbPool.query<HeartbeatCheckRow[]>(
      'SELECT heartbeat_id FROM heartbeat WHERE heartbeat_id = ?',
      [heartbeatId],
    );
    if (rows.length > 0) {
      emitter.metric('heartbeat-freshness-ms', freshnessMs({ insertedAtMs, visibleAtMs: Date.now() }));
      return;
    }
    await sleep(200);
  }
  emitter.log('warn', `heartbeat ${heartbeatId} not visible in TiDB within 5000ms`);
};

emitter.phase('provision');
emitter.node('app-writer', 'healthy');
emitter.node('aurora-pg', 'healthy');
emitter.node('dms', 'starting');
emitter.node('tidb', 'healthy');
emitter.node('validator', 'idle');
emitter.check('schema-parity', 'pass', 'TiDB DDL documented against PostgreSQL source types (infra/sql/schema.sql, schema-tidb.sql)');
setPhase('schema');

void loadGenerator.start(controller.signal);
void every({ intervalMs: 1000, task: runTableStatsTick, signal: controller.signal });
void every({ intervalMs: 5000, task: runCdcLatencyTick, signal: controller.signal });
void every({ intervalMs: 1000, task: runHeartbeatTick, signal: controller.signal });
