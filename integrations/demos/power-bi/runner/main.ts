import { createEmitter, createSampleWindow, createTidbPool, every, onControl, summarize, timed } from '@lab/runner-kit';
import { DASHBOARD_QUERIES } from './src/dashboardQueries';
import { degradationPct, freshnessMs } from './src/metrics';
import { createHeartbeatOrder, createOrder } from './src/orderGenerator';
import { type RoutingEngine } from './src/routing';
import {
  insertOrder,
  probeHeartbeatVisible,
  readTiflashReplicaStatus,
  readTotalAsOf,
  runDashboardQuerySet,
  setTiflashReplica,
} from './src/tidbAdapters';
import { phaseForElapsed, type PhaseId } from './src/timeline';
import { ordersPerTick } from './src/writeLoadPlan';

const TICK_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const BASE_WRITE_RATE_PER_SEC = Number(process.env.WRITE_BASE_RATE_PER_SEC ?? '5');
const BURST_FACTOR = Number(process.env.WRITE_BURST_FACTOR ?? '8');
const BURST_DURATION_MS = Number(process.env.WRITE_BURST_DURATION_MS ?? '10000');
const DASHBOARD_LOAD_CONCURRENCY = Number(process.env.DASHBOARD_LOAD_CONCURRENCY ?? '8');
const DEGRADATION_THRESHOLD_PCT = Number(process.env.WRITE_P99_DEGRADATION_THRESHOLD_PCT ?? '25');
const TIFLASH_REPLICA_COUNT = Number(process.env.TIFLASH_REPLICA_COUNT ?? '1');

const pool = createTidbPool(process.env);
const emitter = createEmitter();
const controller = new AbortController();

type PendingHeartbeat = {
  readonly orderId: string;
  readonly committedAtMs: number;
};

type RunState = {
  orderSequence: number;
  heartbeatSequence: number;
  dashboardLoadActive: boolean;
  activeEngine: RoutingEngine;
  burstUntilMs: number;
  baselineWriteP99: number | undefined;
  pendingHeartbeat: PendingHeartbeat | undefined;
};

const state: RunState = {
  orderSequence: 0,
  heartbeatSequence: 0,
  dashboardLoadActive: false,
  activeEngine: 'tiflash',
  burstUntilMs: 0,
  baselineWriteP99: undefined,
  pendingHeartbeat: undefined,
};

let lastPhase: PhaseId = 'intro';
let lastHeartbeatAtMs = 0;
let ordersWrittenTotal = 0;
let tiflashReplicaCheckStarted = false;
let tiflashReplicaChecked = false;
let snapshotChecked = false;

const writeSamples = createSampleWindow();
const tikvSamples = createSampleWindow();
const tiflashSamples = createSampleWindow();

const runEngineQuerySet = async (engine: RoutingEngine): Promise<readonly number[]> => {
  const connection = await pool.getConnection();
  try {
    return await runDashboardQuerySet(connection, engine);
  } finally {
    connection.release();
  }
};

const probeHeartbeat = async (orderId: string): Promise<boolean> => {
  const connection = await pool.getConnection();
  try {
    return await probeHeartbeatVisible(connection, orderId);
  } finally {
    connection.release();
  }
};

const runSnapshotCheck = async (): Promise<void> => {
  emitter.check('snapshot-totals-match', 'pending');
  const snapshot = new Date(Date.now() - 5_000);
  const [tikvConnection, tiflashConnection] = await Promise.all([pool.getConnection(), pool.getConnection()]);
  try {
    const [tikvTotal, tiflashTotal] = await Promise.all([
      readTotalAsOf(tikvConnection, 'tikv', snapshot),
      readTotalAsOf(tiflashConnection, 'tiflash', snapshot),
    ]);
    const matches = tikvTotal === tiflashTotal;
    emitter.check(
      'snapshot-totals-match',
      matches ? 'pass' : 'fail',
      `tikv=${tikvTotal.toFixed(2)} tiflash=${tiflashTotal.toFixed(2)}`,
    );
  } finally {
    tikvConnection.release();
    tiflashConnection.release();
  }
};

