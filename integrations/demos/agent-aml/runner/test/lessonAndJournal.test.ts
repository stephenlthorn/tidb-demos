import { describe, expect, it } from 'vitest';
import { formatCents, percentText } from '../src/format';
import {
  agentIdFor,
  branchNameFor,
  casePathFor,
  journalEntry,
  journalIdFor,
  layerNameFor,
} from '../src/journal';
import { composeLesson } from '../src/lesson';
import type { WhatIfResult } from '../src/whatIf';

const whatIf: WhatIfResult = {
  ruleId: 'structuring',
  baselineVersion: 'v1',
  candidateVersion: 'v2',
  baselineAlerts: 55,
  candidateAlerts: 3,
  alertDelta: -52,
  removedAccounts: [],
  addedAccounts: [],
  baseline: {
    ruleId: 'structuring',
    ruleVersion: 'v1',
    alerts: 55,
    truePositives: 3,
    falsePositives: 52,
    plantedAccounts: 3,
    flaggedPlanted: 3,
    precision: 3 / 55,
    recall: 1,
    falsePositivesPer1000: 5.1,
  },
  candidate: {
    ruleId: 'structuring',
    ruleVersion: 'v2',
    alerts: 3,
    truePositives: 3,
    falsePositives: 0,
    plantedAccounts: 3,
    flaggedPlanted: 3,
    precision: 1,
    recall: 1,
    falsePositivesPer1000: 0,
  },
  decision: 'adopt',
  reason: 'candidate keeps planted recall and raises fewer alerts',
};

describe('composeLesson', () => {
  const lesson = composeLesson({
    caseId: 'CASE-0001',
    pattern: 'structuring',
    whatIf,
    changeSummary: 'minDistinctBranches 1 -> 2',
  });

  it('records the numbers behind the lesson and says the verdicts were simulated', () => {
    expect(lesson.outcome).toBe('lesson');
    expect(lesson.summary).toContain('structuring v1 raised 55 alerts and 52 were false positives');
    expect(lesson.summary).toContain('structuring v2 (minDistinctBranches 1 -> 2) raised 3 alerts with planted recall 100.0%');
    expect(lesson.summary).toContain('Analyst verdicts were simulated from ground truth.');
  });

  it('uses the same words past structuring summaries use, so hybrid recall can find it', () => {
    expect(lesson.summary).toContain('repeated cash deposits just under the reporting threshold');
  });
});

describe('journal helpers', () => {
  it('derives stable names from the case id', () => {
    expect(casePathFor('CASE-0001')).toBe('/harbor/cases/CASE-0001');
    expect(layerNameFor('CASE-0001')).toBe('case-case-0001');
    expect(journalIdFor('CASE-0001')).toBe('jrn-case-0001');
    expect(branchNameFor('CASE-0001')).toBe('aml-case-0001');
    expect(agentIdFor('CASE-0001')).toBe('aml-agent-case-0001');
  });

  it('builds an entry with a retry-safe idempotency key', () => {
    expect(journalEntry({ caseId: 'CASE-0001', type: 'case.opened', summary: 'layer and branch ready' })).toEqual({
      type: 'case.opened',
      subjects: ['case:CASE-0001'],
      summary: 'layer and branch ready',
      idempotencyKey: 'CASE-0001:case.opened',
    });
  });

  it('rejects an entry type the journal would refuse', () => {
    expect(() => journalEntry({ caseId: 'CASE-0001', type: 'Case Opened', summary: 'x' })).toThrow(
      'invalid journal entry type',
    );
  });
});

describe('format', () => {
  it('formats cents as dollars with thousands separators', () => {
    expect(formatCents(2_850_000)).toBe('$28,500.00');
    expect(formatCents(5)).toBe('$0.05');
  });

  it('formats a missing ratio as n/a', () => {
    expect(percentText(undefined)).toBe('n/a');
    expect(percentText(0.055)).toBe('5.5%');
  });
});
