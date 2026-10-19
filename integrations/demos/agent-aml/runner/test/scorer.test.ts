import { describe, expect, it } from 'vitest';
import type { Alert, GroundTruthEntry } from '../src/domain';
import { plantedCoverage, scoreRules, simulateVerdict } from '../src/scorer';

const anAlert = (overrides: Partial<Alert> = {}): Alert => ({
  ruleId: 'structuring',
  ruleVersion: 'v1',
  accountId: 'ACC-1',
  windowStartMs: 0,
  windowEndMs: 0,
  raisedAtMs: 0,
  bucket: 0,
  txnIds: [],
  score: 3,
  ...overrides,
});

const truth: readonly GroundTruthEntry[] = [
  { accountId: 'RNG-1', pattern: 'structuring', injectedAtMs: 0 },
  { accountId: 'RNG-2', pattern: 'structuring', injectedAtMs: 0 },
  { accountId: 'PAS-1', pattern: 'rapid-in-out', injectedAtMs: 0 },
];

describe('simulateVerdict', () => {
  it('confirms an alert on a planted account for the same pattern', () => {
    expect(simulateVerdict(anAlert({ accountId: 'RNG-1' }), truth)).toBe('confirmed');
  });

  it('marks an alert on an unplanted account as a false positive', () => {
    expect(simulateVerdict(anAlert({ accountId: 'ACC-9' }), truth)).toBe('false-positive');
  });

  it('marks an alert on a planted account but for another pattern as a false positive', () => {
    expect(simulateVerdict(anAlert({ accountId: 'PAS-1' }), truth)).toBe('false-positive');
  });
});

describe('scoreRules', () => {
  const alerts = [
    anAlert({ accountId: 'RNG-1' }),
    anAlert({ accountId: 'RNG-2' }),
    anAlert({ accountId: 'ACC-8' }),
    anAlert({ accountId: 'ACC-9' }),
    anAlert({ accountId: 'RNG-1', ruleVersion: 'v2' }),
    anAlert({ accountId: 'RNG-2', ruleVersion: 'v2' }),
  ];
  const scores = scoreRules({
    rules: [
      { ruleId: 'structuring', version: 'v1' },
      { ruleId: 'structuring', version: 'v2' },
      { ruleId: 'rapid-in-out', version: 'v1' },
    ],
    alerts,
    groundTruth: truth,
    nonPlantedTransactionCount: 2000,
  });

  it('computes precision, recall and false positives per 1,000 for v1', () => {
    expect(scores[0]).toMatchObject({
      alerts: 4,
      truePositives: 2,
      falsePositives: 2,
      precision: 0.5,
      recall: 1,
      falsePositivesPer1000: 1,
    });
  });

  it('shows the v2 candidate keeping recall while dropping false positives', () => {
    expect(scores[1]).toMatchObject({ alerts: 2, falsePositives: 0, precision: 1, recall: 1, falsePositivesPer1000: 0 });
  });

  it('reports recall 0 and no precision for a rule that raised nothing', () => {
    expect(scores[2]).toMatchObject({ alerts: 0, recall: 0, precision: undefined });
  });
});

describe('plantedCoverage', () => {
  it('lists planted accounts with no alert from their own rule', () => {
    const coverage = plantedCoverage({
      alerts: [anAlert({ accountId: 'RNG-1' }), anAlert({ accountId: 'PAS-1' })],
      groundTruth: truth,
    });
    expect(coverage).toEqual({ planted: 3, flagged: 1, missing: ['RNG-2', 'PAS-1'], recall: 1 / 3 });
  });

  it('has no recall when nothing is planted', () => {
    expect(plantedCoverage({ alerts: [], groundTruth: [] }).recall).toBeUndefined();
  });
});
