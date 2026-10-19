import { describe, expect, it } from 'vitest';
import type { Alert, GroundTruthEntry } from '../src/domain';
import { compareRuleVersions, evaluateIsolation } from '../src/whatIf';

const anAlert = (accountId: string, ruleVersion: string): Alert => ({
  ruleId: 'structuring',
  ruleVersion,
  accountId,
  windowStartMs: 0,
  windowEndMs: 0,
  raisedAtMs: 0,
  bucket: 0,
  txnIds: [],
  score: 3,
});

const truth: readonly GroundTruthEntry[] = [
  { accountId: 'RNG-1', pattern: 'structuring', injectedAtMs: 0 },
  { accountId: 'RNG-2', pattern: 'structuring', injectedAtMs: 0 },
];

const compare = (alerts: readonly Alert[]) =>
  compareRuleVersions({
    ruleId: 'structuring',
    baselineVersion: 'v1',
    candidateVersion: 'v2',
    alerts,
    groundTruth: truth,
    nonPlantedTransactionCount: 4000,
  });

describe('compareRuleVersions', () => {
  it('adopts a candidate that keeps recall and cuts alert volume', () => {
    const result = compare([
      anAlert('RNG-1', 'v1'),
      anAlert('RNG-2', 'v1'),
      anAlert('ACC-5', 'v1'),
      anAlert('ACC-6', 'v1'),
      anAlert('RNG-1', 'v2'),
      anAlert('RNG-2', 'v2'),
    ]);
    expect(result).toMatchObject({
      baselineAlerts: 4,
      candidateAlerts: 2,
      alertDelta: -2,
      removedAccounts: ['ACC-5', 'ACC-6'],
      addedAccounts: [],
      decision: 'adopt',
    });
    expect(result.baseline.falsePositivesPer1000).toBe(0.5);
    expect(result.candidate.falsePositivesPer1000).toBe(0);
  });

  it('rejects a candidate that loses a planted account', () => {
    const result = compare([anAlert('RNG-1', 'v1'), anAlert('RNG-2', 'v1'), anAlert('RNG-1', 'v2')]);
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('candidate loses planted recall');
  });

  it('rejects a candidate that does not reduce volume', () => {
    const result = compare([anAlert('RNG-1', 'v1'), anAlert('RNG-2', 'v1'), anAlert('RNG-1', 'v2'), anAlert('RNG-2', 'v2')]);
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('candidate does not reduce alert volume');
  });
});

describe('evaluateIsolation', () => {
  it('passes when only the branch holds the candidate rule and its alerts', () => {
    const result = evaluateIsolation({
      production: { v2Rules: 0, v2Alerts: 0 },
      branch: { v2Rules: 1, v2Alerts: 5 },
    });
    expect(result.isolated).toBe(true);
    expect(result.observed).toBe('branch has 1 v2 rule and 5 v2 alerts; production has 0 and 0');
  });

  it('fails when production shows any candidate rows', () => {
    expect(
      evaluateIsolation({ production: { v2Rules: 1, v2Alerts: 0 }, branch: { v2Rules: 1, v2Alerts: 5 } }).isolated,
    ).toBe(false);
  });

  it('fails when the branch write never happened, so the probe proves nothing', () => {
    expect(
      evaluateIsolation({ production: { v2Rules: 0, v2Alerts: 0 }, branch: { v2Rules: 0, v2Alerts: 0 } }).isolated,
    ).toBe(false);
  });
});
