import { describe, expect, it } from 'vitest';
import { REPORTING_THRESHOLD_CENTS, type Account, type GroundTruthEntry, type Transaction } from '../src/domain';
import {
  buildPopulation,
  generateHistory,
  plantRapidInOut,
  plantStructuringRing,
} from '../src/generator';
import { createRng } from '../src/prng';
import { baselineRules, candidateStructuring, replayHistory } from '../src/rules';
import { plantedCoverage, scoreRules } from '../src/scorer';
import { compareRuleVersions } from '../src/whatIf';
import { DAY_MS } from '../src/time';

const day0 = Date.UTC(2026, 0, 5);
const historyDays = 90;

const buildWorld = () => {
  const population = buildPopulation({
    rng: createRng(20261016),
    retailCount: 240,
    businessCount: 40,
    lookAlikeCount: 4,
    branchCount: 12,
  });
  const history = generateHistory({
    rng: createRng(42),
    population,
    days: historyDays,
    firstDayStartMs: day0,
    firstTxnId: 1,
    thresholdCents: REPORTING_THRESHOLD_CENTS,
  });
  const rapid = plantRapidInOut({
    rng: createRng(43),
    dayStartMs: day0 + 70 * DAY_MS,
    firstTxnId: history.nextTxnId,
    accountNumber: 1,
    branchCount: 12,
  });
  const lastDayStartMs = day0 + (historyDays + 3) * DAY_MS;
  const ring = plantStructuringRing({
    rng: createRng(44),
    lastDayStartMs,
    firstTxnId: rapid.nextTxnId,
    firstAccountNumber: 1,
    ringSize: 3,
    thresholdCents: REPORTING_THRESHOLD_CENTS,
    branchCount: 12,
  });
  const accounts: readonly Account[] = [...population.accounts, ...rapid.accounts, ...ring.accounts];
  const transactions: readonly Transaction[] = [...history.transactions, ...rapid.transactions, ...ring.transactions];
  const groundTruth: readonly GroundTruthEntry[] = [...rapid.truth, ...ring.truth];
  return { accounts, transactions, groundTruth, lastDayStartMs };
};

describe('seeded scenario end to end', () => {
  const world = buildWorld();
  const plantedAccountIds = new Set(world.groundTruth.map((entry) => entry.accountId));
  const nonPlantedTransactionCount = world.transactions.filter((txn) => !plantedAccountIds.has(txn.accountId)).length;
  const replay = (rules: ReturnType<typeof baselineRules>) =>
    replayHistory({
      rules,
      accounts: world.accounts,
      transactions: world.transactions,
      watchlistCandidates: new Map(),
      firstDayStartMs: day0,
      lastDayStartMs: world.lastDayStartMs,
      lookbackDays: 14,
    });
  const v1Alerts = replay(baselineRules(REPORTING_THRESHOLD_CENTS));
  const v2Alerts = replay([candidateStructuring(REPORTING_THRESHOLD_CENTS)]);
  const alerts = [...v1Alerts, ...v2Alerts];

  it('flags every planted case under the baseline rules', () => {
    const coverage = plantedCoverage({ alerts: v1Alerts, groundTruth: world.groundTruth });
    expect(coverage.missing).toEqual([]);
    expect(coverage.recall).toBe(1);
  });

  it('raises false positives on look-alike businesses under v1', () => {
    const [structuringV1] = scoreRules({
      rules: [{ ruleId: 'structuring', version: 'v1' }],
      alerts,
      groundTruth: world.groundTruth,
      nonPlantedTransactionCount,
    });
    expect(structuringV1?.falsePositives).toBeGreaterThan(10);
    expect(structuringV1?.recall).toBe(1);
  });

  it('shows v2 keeping recall with no false positives', () => {
    const result = compareRuleVersions({
      ruleId: 'structuring',
      baselineVersion: 'v1',
      candidateVersion: 'v2',
      alerts,
      groundTruth: world.groundTruth,
      nonPlantedTransactionCount,
    });
    expect(result.decision).toBe('adopt');
    expect(result.candidate.falsePositives).toBe(0);
    expect(result.candidate.recall).toBe(1);
    expect(result.alertDelta).toBeLessThan(-10);
  });
});
