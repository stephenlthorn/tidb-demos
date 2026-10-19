import type { PatternKind } from './domain';
import { percentText } from './format';
import type { StructuringParams } from './rules';

export type SkillEvidence = {
  readonly ruleId: PatternKind;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly changeSummary: string;
  readonly baselineAlerts: number;
  readonly candidateAlerts: number;
  readonly baselinePrecision: number | undefined;
  readonly candidatePrecision: number | undefined;
  readonly candidateRecall: number | undefined;
};

export type DistilledSkill = {
  readonly text: string;
  readonly changed: boolean;
  readonly lintErrors: readonly string[];
};

const requiredSections: readonly string[] = ['Purpose', 'When to use', 'Steps', 'Learned'];

const structuringKeys: readonly (keyof StructuringParams)[] = [
  'thresholdCents',
  'bandPct',
  'windowDays',
  'minDeposits',
  'minDistinctBranches',
];

const PLACEHOLDER = '- No lessons recorded yet.';

export const describeRuleChange = (baseline: StructuringParams, candidate: StructuringParams): string => {
  const changes = structuringKeys
    .filter((key) => baseline[key] !== candidate[key])
    .map((key) => `${key} ${baseline[key]} -> ${candidate[key]}`);
  return changes.length === 0 ? 'no parameter change' : changes.join(', ');
};

const sectionRange = (lines: readonly string[], name: string): { start: number; end: number } | undefined => {
  const start = lines.findIndex((line) => line === `## ${name}`);
  if (start === -1) return undefined;
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return { start, end: next === -1 ? lines.length : next };
};

const sectionBody = (lines: readonly string[], name: string): readonly string[] => {
  const range = sectionRange(lines, name);
  if (range === undefined) return [];
  return lines.slice(range.start + 1, range.end).filter((line) => line.trim() !== '');
};

export const lintSkill = (text: string): readonly string[] => {
  const lines = text.split('\n');
  const errors: string[] = [];
  if (!/^# Skill: [a-z0-9]+(?:-[a-z0-9]+)*$/.test(lines[0] ?? '')) errors.push('first line must be "# Skill: <kebab-name>"');
  if (!/^Version: \d+$/.test(lines[1] ?? '')) errors.push('second line must be "Version: <integer>"');
  requiredSections.forEach((name) => {
    if (sectionRange(lines, name) === undefined) errors.push(`missing section: ${name}`);
  });
  const steps = sectionBody(lines, 'Steps');
  steps.forEach((line, index) => {
    if (!line.startsWith(`${index + 1}. `)) errors.push(`step ${index + 1} must be numbered consecutively`);
  });
  if (steps.length === 0 && sectionRange(lines, 'Steps') !== undefined) errors.push('Steps must not be empty');
  const learned = sectionBody(lines, 'Learned');
  learned.forEach((line) => {
    if (!line.startsWith('- ')) errors.push('Learned entries must be bullets');
  });
  if (learned.length === 0 && sectionRange(lines, 'Learned') !== undefined) errors.push('Learned must not be empty');
  return errors;
};

const learnedBullet = (evidence: SkillEvidence): string =>
  `- ${evidence.ruleId} ${evidence.candidateVersion} (${evidence.changeSummary}): alerts ${evidence.baselineAlerts} -> ${evidence.candidateAlerts}, precision ${percentText(evidence.baselinePrecision)} -> ${percentText(evidence.candidatePrecision)} on simulated analyst verdicts, planted recall ${percentText(evidence.candidateRecall)}.`;

const stepText = (evidence: SkillEvidence): string =>
  `Apply ${evidence.ruleId} ${evidence.candidateVersion} (${evidence.changeSummary}) before escalating, because it cut alert volume while planted recall held.`;

const replaceSection = (lines: readonly string[], name: string, body: readonly string[]): readonly string[] => {
  const range = sectionRange(lines, name);
  if (range === undefined) return lines;
  return [...lines.slice(0, range.start + 1), '', ...body, '', ...lines.slice(range.end)];
};

const bumpVersion = (lines: readonly string[]): readonly string[] =>
  lines.map((line) => {
    const match = /^Version: (\d+)$/.exec(line);
    return match === null ? line : `Version: ${Number(match[1]) + 1}`;
  });

export const distillSkill = (options: { readonly skillText: string; readonly evidence: SkillEvidence }): DistilledSkill => {
  const { skillText, evidence } = options;
  const lines = skillText.replace(/\n+$/, '').split('\n');
  const bulletPrefix = `- ${evidence.ruleId} ${evidence.candidateVersion} (`;
  const learned = sectionBody(lines, 'Learned')
    .filter((line) => line !== PLACEHOLDER)
    .filter((line) => !line.startsWith(bulletPrefix));
  const steps = sectionBody(lines, 'Steps');
  const hasStep = steps.some((line) => line.includes(`Apply ${evidence.ruleId} ${evidence.candidateVersion} (`));
  const nextSteps = hasStep
    ? steps.map((line, index) =>
        line.includes(`Apply ${evidence.ruleId} ${evidence.candidateVersion} (`)
          ? `${index + 1}. ${stepText(evidence)}`
          : line,
      )
    : [...steps, `${steps.length + 1}. ${stepText(evidence)}`];
  const withSteps = replaceSection(lines, 'Steps', nextSteps);
  const withLearned = replaceSection(withSteps, 'Learned', [...learned, learnedBullet(evidence)]);
  const render = (rendered: readonly string[]): string => `${rendered.join('\n').replace(/\n+$/, '')}\n`;
  const candidateText = render(withLearned);
  const changed = candidateText !== render(lines);
  const text = changed ? render(bumpVersion(withLearned)) : candidateText;
  return { text, changed, lintErrors: lintSkill(text) };
};
