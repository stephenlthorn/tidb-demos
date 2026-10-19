import type { Alert, GroundTruthEntry, PatternKind } from './domain';
import { scoreRules, type RuleScore } from './scorer';

export type WhatIfDecision = 'adopt' | 'reject';

export type WhatIfResult = {
  readonly ruleId: PatternKind;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly baselineAlerts: number;
  readonly candidateAlerts: number;
  readonly alertDelta: number;
  readonly removedAccounts: readonly string[];
  readonly addedAccounts: readonly string[];
  readonly baseline: RuleScore;
  readonly candidate: RuleScore;
  readonly decision: WhatIfDecision;
  readonly reason: string;
};

const accountsOf = (alerts: readonly Alert[]): ReadonlySet<string> => new Set(alerts.map((alert) => alert.accountId));

export const compareRuleVersions = (options: {
  readonly ruleId: PatternKind;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly alerts: readonly Alert[];
  readonly groundTruth: readonly GroundTruthEntry[];
  readonly nonPlantedTransactionCount: number;
}): WhatIfResult => {
  const { ruleId, baselineVersion, candidateVersion, alerts, groundTruth, nonPlantedTransactionCount } = options;
  const [baseline, candidate] = scoreRules({
    rules: [
      { ruleId, version: baselineVersion },
      { ruleId, version: candidateVersion },
    ],
    alerts,
    groundTruth,
    nonPlantedTransactionCount,
  });
  if (baseline === undefined || candidate === undefined) throw new Error('scoreRules returned fewer scores than rules');
  const baselineAccounts = accountsOf(alerts.filter((a) => a.ruleId === ruleId && a.ruleVersion === baselineVersion));
  const candidateAccounts = accountsOf(alerts.filter((a) => a.ruleId === ruleId && a.ruleVersion === candidateVersion));
  const recallHeld = (candidate.recall ?? 0) >= (baseline.recall ?? 0);
  const quieter = candidate.alerts < baseline.alerts;
  const decision: WhatIfDecision = recallHeld && quieter ? 'adopt' : 'reject';
  const reason = !recallHeld
    ? 'candidate loses planted recall'
    : quieter
      ? 'candidate keeps planted recall and raises fewer alerts'
      : 'candidate does not reduce alert volume';
  return {
    ruleId,
    baselineVersion,
    candidateVersion,
    baselineAlerts: baseline.alerts,
    candidateAlerts: candidate.alerts,
    alertDelta: candidate.alerts - baseline.alerts,
    removedAccounts: [...baselineAccounts].filter((id) => !candidateAccounts.has(id)),
    addedAccounts: [...candidateAccounts].filter((id) => !baselineAccounts.has(id)),
    baseline,
    candidate,
    decision,
    reason,
  };
};

export type IsolationProbe = { readonly v2Rules: number; readonly v2Alerts: number };

export const evaluateIsolation = (options: {
  readonly production: IsolationProbe;
  readonly branch: IsolationProbe;
}): { readonly isolated: boolean; readonly observed: string } => {
  const { production, branch } = options;
  const productionClean = production.v2Rules === 0 && production.v2Alerts === 0;
  const branchWritten = branch.v2Rules > 0 && branch.v2Alerts > 0;
  return {
    isolated: productionClean && branchWritten,
    observed: `branch has ${branch.v2Rules} v2 rule and ${branch.v2Alerts} v2 alerts; production has ${production.v2Rules} and ${production.v2Alerts}`,
  };
};
