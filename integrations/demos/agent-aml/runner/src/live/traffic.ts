import { evaluateRules } from '../rules';
import { DAY_MS } from '../time';
import { createRng, deriveSeed } from '../prng';
import { generateDay, plantStructuringRing, plantWatchlistNearMatch } from '../generator';
import { sharesToken } from '../names';
import { plantedCoverage, scoreRules } from '../scorer';
import { truthRow } from '../sinkRows';
import { alertsPerMinute } from '../tickMath';
import {
  awaitWatchlistEntry,
  execute,
  insertAlerts,
  insertPeople,
  insertTransactions,
  insertTruth,
  nonPlantedTransactionCount,
  readActiveRules,
  readAlerts,
  readTransactionsSince,
  readTruth,
  screenAccounts,
  serverNowMs,
} from '../starter';
import { watchlistInsert } from '../starterSql';
import type { Context } from './context';

const LOOKBACK_DAYS = 14;

const publishScores = async (ctx: Context): Promise<void> => {
  const { emitter, pool } = ctx;
  const [alerts, truth, nonPlanted, rules] = await Promise.all([
    readAlerts(pool),
    readTruth(pool),
    nonPlantedTransactionCount(pool),
    readActiveRules(pool),
  ]);
  const scores = scoreRules({
    rules: rules.map((rule) => ({ ruleId: rule.ruleId, version: rule.version })),
    alerts,
    groundTruth: truth,
    nonPlantedTransactionCount: nonPlanted,
  });
  emitter.metric(
    'false-positives-per-1000',
    scores.reduce((sum, score) => sum + (score.falsePositivesPer1000 ?? 0), 0),
  );
  const coverage = plantedCoverage({ alerts, groundTruth: truth });
  if (coverage.recall !== undefined) emitter.metric('planted-recall', coverage.recall * 100);
  const status = coverage.missing.length === 0 ? 'pass' : 'fail';
  if (ctx.world.get().coverageStatus === status) return;
  ctx.world.update((world) => ({ ...world, coverageStatus: status }));
  emitter.check(
    'every-planted-case-flagged',
    status,
    `${coverage.flagged} of ${coverage.planted} planted accounts flagged by their own rule${coverage.missing.length === 0 ? '' : `; missing ${coverage.missing.join(', ')}`}`,
  );
};

const evaluateAndStore = async (ctx: Context, asOfMs: number): Promise<number> => {
  const { emitter, pool } = ctx;
  const world = ctx.world.get();
  const [rules, window] = await Promise.all([
    readActiveRules(pool),
    readTransactionsSince(pool, asOfMs - LOOKBACK_DAYS * DAY_MS),
  ]);
  emitter.flow('window-scans', window.length);
  const alerts = evaluateRules({
    rules,
    accounts: world.accounts,
    transactions: window,
    asOfMs,
    watchlistCandidates: world.watchlistCandidates,
  });
  const created = await insertAlerts(pool, alerts);
  emitter.flow('alerts-written', created);
  emitter.flow('alerts-to-agent', created);
  if (created > 0) {
    const committedAtMs = await serverNowMs(pool);
    ctx.world.update((current) => ({ ...current, lastAlertCommitWallMs: committedAtMs }));
  }
  await publishScores(ctx);
  return created;
};

export const baselineTick = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config } = ctx;
  const world = ctx.world.get();
  const dayStartMs = world.lastDayStartMs + DAY_MS;
  const day = generateDay({
    rng: createRng(deriveSeed(config.seed, `day-${world.dayCounter + 1}`)),
    dayStartMs,
    dayIndex: world.dayCounter + 1,
    population: world.population,
    firstTxnId: world.nextTxnId,
    thresholdCents: config.thresholdCents,
  });
  const inserted = await insertTransactions(pool, day.transactions);
  ctx.world.update((current) => ({
    ...current,
    nextTxnId: day.nextTxnId,
    lastDayStartMs: dayStartMs,
    dayCounter: current.dayCounter + 1,
  }));
  emitter.flow('txn-writes', inserted);
  const created = await evaluateAndStore(ctx, dayStartMs + DAY_MS - 1);
  emitter.metric('alerts-per-minute', alertsPerMinute({ newAlerts: created, tickWallMs: config.tickMs }));
};

