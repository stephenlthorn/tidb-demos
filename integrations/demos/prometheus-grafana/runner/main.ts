import { createEmitter, every, onControl, createTidbPool } from '@lab/runner-kit';
import { createPrometheusClient } from './src/prometheusClient';
import { createAlertmanagerClient } from './src/alertmanagerClient';
import { createWebhookReceiver } from './src/webhookReceiver';
import { qpsQuery, p99LatencyQuery, tikvWriteRateQuery, connectionsQuery } from './src/promql';
import { detectionLatencySeconds, recoveryLatencySeconds } from './src/latency';
import { createFaultState, faultInjected, faultsCleared, type FaultId } from './src/faultState';
import { startWorkload } from './src/workload';
import { computeCounterDelta } from './src/flowDeltas';
import {
  runSlowQueryStorm,
  runWriteHotSpot,
  runConnectionSurge,
  stopTikvStore,
  startTikvStore,
  clearAllFaults,
  type FaultHandle,
  type TikvPlaygroundHandle,
} from './src/faultInjector';

const FAULT_TIMEOUT_MS = 90_000;
const RESOLVE_TIMEOUT_MS = 90_000;

const ALERT_NAME_BY_FAULT: Readonly<Record<FaultId, string>> = {
  'slow-query-storm': 'LabSlowQueryStorm',
  'write-hot-spot': 'LabWriteHotSpot',
  'store-outage': 'LabStoreOutage',
  'connection-surge': 'LabConnectionSurge',
};

const FAULT_ALERT_NAMES: readonly string[] = Object.values(ALERT_NAME_BY_FAULT);

const main = async (): Promise<void> => {
  const emitter = createEmitter();
  const pool = createTidbPool();
  const prometheus = createPrometheusClient({ baseUrl: process.env.LAB_PROMETHEUS_URL ?? 'http://localhost:9091' });
  const alertmanager = createAlertmanagerClient({ baseUrl: process.env.LAB_ALERTMANAGER_URL ?? 'http://localhost:9093' });
  const webhook = createWebhookReceiver({ port: Number(process.env.WEBHOOK_PORT ?? 9095) });

  let faultState = createFaultState();
  let activeFaultHandles: readonly FaultHandle[] = [];
  let detectionSettled = true;
  let resolveSettled = true;
  let clearedAtMs: number | undefined;
  let previousCompletedQueries: number | undefined;
  let previousWebhookArrivals: number | undefined;
  let stoppedTikv: TikvPlaygroundHandle | undefined;

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
  emitter.node('prometheus', 'healthy');
  emitter.node('grafana', 'healthy');
  emitter.node('alertmanager', 'healthy');
  emitter.node('webhook-receiver', 'healthy');
  emitter.node('workload', 'starting');
  emitter.phase('intro');

  const workload = await startWorkload({ pool, intervalMs: 200 });
  emitter.node('workload', 'busy');
  emitter.log('info', 'workload generator started against TiDB');

  const pollFault = (): void => {
    const active = faultState.active;
    if (active === undefined || detectionSettled) return;
    const alertname = ALERT_NAME_BY_FAULT[active.fault];
    const arrival = webhook
      .arrivals()
      .find((entry) => entry.alertname === alertname && entry.status === 'firing' && entry.receivedAtMs >= active.injectedAtMs);
    if (arrival !== undefined) {
      detectionSettled = true;
      emitCheckPass(active.fault, `alertmanager webhook received ${alertname} firing`);
      const latency = detectionLatencySeconds({ injectedAtMs: active.injectedAtMs, receivedAtMs: arrival.receivedAtMs });
      if (latency !== undefined) emitter.metric('detection-latency', latency);
      return;
    }
    if (Date.now() - active.injectedAtMs > FAULT_TIMEOUT_MS) {
      detectionSettled = true;
      emitCheckFail(active.fault, `no alertmanager webhook arrival for ${alertname} within ${FAULT_TIMEOUT_MS / 1000}s`);
    }
  };

  const pollResolution = async (): Promise<void> => {
    if (clearedAtMs === undefined || resolveSettled) return;
    const activeNames = await alertmanager.activeAlertNames();
    const stillFiring = FAULT_ALERT_NAMES.some((name) => activeNames.includes(name));
    if (!stillFiring) {
      resolveSettled = true;
      const resolvedAtMs = Date.now();
      emitter.check('resolve-all', 'pass', 'alertmanager reports no active lab alerts');
      const latency = recoveryLatencySeconds({ clearedAtMs, resolvedAtMs });
      if (latency !== undefined) emitter.metric('recovery-latency', latency);
      return;
    }
    if (Date.now() - clearedAtMs > RESOLVE_TIMEOUT_MS) {
      resolveSettled = true;
      emitter.check('resolve-all', 'fail', 'alertmanager still reports an active lab alert after clear-faults');
    }
  };

  const controller = new AbortController();
  void every({
    intervalMs: 1000,
    signal: controller.signal,
    task: async () => {
      const [qps, p99, tikvWriteRate, connections] = await Promise.all([
        prometheus.instantQuery(qpsQuery({ windowSeconds: 60 })),
        prometheus.instantQuery(p99LatencyQuery({ windowSeconds: 60 })),
        prometheus.instantQuery(tikvWriteRateQuery({ windowSeconds: 60 })),
        prometheus.instantQuery(connectionsQuery()),
      ]);
      if (qps.value !== undefined) emitter.metric('qps', qps.value);
      if (p99.value !== undefined) emitter.metric('p99-latency', p99.value);
      if (tikvWriteRate.value !== undefined) emitter.metric('tikv-write-rate', tikvWriteRate.value);
      if (connections.value !== undefined) emitter.metric('active-connections', connections.value);

      const completedQueries = workload.completedQueries();
      emitter.flow('workload-tidb', computeCounterDelta({ previous: previousCompletedQueries, current: completedQueries }));
      previousCompletedQueries = completedQueries;

      const webhookArrivals = webhook.arrivals().length;
      emitter.flow('alertmanager-webhook', computeCounterDelta({ previous: previousWebhookArrivals, current: webhookArrivals }));
      previousWebhookArrivals = webhookArrivals;

      pollFault();
      await pollResolution();
    },
  });

  const inject = (fault: FaultId, handle: FaultHandle): void => {
    activeFaultHandles = [...activeFaultHandles, handle];
    faultState = faultInjected(faultState, { fault, atMs: Date.now() });
    detectionSettled = false;
    emitCheckPending(fault);
    emitFaultPhase(fault);
  };

  onControl((id) => {
    if (id === 'inject-slow-query-storm') inject('slow-query-storm', runSlowQueryStorm(pool));
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
      faultState = faultInjected(faultState, { fault: 'store-outage', atMs: Date.now() });
      detectionSettled = false;
      emitCheckPending('store-outage');
      emitFaultPhase('store-outage');
      void stopTikvStore().then((handle) => {
        stoppedTikv = handle;
        emitter.node('tikv', 'down');
        emitter.log('warn', 'killed the tikv process outright to simulate an unplanned store outage', 'tikv');
      });
    }
    if (id === 'clear-faults') {
      resolveSettled = false;
      emitter.check('resolve-all', 'pending');
      void clearAllFaults(activeFaultHandles).then(async () => {
        activeFaultHandles = [];
        faultState = faultsCleared(faultState);
        clearedAtMs = Date.now();
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