const onPhaseEnter = (phase: PhaseId): void => {
  if (phase === 'intro') {
    emitter.node('order-workload', 'healthy');
    emitter.node('tidb', 'healthy');
    emitter.node('tiflash', 'idle');
    emitter.node('power-bi', 'idle');
    return;
  }
  if (phase === 'tiflash-replica') {
    emitter.node('tiflash', 'starting');
    setTiflashReplica(pool, TIFLASH_REPLICA_COUNT).catch((error: unknown) => {
      emitter.log('error', `failed to set tiflash replica: ${String(error)}`, 'tiflash');
    });
    return;
  }
  if (phase === 'dashboard-on-tikv') {
    state.dashboardLoadActive = true;
    state.activeEngine = 'tikv';
    emitter.node('tidb', 'busy');
    return;
  }
  if (phase === 'dashboard-on-tiflash') {
    state.activeEngine = 'tiflash';
    emitter.node('tidb', 'healthy');
    emitter.node('tiflash', 'busy');
    return;
  }
  if (phase === 'power-bi-live') {
    emitter.node('power-bi', 'busy');
    return;
  }
  if (phase === 'wrap-up') {
    emitter.node('power-bi', 'done');
  }
};

const runWriteTick = async (elapsedMs: number, phase: PhaseId): Promise<void> => {
  const burstActive = Date.now() < state.burstUntilMs;
  const ordersThisTick = ordersPerTick({
    baseRatePerSec: BASE_WRITE_RATE_PER_SEC,
    burstActive,
    burstFactor: BURST_FACTOR,
  });

  for (let i = 0; i < ordersThisTick; i += 1) {
    state.orderSequence += 1;
    const order = createOrder({ sequence: state.orderSequence, randomSource: Math.random });
    const { ms } = await timed(() => insertOrder(pool, order));
    writeSamples.add(ms);
    ordersWrittenTotal += 1;
  }
  emitter.flow('writes', ordersThisTick);

  if (elapsedMs - lastHeartbeatAtMs > HEARTBEAT_INTERVAL_MS && state.pendingHeartbeat === undefined) {
    state.heartbeatSequence += 1;
    const heartbeat = createHeartbeatOrder({ sequence: state.heartbeatSequence });
    await insertOrder(pool, heartbeat);
    state.pendingHeartbeat = { orderId: heartbeat.orderId, committedAtMs: emitter.elapsedMs() };
    lastHeartbeatAtMs = elapsedMs;
    emitter.log('info', `heartbeat ${heartbeat.orderId} committed`, 'tidb');
  }

  if (state.pendingHeartbeat !== undefined) {
    const pending = state.pendingHeartbeat;
    const visible = await probeHeartbeat(pending.orderId);
    if (visible) {
      const value = freshnessMs({ committedAtMs: pending.committedAtMs, visibleAtMs: emitter.elapsedMs() });
      emitter.metric('freshness-ms', value);
      emitter.log('info', `heartbeat ${pending.orderId} visible in TiFlash after ${value}ms`, 'tiflash');
      state.pendingHeartbeat = undefined;
    }
  }

  const writeSummary = summarize(writeSamples.drain());
  if (writeSummary !== undefined) {
    emitter.metric('write-p99', writeSummary.p99);
    if (state.baselineWriteP99 === undefined && phase === 'seed-baseline') {
      state.baselineWriteP99 = writeSummary.p99;
    }
    if (state.baselineWriteP99 !== undefined && state.dashboardLoadActive) {
      const pct = degradationPct({ baselineP99Ms: state.baselineWriteP99, currentP99Ms: writeSummary.p99 });
      emitter.metric('write-p99-degradation', pct);
      if (phase === 'dashboard-on-tiflash') {
        emitter.check(
          'write-p99-within-threshold',
          pct <= DEGRADATION_THRESHOLD_PCT ? 'pass' : 'fail',
          `degradation=${pct.toFixed(1)}% threshold=${DEGRADATION_THRESHOLD_PCT}%`,
        );
      }
    }
  }

  emitter.metric('orders-written-total', ordersWrittenTotal);
};

