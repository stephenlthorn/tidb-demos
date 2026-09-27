import {
  createEmitter,
  createTidbPool,
  createSampleWindow,
  summarize,
  timed,
  every,
  onControl,
} from '@lab/runner-kit';
import {
  createEventsTableSql,
  createHeartbeatsTableSql,
  createScoresTableSql,
  enableTiflashReplicaSql,
} from './src/tidbSchema';
import { generateEvent } from './src/eventGenerator';
import { velocityRule, nextRule, type ScoringRule } from './src/scoringRule';
import {
  buildScoringStatement,
  buildFederatedHeartbeatStatement,
  type FederationConfig,
} from './src/scoringStatement';
import { buildUpsertStatement, type ScoredRow } from './src/upsertStatement';
import { computeFreshnessLagMs, computeFullLoopSeconds, parseDatabricksTimestamp } from './src/freshness';
import { runStatement, type DatabricksConfig } from './src/statementExecutionClient';

const env = process.env;

const numberFromEnv = (name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const requireEnv = (name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const federationConfig: FederationConfig = {
  federatedCatalog: env.DATABRICKS_FEDERATION_CATALOG ?? 'tidb_fed',
  federatedSchema: env.DATABRICKS_FEDERATION_SCHEMA ?? 'lab',
  eventsTable: 'events',
  heartbeatsTable: 'heartbeats',
  scoresCatalog: env.DATABRICKS_SCORES_CATALOG ?? 'main',
  scoresSchema: env.DATABRICKS_SCORES_SCHEMA ?? 'lab_databricks',
  scoresTable: env.DATABRICKS_SCORES_TABLE ?? 'risk_scores',
};

const databricksConfig: DatabricksConfig = {
  host: requireEnv('DATABRICKS_HOST'),
  token: requireEnv('DATABRICKS_TOKEN'),
  warehouseId: requireEnv('DATABRICKS_WAREHOUSE_ID'),
  statementTimeoutMs: numberFromEnv('DATABRICKS_STATEMENT_TIMEOUT_MS', 60000),
};

const eventIntervalMs = numberFromEnv('EVENT_WRITE_INTERVAL_MS', 1000);
const scoringIntervalMs = numberFromEnv('SCORING_INTERVAL_MS', 15000);
const burstEventCount = numberFromEnv('BURST_EVENT_COUNT', 200);
const customerCount = numberFromEnv('CUSTOMER_COUNT', 50);

const pool = createTidbPool(env);
const emitter = createEmitter();
const servingLatencies = createSampleWindow();
const controller = new AbortController();

let currentRule: ScoringRule = velocityRule;
let lastEventWrittenAtMs = Date.now();
let pendingWriteCount = 0;
let scoringInFlight = false;
let sawZeroWritesDuringScoring = false;
let federationCheckSent = false;
let scoresCheckSent = false;

const toDateTimeMs = (ms: number): string => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const toExecuteParam = (value: unknown): string | number | Date => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value;
  throw new Error(`unsupported query parameter type: ${typeof value}`);
};

const qualifiedScoresTable = (): string =>
  `${federationConfig.scoresCatalog}.${federationConfig.scoresSchema}.${federationConfig.scoresTable}`;

const ensureSchema = async (): Promise<void> => {
  await pool.query(createEventsTableSql);
  await pool.query(createHeartbeatsTableSql);
  await pool.query(createScoresTableSql);
  await pool.query(enableTiflashReplicaSql).catch(() => undefined);
};

const insertEvent = async (): Promise<void> => {
  const event = generateEvent(customerCount, Math.random);
  await pool.execute(
    'INSERT INTO events (customer_id, event_type, amount, created_at) VALUES (?, ?, ?, ?)',
    [event.customerId, event.eventType, event.amount, toDateTimeMs(Date.now())],
  );
  lastEventWrittenAtMs = Date.now();
  pendingWriteCount += 1;
};

const writeHeartbeat = async (): Promise<void> => {
  await pool.execute(
    'INSERT INTO heartbeats (id, written_at) VALUES (1, ?) ON DUPLICATE KEY UPDATE written_at = VALUES(written_at)',
    [toDateTimeMs(Date.now())],
  );
};

const readRandomScore = async (): Promise<void> => {
  const { ms } = await timed(async () => {
    await pool.execute('SELECT customer_id, score, rule, updated_at FROM customer_risk_scores ORDER BY RAND() LIMIT 1');
  });
  servingLatencies.add(ms);
  emitter.flow('serving-reads', 1);
};

const eventLoopTick = async (): Promise<void> => {
  const writesBefore = pendingWriteCount;
  await insertEvent();
  await writeHeartbeat();
  await readRandomScore();
  const wroteThisTick = pendingWriteCount - writesBefore;
  if (wroteThisTick === 0 && scoringInFlight) sawZeroWritesDuringScoring = true;
  emitter.flow('writes', wroteThisTick);
  emitter.metric('event-write-rate', wroteThisTick / (eventIntervalMs / 1000));
  const summary = summarize(servingLatencies.drain());
  if (summary) {
    emitter.metric('serving-p50', summary.p50);
    emitter.metric('serving-p99', summary.p99);
  }
};

const runScoringOnce = async (): Promise<void> => {
  if (scoringInFlight) return;
  scoringInFlight = true;
  sawZeroWritesDuringScoring = false;
  const loopStartMs = lastEventWrittenAtMs;
  if (!federationCheckSent) emitter.check('federation-reachable', 'pending');
  if (!scoresCheckSent) emitter.check('scores-written-back', 'pending');
  emitter.check('loop-closed', 'pending');
  emitter.check('writes-continue-during-scoring', 'pending');
  try {
    emitter.phase('federated-read');
    emitter.node('databricks', 'busy', 'reading TiDB via Lakehouse Federation');
    const heartbeatResult = await runStatement(
      databricksConfig,
      buildFederatedHeartbeatStatement(federationConfig),
    );
    const heartbeatValue = heartbeatResult.rows[0]?.[0];
    if (heartbeatValue) {
      const lagMs = computeFreshnessLagMs(parseDatabricksTimestamp(heartbeatValue), Date.now());
      emitter.metric('freshness-lag-ms', lagMs);
      if (!federationCheckSent) {
        emitter.check('federation-reachable', 'pass', `${lagMs}ms lag`);
        federationCheckSent = true;
      }
    }

    const scoringResult = await runStatement(
      databricksConfig,
      buildScoringStatement(currentRule, federationConfig),
    );
    const rowsSynced = scoringResult.rowCount ?? 0;
    emitter.metric('rows-synced', rowsSynced);
    emitter.flow('federated-read', rowsSynced);

    emitter.phase('score-write-back');
    emitter.node('databricks', 'healthy', 'scoring complete');
    const readBackResult = await runStatement(
      databricksConfig,
      `SELECT customer_id, score, rule FROM ${qualifiedScoresTable()} WHERE rule = '${currentRule.name}'`,
    );
    const writeBackAtMs = Date.now();
    const scoredRows: readonly ScoredRow[] = readBackResult.rows.map((row) => ({
      customerId: Number(row[0]),
      score: Number(row[1]),
      rule: String(row[2]),
      updatedAtMs: writeBackAtMs,
    }));
    const upsert = buildUpsertStatement(scoredRows);
    if (upsert.sql !== '') {
      const { ms } = await timed(async () => {
        await pool.execute(upsert.sql, upsert.params.map(toExecuteParam));
      });
      const writeBackRate = scoredRows.length / Math.max(ms / 1000, 0.001);
      emitter.metric('write-back-rate', writeBackRate);
      emitter.flow('reverse-etl', scoredRows.length);
      if (!scoresCheckSent) {
        emitter.check('scores-written-back', 'pass', `${scoredRows.length} rows`);
        scoresCheckSent = true;
      }
    }

    const fullLoopSeconds = computeFullLoopSeconds(loopStartMs, writeBackAtMs);
    emitter.metric('full-loop-time', fullLoopSeconds);
    emitter.check('loop-closed', 'pass', `${fullLoopSeconds.toFixed(1)}s`);
    emitter.check(
      'writes-continue-during-scoring',
      sawZeroWritesDuringScoring ? 'fail' : 'pass',
      sawZeroWritesDuringScoring ? 'a tick recorded zero writes during scoring' : 'writes continued throughout',
    );
    emitter.phase('low-latency-serving');
  } catch (error) {
    emitter.log('error', `scoring run failed: ${errorMessage(error)}`, 'databricks');
    emitter.node('databricks', 'degraded', errorMessage(error));
  } finally {
    scoringInFlight = false;
  }
};

const runAdhocAnalytics = async (): Promise<void> => {
  emitter.phase('adhoc-analytics');
  const { value, ms } = await timed(async () => {
    const [rows] = await pool.query(
      '/*+ READ_FROM_STORAGE(TIFLASH[events]) */ SELECT event_type, COUNT(*) AS n, SUM(amount) AS total FROM events WHERE created_at >= NOW(3) - INTERVAL 5 MINUTE GROUP BY event_type',
    );
    return rows;
  });
  emitter.metric('analytics-query-ms', ms);
  emitter.flow('analytics-query', Array.isArray(value) ? value.length : 0);
};

const runBurst = async (): Promise<void> => {
  for (let i = 0; i < burstEventCount; i += 1) {
    await insertEvent();
  }
};

onControl((id) => {
  if (id === 'trigger-scoring') void runScoringOnce();
  if (id === 'burst-events') void runBurst();
  if (id === 'change-rule') {
    currentRule = nextRule(currentRule);
    emitter.log('info', `scoring rule now: ${currentRule.name}`);
    emitter.phase('rule-change');
  }
  if (id === 'run-analytics') void runAdhocAnalytics();
});

const main = async (): Promise<void> => {
  await ensureSchema();
  emitter.node('app', 'healthy');
  emitter.node('tidb', 'healthy');
  emitter.node('tiflash', 'healthy');
  emitter.node('databricks', 'idle');
  emitter.phase('steady-writes');

  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  await Promise.all([
    every({ intervalMs: eventIntervalMs, task: eventLoopTick, signal: controller.signal }),
    every({ intervalMs: scoringIntervalMs, task: runScoringOnce, signal: controller.signal }),
  ]);

  await pool.end();
};

main().catch((error) => {
  emitter.log('error', errorMessage(error));
  process.exitCode = 1;
});
