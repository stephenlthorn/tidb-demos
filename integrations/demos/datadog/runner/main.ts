import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createEmitter, createTidbPool, every, onControl, sleep } from '@lab/runner-kit';
import { startWorkload } from '@lab/demo-prometheus-grafana/workload';
import {
  clearAllFaults,
  runConnectionSurge,
  runSlowQueryStorm,
  runWriteHotSpot,
  startTikvStore,
  stopTikvStore,
  type FaultHandle,
  type TikvPlaygroundHandle,
} from '@lab/demo-prometheus-grafana/faults';
import { connectionsQuery, meanLatencyQuery, qpsQuery, tikvCpuQuery } from './src/datadogQuery';
import { createMetricsClient } from './src/metricsClient';
import { createMonitorClient } from './src/monitorClient';
import { loadMonitorIds } from './src/monitorIds';
import { detectionLatencySeconds } from './src/latency';
import { findMatchingDigestRow } from './src/digestCorrelation';
import { SLOW_QUERY_SQL } from './src/slowQuery';
import { computeCounterDelta } from './src/flowDeltas';

type FaultId = 'slow-query-storm' | 'write-hot-spot' | 'store-outage' | 'connection-surge';

const FAULT_TIMEOUT_MS = 90_000;
const CORRELATION_DELAY_MS = 2_000;

const StatementSummaryRowsSchema = z.array(z.object({ DIGEST: z.string(), QUERY_SAMPLE_TEXT: z.string() }));

const demoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const main = async (): Promise<void> => {
  const emitter = createEmitter();
  const pool = createTidbPool();
  const site = process.env.DD_SITE ?? 'datadoghq.com';
  const metrics = createMetricsClient({
    apiKey: process.env.DD_API_KEY ?? '',
    appKey: process.env.DD_APP_KEY ?? '',
    site,
  });
  const monitors = createMonitorClient({
    apiKey: process.env.DD_API_KEY ?? '',
    appKey: process.env.DD_APP_KEY ?? '',
    site,
  });
  const monitorIds = await loadMonitorIds(join(demoRoot, '.monitor-ids.json'));
  const apmServicePort = process.env.APM_SERVICE_PORT ?? '9096';

  let activeFault: FaultId | undefined;
  let activeMonitorId: number | undefined;
  let faultInjectedAtMs: number | undefined;
  let detectionSettled = true;
  let activeFaultHandles: readonly FaultHandle[] = [];
  let stoppedTikv: TikvPlaygroundHandle | undefined;
  let instrumentedQueryCount = 0;
  let previousCompletedQueries: number | undefined;

  const emitCheckPending = (fault: FaultId): void => {
    if (fault === 'slow-query-storm') emitter.check('detect-slow-query-storm', 'pending');
    if (fault === 'write-hot-spot') emitter.check('detect-write-hot-spot', 'pending');
    if (fault === 'store-outage') emitter.check('detect-store-outage', 'pending');
    if (fault === 'connection-surge') emitter.check('detect-connection-surge', 'pending');
  };

  const emitCheckPass = (fault: FaultId, observed: string): void => {
    if (fault === 'slow-query-storm') emitter.check('detect-slow-query-storm', 'pass', observed);
    if (fault === 'write-hot-spot') emitter.check('detect-write-hot-spot', 'pass', observed);
    if (fault === 'store-outage') emitter.check('detect-store-outage', 'pass', observed);
    if (fault === 'connection-surge') emitter.check('detect-connection-surge', 'pass', observed);
  };

  const emitCheckFail = (fault: FaultId, observed: string): void => {
    if (fault === 'slow-query-storm') emitter.check('detect-slow-query-storm', 'fail', observed);
    if (fault === 'write-hot-spot') emitter.check('detect-write-hot-spot', 'fail', observed);
    if (fault === 'store-outage') emitter.check('detect-store-outage', 'fail', observed);
    if (fault === 'connection-surge') emitter.check('detect-connection-surge', 'fail', observed);
  };

  const emitFaultPhase = (fault: FaultId): void => {
    if (fault === 'slow-query-storm') emitter.phase('slow-query-storm');
    if (fault === 'write-hot-spot') emitter.phase('write-hot-spot');
    if (fault === 'store-outage') emitter.phase('store-outage');
    if (fault === 'connection-surge') emitter.phase('connection-surge');
  };

  emitter.node('tidb', 'healthy');
  emitter.node('pd', 'healthy');
  emitter.node('tikv', 'healthy');
  emitter.node('dd-agent', 'healthy');
  emitter.node('datadog', 'healthy');
  emitter.node('apm-service', 'healthy');
  emitter.node('workload', 'starting');
  emitter.phase('intro');

  const workload = await startWorkload({ pool, intervalMs: 200 });
  emitter.node('workload', 'busy');
  emitter.log('info', 'workload generator started against TiDB');

  const runSlowSpanCorrelation = async (): Promise<void> => {
    emitter.check('slow-span-correlated', 'pending');
    await sleep(CORRELATION_DELAY_MS);
    const [rows] = await pool.query(
      'SELECT DIGEST, QUERY_SAMPLE_TEXT FROM information_schema.statements_summary WHERE QUERY_SAMPLE_TEXT = ?',
      [SLOW_QUERY_SQL],
    );
    const parsedRows = StatementSummaryRowsSchema.parse(rows);
    const match = findMatchingDigestRow({ spanSql: SLOW_QUERY_SQL, rows: parsedRows });
    emitter.check('slow-span-correlated', match === undefined ? 'fail' : 'pass', match?.DIGEST);
  };

  const pollFault = async (): Promise<void> => {
    if (activeFault === undefined || activeMonitorId === undefined || faultInjectedAtMs === undefined) return;
    if (detectionSettled) return;
    const state = await monitors.get(activeMonitorId);
    if (state.overallState === 'Alert') {
      detectionSettled = true;
      const observedAtMs = Date.now();
      emitCheckPass(activeFault, `datadog monitor overall_state=Alert (id ${activeMonitorId})`);
      const detectionLatency = detectionLatencySeconds({ injectedAtMs: faultInjectedAtMs, alertObservedAtMs: observedAtMs });
      if (detectionLatency !== undefined) emitter.metric('detection-latency', detectionLatency);
      return;
    }
    if (Date.now() - faultInjectedAtMs > FAULT_TIMEOUT_MS) {
      detectionSettled = true;
      emitCheckFail(activeFault, `no Alert overall_state within ${FAULT_TIMEOUT_MS / 1000}s (monitor id ${activeMonitorId})`);
    }
  };

  const controller = new AbortController();

  void every({
    intervalMs: 1000,
    signal: controller.signal,
    task: async () => {
      const [qps, latency, tikvCpu, connections] = await Promise.all([
        metrics.latestValue(qpsQuery()),
        metrics.latestValue(meanLatencyQuery()),
        metrics.latestValue(tikvCpuQuery()),
        metrics.latestValue(connectionsQuery()),
      ]);
      if (qps !== undefined) emitter.metric('qps', qps);
      if (latency !== undefined) emitter.metric('p99-latency', latency);
      if (tikvCpu !== undefined) emitter.metric('tikv-cpu', tikvCpu);
      if (connections !== undefined) emitter.metric('active-connections', connections);

      const completedQueries = workload.completedQueries();
      emitter.flow('workload-tidb', computeCounterDelta({ previous: previousCompletedQueries, current: completedQueries }));
      previousCompletedQueries = completedQueries;
    },
  });

  void every({
    intervalMs: 5000,
    signal: controller.signal,
    task: pollFault,
  });

  const inject = (fault: FaultId, handle: FaultHandle | undefined): void => {
    if (handle !== undefined) activeFaultHandles = [...activeFaultHandles, handle];
    activeFault = fault;
    faultInjectedAtMs = Date.now();
    activeMonitorId = monitorIds[fault];
    detectionSettled = false;
    emitCheckPending(fault);
    emitFaultPhase(fault);
  };

  onControl((id) => {
    if (id === 'inject-slow-query-storm') {
      void fetch(`http://localhost:${apmServicePort}/slow-query`)
        .then((response) => {
          if (!response.ok) return undefined;
          instrumentedQueryCount += 1;
          emitter.metric('trace-count', instrumentedQueryCount);
          emitter.flow('apm-tidb', 1);
          emitter.flow('apm-datadog', 1);
          return runSlowSpanCorrelation();
        })
        .catch(() => {
          emitter.log('warn', 'apm-service /slow-query request failed', 'apm-service');
        });
      inject('slow-query-storm', runSlowQueryStorm(pool));
    }
    if (id === 'inject-write-hot-spot') inject('write-hot-spot', runWriteHotSpot(pool));
    if (id === 'inject-connection-surge') {
      inject(
        'connection-surge',
        runConnectionSurge(async () => {
          const connection = await pool.getConnection();
          return { end: async () => connection.destroy() };
        }),
      );
    }
    if (id === 'inject-store-outage') {
      inject('store-outage', undefined);
      void stopTikvStore().then((handle) => {
        stoppedTikv = handle;
        emitter.node('tikv', 'down');
      });
    }
    if (id === 'clear-faults') {
      void clearAllFaults(activeFaultHandles).then(async () => {
        activeFaultHandles = [];
        activeFault = undefined;
        activeMonitorId = undefined;
        faultInjectedAtMs = undefined;
        if (stoppedTikv !== undefined) {
          const handle = stoppedTikv;
          stoppedTikv = undefined;
          await startTikvStore(handle);
          emitter.node('tikv', 'healthy');
        }
        emitter.phase('recovery');
      });
    }
  });
};

void main();
