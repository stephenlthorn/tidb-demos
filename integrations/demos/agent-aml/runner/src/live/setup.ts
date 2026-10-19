import { quoteIdentifier, timed } from '@lab/runner-kit';
import { DAY_MS } from '../time';
import { createRng, deriveSeed } from '../prng';
import { buildPopulation, generateHistory, plantRapidInOut } from '../generator';
import { baselineRules, replayHistory } from '../rules';
import { countHistoryUpTo, resetLakeStatements } from '../lakeSql';
import { truthRow } from '../sinkRows';
import {
  ensureSchema,
  execute,
  insertAlerts,
  insertPeople,
  insertTransactions,
  insertTruth,
  maxTxnId,
  rowsOf,
  screenAccounts,
  serverNowMs,
  transactionCountUpTo,
} from '../starter';
import { episodicInsert, ruleUpsert, watchlistInsert } from '../starterSql';
import { errorMessage, type Context, type World } from './context';
import { seedFileSystem, seedVaultSecret } from './filesystem';
import { awaitRowCount, setupLake } from './lake';
import { clearLakePrefix, runTransactionExport } from './exports';

const isEmpty = async (ctx: Context, table: string): Promise<boolean> => {
  const [row] = await rowsOf(ctx.pool, `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)}`);
  return Number(row?.n ?? 0) === 0;
};

const seedReferenceData = async (ctx: Context): Promise<void> => {
  const { pool, config, fixtures } = ctx;
  await baselineRules(config.thresholdCents).reduce(async (previous, rule) => {
    await previous;
    await execute(pool, ruleUpsert(rule));
  }, Promise.resolve());
  await execute(
    pool,
    watchlistInsert(fixtures.watchlistNames.map((fullName) => ({ fullName, listTag: fixtures.watchlistTag }))),
  );
  await execute(pool, episodicInsert(fixtures.pastCases));
};

const seedFiles = async (ctx: Context): Promise<void> => {
  await seedFileSystem(ctx.fixtures.directory);
  await seedVaultSecret().catch((error: unknown) => {
    if (!/exist|already/i.test(errorMessage(error))) throw error;
  });
  ctx.emitter.node('case-layers', 'healthy', 'skills seeded under /harbor/skills');
  ctx.emitter.node('skills-base', 'healthy');
  ctx.emitter.node('vault', 'healthy', 'synthetic watchlist secret stored');
};

export const runSetup = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config } = ctx;
  emitter.phase('setup');
  ['txn-generator', 'harbor-core', 'rule-engine', 'agent-harness', 'episodic-memory'].forEach((node) =>
    emitter.node(node, 'starting'),
  );
  await ensureSchema(pool, config.reset);
  if (!(await isEmpty(ctx, 'transactions'))) {
    throw new Error('harbor_core already holds data; set AML_RESET=true to wipe and reseed it');
  }
  await seedReferenceData(ctx);
  emitter.node('episodic-memory', 'healthy', `${ctx.fixtures.pastCases.length} past cases embedded on insert`);
  await seedFiles(ctx);

  const population = buildPopulation({
    rng: createRng(deriveSeed(config.seed, 'population')),
    retailCount: config.retailCount,
    businessCount: config.businessCount,
    lookAlikeCount: config.lookAlikeCount,
    branchCount: config.branchCount,
  });
  const history = generateHistory({
    rng: createRng(deriveSeed(config.seed, 'history')),
    population,
    days: config.historyDays,
    firstDayStartMs: config.firstDayStartMs,
    firstTxnId: 1,
    thresholdCents: config.thresholdCents,
  });
  const rapid = plantRapidInOut({
    rng: createRng(deriveSeed(config.seed, 'rapid')),
    dayStartMs: config.firstDayStartMs + (config.historyDays - 20) * DAY_MS,
    firstTxnId: history.nextTxnId,
    accountNumber: 1,
    branchCount: config.branchCount,
  });
  const accounts = [...population.accounts, ...rapid.accounts];
  const transactions = [...history.transactions, ...rapid.transactions];
  const lastDayStartMs = config.firstDayStartMs + (config.historyDays - 1) * DAY_MS;

  await insertPeople(pool, accounts);
  const inserted = await insertTransactions(pool, transactions);
  await insertTruth(pool, rapid.truth);
  emitter.flow('txn-writes', inserted);
  emitter.log('info', `seeded ${accounts.length} accounts and ${inserted} synthetic transactions`, 'harbor-core');

  const watchlistCandidates = await screenAccounts(pool, accounts);
  const alerts = replayHistory({
    rules: baselineRules(config.thresholdCents),
    accounts,
    transactions,
    watchlistCandidates,
    firstDayStartMs: config.firstDayStartMs,
    lastDayStartMs,
    lookbackDays: 14,
  });
  const created = await insertAlerts(pool, alerts);
  emitter.flow('alerts-written', created);
  emitter.log('info', `baseline rules v1 replayed over history: ${created} alerts`, 'rule-engine');
  ['txn-generator', 'harbor-core', 'rule-engine', 'agent-harness'].forEach((node) => emitter.node(node, 'healthy'));

  const serverStartMs = await serverNowMs(pool);
  ctx.world.update(
    (): World => ({
      population,
      accounts,
      truth: rapid.truth,
      watchlistEntries: ctx.fixtures.watchlistNames.length,
      watchlistCandidates,
      nextTxnId: rapid.nextTxnId,
      lastDayStartMs,
      dayCounter: config.historyDays,
      ringCount: 0,
      ringAccountCount: 0,
      nearMatchCount: 0,
      exportedUpToTxnId: 0,
      lastAlertCommitWallMs: serverStartMs,
      runEventSeq: 0,
      flagsEmitted: 0,
      coverageStatus: 'pending',
    }),
  );

  emitter.check('lake-history-matches-export', 'pending');
  emitter.node('lake', 'busy', 'creating tables and the load task');
  await setupLake(ctx.lake, config);
  if (config.reset) {
    await clearLakePrefix(config);
    await resetLakeStatements.reduce(async (previous, sql) => {
      await previous;
      await ctx.lake.query(sql);
    }, Promise.resolve());
  }
  emitter.node('s3-bucket', 'busy', 'exporting transactions as Parquet');
  const cutoff = await maxTxnId(pool);
  const exported = await runTransactionExport({
    config,
    database: ctx.database,
    batch: 1,
    afterTxnId: 0,
    upToTxnId: cutoff,
    log: (message) => emitter.log('info', message, 's3-bucket'),
  });
  emitter.flow('parquet-export', 1);
  rapid.truth.forEach((entry) => ctx.sinks.truth.emit(truthRow(entry)));
  await ctx.sinks.truth.flush();
  const expected = await transactionCountUpTo(pool, cutoff);
  const loaded = await timed(() =>
    awaitRowCount({
      lake: ctx.lake,
      countSql: countHistoryUpTo(cutoff),
      expected,
      timeoutMs: 8 * 60_000,
      pollMs: 5000,
      kickEveryMs: 45_000,
    }),
  );
  emitter.flow('lake-load', loaded.value.observed);
  emitter.metric('lake-load-seconds', loaded.value.seconds);
  emitter.check(
    'lake-history-matches-export',
    loaded.value.reached && loaded.value.observed === expected ? 'pass' : 'fail',
    `Lake ${loaded.value.observed} rows, Starter ${expected} rows up to txn_id ${cutoff} (export ${exported.exportId})`,
  );
  emitter.node('s3-bucket', 'healthy');
  emitter.node('lake', 'healthy');
  ctx.world.update((world) => ({ ...world, exportedUpToTxnId: cutoff }));
};
