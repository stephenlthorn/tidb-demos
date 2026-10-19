import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createS3EventSink } from '@lab/agent-stack-kit';
import { createEmitter, createTidbPool, every, onControl, sleep } from '@lab/runner-kit';
import { loadConfig } from './src/config';
import { PastCasesSchema, PlaybookSchema, WatchlistFixtureSchema } from './src/fixtures';
import { createSerialQueue } from './src/queue';
import { createStore } from './src/store';
import { errorMessage, type CaseRecord, type Context, type World } from './src/live/context';
import { evaluateInLake, promoteSkill, recordVerdicts, stageSkillUpdate } from './src/live/learn';
import { openInvestigation, testRuleOnBranch } from './src/live/investigate';
import { connectLake } from './src/live/lake';
import { createRowSink } from './src/live/sinks';
import { runSetup } from './src/live/setup';
import { baselineTick, injectStructuringRing, injectWatchlistNearMatch } from './src/live/traffic';

const fixturesDirectory = fileURLToPath(new URL('./fixtures', import.meta.url));
const readJson = (name: string): unknown => JSON.parse(readFileSync(`${fixturesDirectory}/${name}`, 'utf8'));

const config = loadConfig(process.env);
const watchlist = WatchlistFixtureSchema.parse(readJson('watchlist.json'));
const emitter = createEmitter();
const controller = new AbortController();
const trafficQueue = createSerialQueue();
const caseQueue = createSerialQueue();
const runId = `run-${Date.now().toString(36)}`;
const pool = createTidbPool(process.env);

const emptyWorld = (): World => ({
  population: { accounts: [], lookAlikeIds: [] },
  accounts: [],
  truth: [],
  watchlistEntries: 0,
  watchlistCandidates: new Map(),
  nextTxnId: 1,
  lastDayStartMs: config.firstDayStartMs,
  dayCounter: 0,
  ringCount: 0,
  ringAccountCount: 0,
  nearMatchCount: 0,
  exportedUpToTxnId: 0,
  lastAlertCommitWallMs: Date.now(),
  runEventSeq: 0,
  flagsEmitted: 0,
  coverageStatus: 'pending',
});

const sinkFor = (kind: string) =>
  createRowSink(createS3EventSink({ bucket: config.bucket, prefix: `lake/events/${kind}`, region: config.region }));

const ctx: Context = {
  config,
  database: process.env.TIDB_DATABASE ?? 'harbor_core',
  runId,
  emitter,
  pool,
  lake: connectLake(process.env),
  sinks: { truth: sinkFor('truth'), flags: sinkFor('flags'), run: sinkFor('run') },
  fixtures: {
    directory: fixturesDirectory,
    watchlistNames: watchlist.entries,
    watchlistTag: watchlist.listTag,
    pastCases: PastCasesSchema.parse(readJson('past-cases.json')),
    playbook: PlaybookSchema.parse(readJson('playbook.json')),
  },
  world: createStore<World>(emptyWorld()),
  cases: createStore<readonly CaseRecord[]>([]),
};

let ready = false;

const guarded = (queue: ReturnType<typeof createSerialQueue>, label: string, task: () => Promise<void>): void => {
  if (!ready) {
    emitter.log('warn', `${label} ignored: setup is still running`);
    return;
  }
  queue.enqueue(task).catch((error: unknown) => emitter.log('error', `${label} failed: ${errorMessage(error)}`));
};

const runRuleTest = async (): Promise<void> => {
  await testRuleOnBranch(ctx);
  await recordVerdicts(ctx);
  const evidence = await evaluateInLake(ctx);
  await stageSkillUpdate(ctx, evidence);
};

onControl((id) => {
  if (id === 'inject-structuring-ring') guarded(trafficQueue, id, () => injectStructuringRing(ctx));
  if (id === 'inject-watchlist-near-match') guarded(trafficQueue, id, () => injectWatchlistNearMatch(ctx));
  if (id === 'open-investigation') guarded(caseQueue, id, () => openInvestigation(ctx));
  if (id === 'test-rule-on-branch') guarded(caseQueue, id, runRuleTest);
  if (id === 'promote-skill') guarded(caseQueue, id, () => promoteSkill(ctx));
});

const shutdown = async (): Promise<void> => {
  controller.abort();
  await Promise.race([pool.end(), sleep(3000)]);
  process.exit(process.exitCode ?? 0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const main = async (): Promise<void> => {
  await runSetup(ctx);
  ready = true;
  emitter.phase('baseline-traffic');
  await every({
    intervalMs: config.tickMs,
    task: () =>
      trafficQueue.enqueue(() => baselineTick(ctx)).catch((error: unknown) => {
        emitter.log('error', `traffic tick failed: ${errorMessage(error)}`, 'txn-generator');
      }),
    signal: controller.signal,
  });
};

main().catch(async (error: unknown) => {
  emitter.log('error', errorMessage(error));
  process.exitCode = 1;
  await shutdown();
});