const runDashboardTick = async (): Promise<void> => {
  const [tikvTimings, tiflashTimings] = await Promise.all([runEngineQuerySet('tikv'), runEngineQuerySet('tiflash')]);
  tikvTimings.forEach((ms) => tikvSamples.add(ms));
  tiflashTimings.forEach((ms) => tiflashSamples.add(ms));
  emitter.flow('tikv-dashboard', tikvTimings.length);
  emitter.flow('tiflash-dashboard', tiflashTimings.length);

  if (state.dashboardLoadActive) {
    const load = Array.from({ length: DASHBOARD_LOAD_CONCURRENCY }, () => runEngineQuerySet(state.activeEngine));
    await Promise.all(load);
    const edge = state.activeEngine === 'tikv' ? 'tikv-dashboard' : 'tiflash-dashboard';
    emitter.flow(edge, DASHBOARD_LOAD_CONCURRENCY * DASHBOARD_QUERIES.length);
  }

  const tikvSummary = summarize(tikvSamples.drain());
  if (tikvSummary !== undefined) {
    emitter.metric('dashboard-p50-tikv', tikvSummary.p50);
    emitter.metric('dashboard-p99-tikv', tikvSummary.p99);
  }
  const tiflashSummary = summarize(tiflashSamples.drain());
  if (tiflashSummary !== undefined) {
    emitter.metric('dashboard-p50-tiflash', tiflashSummary.p50);
    emitter.metric('dashboard-p99-tiflash', tiflashSummary.p99);
  }
};

const runTiflashReplicaTick = async (phase: PhaseId): Promise<void> => {
  const replicaStatus = await readTiflashReplicaStatus(pool);
  emitter.metric('tiflash-replica-progress', replicaStatus.progress * 100);
  if (phase !== 'tiflash-replica' || tiflashReplicaChecked) return;
  if (!tiflashReplicaCheckStarted) {
    emitter.check('tiflash-replica-available', 'pending');
    tiflashReplicaCheckStarted = true;
  }
  if (replicaStatus.available) {
    emitter.node('tiflash', 'healthy');
    emitter.check(
      'tiflash-replica-available',
      'pass',
      `progress=${replicaStatus.progress.toFixed(2)} available=${replicaStatus.available}`,
    );
    tiflashReplicaChecked = true;
  }
};

const tick = async (): Promise<void> => {
  const elapsedMs = emitter.elapsedMs();
  const phase = phaseForElapsed(elapsedMs);
  if (phase !== lastPhase) {
    emitter.phase(phase);
    onPhaseEnter(phase);
    lastPhase = phase;
  }

  await runWriteTick(elapsedMs, phase);
  await runDashboardTick();
  await runTiflashReplicaTick(phase);

  if (phase === 'dashboard-on-tiflash' && !snapshotChecked) {
    await runSnapshotCheck();
    snapshotChecked = true;
  }
};

onControl((id) => {
  if (id === 'start-dashboard-load') {
    state.dashboardLoadActive = true;
    return;
  }
  if (id === 'route-to-tikv') {
    state.activeEngine = 'tikv';
    return;
  }
  if (id === 'route-to-tiflash') {
    state.activeEngine = 'tiflash';
    return;
  }
  if (id === 'write-burst') {
    state.burstUntilMs = Date.now() + BURST_DURATION_MS;
  }
});

const shutdown = (): void => {
  controller.abort();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

emitter.phase('intro');
onPhaseEnter('intro');
lastPhase = 'intro';

await every({ intervalMs: TICK_MS, task: tick, signal: controller.signal });
await pool.end();
