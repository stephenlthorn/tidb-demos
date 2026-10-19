import { timed } from '@lab/runner-kit';
import type { Stage } from '../context';
import { countVerdict } from '../checks';
import { markerEvent } from '../events';
import { hashEmbedding } from '../embedding';
import {
  copyLedgerSql,
  countLedgerSql,
  countMarkerSql,
  countRunEventsSql,
  executeEventsTaskSql,
  matchResetSql,
  mergedPerDollarSql,
  similarFailuresSql,
} from '../lakeSql';
import { buildExportArgs, buildExportDescribeArgs, parseExportId, parseExportState, type ExportState } from '../ticloudExport';

const count = (rows: readonly Readonly<Record<string, unknown>>[]): number => Number(rows[0]?.n ?? 0);

const pollUntil = async (options: {
  readonly deadlineMs: number;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly done: () => Promise<boolean>;
}): Promise<boolean> => {
  if (await options.done()) return true;
  if (Date.now() >= options.deadlineMs) return false;
  await options.sleep(options.intervalMs);
  return pollUntil(options);
};

const waitForExport = async (options: {
  readonly stage: Stage;
  readonly exportId: string;
  readonly deadlineMs: number;
}): Promise<ExportState> => {
  const { config, run, sleep } = options.stage.deps;
  const described = await run({
    bin: 'ticloud',
    args: buildExportDescribeArgs({ clusterId: config.orgClusterId, exportId: options.exportId }),
  });
  const state = parseExportState(described.stdout);
  if (state !== 'running' || Date.now() >= options.deadlineMs) return state;
  await sleep(5000);
  return waitForExport(options);
};

const exportLedger = async (stage: Stage): Promise<void> => {
  const { deps } = stage;
  const { config, emitter, run, lake, orgPool } = deps;
  const database = deps.env.TIDB_DATABASE ?? 'agent_coding';
  const sourceRows = count(await orgPool.rows('SELECT COUNT(*) AS n FROM ledger WHERE run_id = ?', [config.runId]));
  const created = await run({
    bin: 'ticloud',
    args: buildExportArgs({
      clusterId: config.orgClusterId,
      s3Uri: `s3://${config.bucket}/${config.prefix}/${config.runId}/ledger`,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
      filter: `${database}.ledger`,
    }),
  });
  if (created.code !== 0) throw new Error(`ticloud serverless export create failed: ${created.stderr.trim()}`);
  const exportId = parseExportId(created.stdout);
  emitter.flow('ledger-export', sourceRows);
  emitter.log('info', `ledger export ${exportId} started (${sourceRows} rows for this run, Parquet to S3)`, 'ledger');
  const finalState = await waitForExport({ stage, exportId, deadlineMs: Date.now() + config.exportTimeoutMs });
  if (finalState !== 'completed') {
    throw new Error(`ledger export ${exportId} ${finalState === 'failed' ? 'failed' : 'timed out'}`);
  }
  await lake.query(copyLedgerSql);
  const loaded = count(await lake.query(countLedgerSql(config.runId)));
  emitter.flow('lake-load', loaded);
  emitter.log('info', `Lake ledger rows for this run: ${loaded} of ${sourceRows} exported`, 'lake');
};

const awaitFreshness = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, sink, lake, sleep } = deps;
  const markerId = `mk-${config.runId}`;
  const startedAt = Date.now();
  await sink.write([JSON.stringify(markerEvent({ runId: config.runId, markerId, nowMs: startedAt }))]);
  memory.eventsEmitted += 1;
  emitter.metric('events-emitted', memory.eventsEmitted);
  emitter.flow('events-out', 1);
  if (config.executeLakeTask) await lake.query(executeEventsTaskSql);
  const seen = await pollUntil({
    deadlineMs: startedAt + config.freshnessTimeoutMs,
    intervalMs: 3000,
    sleep,
    done: async () => count(await lake.query(countMarkerSql({ runId: config.runId, markerId }))) > 0,
  });
  const lagSeconds = (Date.now() - startedAt) / 1000;
  if (seen) {
    emitter.metric('lake-freshness-s', lagSeconds);
    emitter.log('info', `marker visible in Lake ${lagSeconds.toFixed(1)} s after it was written to S3`, 'lake');
  }
  emitter.check('lake-count-matches', 'pending');
  let visible = 0;
  await pollUntil({
    deadlineMs: Date.now() + config.freshnessTimeoutMs,
    intervalMs: 3000,
    sleep,
    done: async () => {
      visible = count(await lake.query(countRunEventsSql(config.runId)));
      emitter.metric('lake-events-visible', visible);
      return visible >= memory.eventsEmitted;
    },
  });
  const verdict = countVerdict({ emitted: memory.eventsEmitted, visible });
  emitter.check('lake-count-matches', verdict.pass ? 'pass' : 'fail', verdict.observed);
  const first = memory.firstEventWrittenAtMs ?? startedAt;
  emitter.metric('lake-rows-per-min', visible / Math.max((Date.now() - first) / 60000, 1 / 60));
  emitter.flow('lake-load', visible);
};

const runEvalQueries = async ({ deps, memory }: Stage): Promise<void> => {
  const { config, emitter, lake } = deps;
  emitter.node('eval', 'busy', 'running eval queries');
  const reset = await timed(() => lake.query(matchResetSql));
  emitter.metric('eval-query-ms', reset.ms);
  emitter.log('info', `MATCH 'ECONNRESET': ${String(reset.value[0]?.matches)} events across ${String(reset.value[0]?.runs)} runs`, 'eval');
  const perDollar = await timed(() => lake.query(mergedPerDollarSql));
  emitter.metric('eval-query-ms', perDollar.ms);
  perDollar.value.forEach((row) =>
    emitter.log('info', `merged per dollar (modeled, fixture model labels): ${String(row.model)} ${Number(row.merged_per_dollar).toFixed(2)}`, 'eval'),
  );
  const message = memory.failureMessage ?? 'ECONNRESET at step 7';
  const similar = await timed(() =>
    lake.query(similarFailuresSql({ runId: config.runId, vector: hashEmbedding(message), limit: 3 })),
  );
  emitter.metric('eval-query-ms', similar.ms);
  similar.value.forEach((row) =>
    emitter.log('info', `similar past failure (cosine distance ${Number(row.distance).toFixed(3)}): ${String(row.message)}`, 'eval'),
  );
  emitter.flow('eval-queries', 3);
  emitter.node('eval', 'healthy', 'eval queries complete');
};

export const lakeEval = async (stage: Stage): Promise<void> => {
  const { deps } = stage;
  const { emitter } = deps;
  emitter.phase('lake-eval');
  emitter.node('lake', 'busy', 'loading events and ledger');
  emitter.node('s3-events', 'busy', 'events and ledger export');
  await exportLedger(stage).catch((error: unknown) =>
    emitter.log('error', `ledger export skipped: ${error instanceof Error ? error.message : String(error)}`, 'ledger'),
  );
  await awaitFreshness(stage);
  emitter.node('s3-events', 'healthy');
  emitter.node('lake', 'healthy');
  await runEvalQueries(stage);
};