export const injectStructuringRing = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config } = ctx;
  const world = ctx.world.get();
  emitter.phase('inject-pattern');
  const ringNumber = world.ringCount + 1;
  const planted = plantStructuringRing({
    rng: createRng(deriveSeed(config.seed, `ring-${ringNumber}`)),
    lastDayStartMs: world.lastDayStartMs,
    firstTxnId: world.nextTxnId,
    firstAccountNumber: world.ringAccountCount + 1,
    ringSize: 3,
    thresholdCents: config.thresholdCents,
    branchCount: config.branchCount,
  });
  await insertPeople(pool, planted.accounts);
  const inserted = await insertTransactions(pool, planted.transactions);
  await insertTruth(pool, planted.truth);
  planted.truth.forEach((entry) => ctx.sinks.truth.emit(truthRow(entry)));
  await ctx.sinks.truth.flush();
  ctx.world.update((current) => ({
    ...current,
    accounts: [...current.accounts, ...planted.accounts],
    truth: [...current.truth, ...planted.truth],
    nextTxnId: planted.nextTxnId,
    ringCount: ringNumber,
    ringAccountCount: current.ringAccountCount + planted.accounts.length,
    coverageStatus: 'pending',
  }));
  emitter.flow('txn-writes', inserted);
  emitter.check('every-planted-case-flagged', 'pending');
  emitter.log('info', `planted a ${planted.accounts.length}-account structuring ring with ground truth`, 'txn-generator');
  emitter.phase('alert');
  const created = await evaluateAndStore(ctx, world.lastDayStartMs + DAY_MS - 1);
  emitter.log('info', `rule engine raised ${created} new alerts after the injection`, 'rule-engine');
};

export const injectWatchlistNearMatch = async (ctx: Context): Promise<void> => {
  const { emitter, pool, config, fixtures } = ctx;
  const world = ctx.world.get();
  emitter.phase('inject-pattern');
  const planted = plantWatchlistNearMatch({
    rng: createRng(deriveSeed(config.seed, `near-match-${world.nearMatchCount + 1}`)),
    accounts: world.accounts,
    firstEntryId: world.watchlistEntries + 1,
    injectedAtMs: world.lastDayStartMs,
    listTag: `${fixtures.watchlistTag}-UPDATE`,
  });
  await execute(pool, watchlistInsert([{ fullName: planted.entry.fullName, listTag: planted.entry.listTag }]));
  await insertTruth(pool, [planted.truth]);
  const visible = await awaitWatchlistEntry(pool, planted.entry.fullName);
  if (!visible) emitter.log('warn', 'the new watchlist entry is not visible to full-text search yet', 'harbor-core');
  ctx.sinks.truth.emit(truthRow(planted.truth));
  await ctx.sinks.truth.flush();
  const affected = world.accounts.filter((account) => sharesToken(account.holderName, planted.entry.fullName));
  const rescreened = await screenAccounts(pool, affected);
  ctx.world.update((current) => ({
    ...current,
    truth: [...current.truth, planted.truth],
    watchlistEntries: current.watchlistEntries + 1,
    watchlistCandidates: new Map([...current.watchlistCandidates, ...rescreened]),
    nearMatchCount: current.nearMatchCount + 1,
    coverageStatus: 'pending',
  }));
  emitter.check('every-planted-case-flagged', 'pending');
  emitter.log('info', 'a synthetic watchlist update arrived; rescreening accounts that share a name token', 'txn-generator');
  emitter.phase('alert');
  const created = await evaluateAndStore(ctx, world.lastDayStartMs + DAY_MS - 1);
  emitter.log('info', `rule engine raised ${created} new alerts after the list update`, 'rule-engine');
};
