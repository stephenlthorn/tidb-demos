import type { Alert, GroundTruthEntry, PatternKind } from './domain';

export type Verdict = 'confirmed' | 'false-positive';

export type RuleVersion = { readonly ruleId: PatternKind; readonly version: string };

export type RuleScore = {
  readonly ruleId: PatternKind;
  readonly ruleVersion: string;
  readonly alerts: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly plantedAccounts: number;
  readonly flaggedPlanted: number;
  readonly precision: number | undefined;
  readonly recall: number | undefined;
  readonly falsePositivesPer1000: number | undefined;
};

export type PlantedCoverage = {
  readonly planted: number;
  readonly flagged: number;
  readonly missing: readonly string[];
  readonly recall: number | undefined;
};

const isPlantedFor = (truth: readonly GroundTruthEntry[], alert: Pick<Alert, 'ruleId' | 'accountId'>): boolean =>
  truth.some((entry) => entry.accountId === alert.accountId && entry.pattern === alert.ruleId);

export const simulateVerdict = (alert: Pick<Alert, 'ruleId' | 'accountId'>, truth: readonly GroundTruthEntry[]): Verdict =>
  isPlantedFor(truth, alert) ? 'confirmed' : 'false-positive';

const ratio = (numerator: number, denominator: number): number | undefined =>
  denominator === 0 ? undefined : numerator / denominator;

export const scoreRules = (options: {
  readonly rules: readonly RuleVersion[];
  readonly alerts: readonly Alert[];
  readonly groundTruth: readonly GroundTruthEntry[];
  readonly nonPlantedTransactionCount: number;
}): readonly RuleScore[] =>
  options.rules.map(({ ruleId, version }) => {
    const mine = options.alerts.filter((alert) => alert.ruleId === ruleId && alert.ruleVersion === version);
    const planted = options.groundTruth.filter((entry) => entry.pattern === ruleId);
    const flaggedAccounts = new Set(mine.map((alert) => alert.accountId));
    const flaggedPlanted = planted.filter((entry) => flaggedAccounts.has(entry.accountId)).length;
    const truePositives = mine.filter((alert) => isPlantedFor(options.groundTruth, alert)).length;
    const falsePositives = mine.length - truePositives;
    return {
      ruleId,
      ruleVersion: version,
      alerts: mine.length,
      truePositives,
      falsePositives,
      plantedAccounts: planted.length,
      flaggedPlanted,
      precision: ratio(truePositives, mine.length),
      recall: ratio(flaggedPlanted, planted.length),
      falsePositivesPer1000: ratio(falsePositives * 1000, options.nonPlantedTransactionCount),
    };
  });

export const plantedCoverage = (options: {
  readonly alerts: readonly Alert[];
  readonly groundTruth: readonly GroundTruthEntry[];
}): PlantedCoverage => {
  const missing = options.groundTruth
    .filter(
      (entry) =>
        !options.alerts.some((alert) => alert.accountId === entry.accountId && alert.ruleId === entry.pattern),
    )
    .map((entry) => entry.accountId);
  const planted = options.groundTruth.length;
  return { planted, flagged: planted - missing.length, missing, recall: ratio(planted - missing.length, planted) };
};
