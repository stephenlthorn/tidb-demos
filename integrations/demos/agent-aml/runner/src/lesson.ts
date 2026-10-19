import type { PatternKind } from './domain';
import { percentText } from './format';
import { patternPhrases } from './recallSql';
import type { WhatIfResult } from './whatIf';

export type Lesson = {
  readonly caseId: string;
  readonly pattern: PatternKind;
  readonly outcome: 'lesson';
  readonly summary: string;
};

export const composeLesson = (options: {
  readonly caseId: string;
  readonly pattern: PatternKind;
  readonly whatIf: WhatIfResult;
  readonly changeSummary: string;
}): Lesson => {
  const { whatIf } = options;
  const summary = [
    `Lesson from ${options.caseId} (${options.pattern}): ${patternPhrases[options.pattern]}.`,
    `${whatIf.ruleId} ${whatIf.baselineVersion} raised ${whatIf.baselineAlerts} alerts and ${whatIf.baseline.falsePositives} were false positives against planted ground truth.`,
    `${whatIf.ruleId} ${whatIf.candidateVersion} (${options.changeSummary}) raised ${whatIf.candidateAlerts} alerts with planted recall ${percentText(whatIf.candidate.recall)}.`,
    'Analyst verdicts were simulated from ground truth. Synthetic data.',
  ].join(' ');
  return { caseId: options.caseId, pattern: options.pattern, outcome: 'lesson', summary };
};
