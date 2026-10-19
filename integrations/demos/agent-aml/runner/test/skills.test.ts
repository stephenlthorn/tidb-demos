import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baselineRules, candidateStructuring } from '../src/rules';
import { describeRuleChange, distillSkill, lintSkill, type SkillEvidence } from '../src/skills';

const skillPath = fileURLToPath(new URL('../../fixtures/skills/structuring-triage.md', import.meta.url));
const seedSkill = readFileSync(skillPath, 'utf8');

const evidence: SkillEvidence = {
  ruleId: 'structuring',
  baselineVersion: 'v1',
  candidateVersion: 'v2',
  changeSummary: 'minDistinctBranches 1 -> 2',
  baselineAlerts: 55,
  candidateAlerts: 3,
  baselinePrecision: 3 / 55,
  candidatePrecision: 1,
  candidateRecall: 1,
};

describe('describeRuleChange', () => {
  it('lists only the parameters that differ', () => {
    const baseline = baselineRules(1_000_000)[0];
    const candidate = candidateStructuring(1_000_000);
    if (baseline?.ruleId !== 'structuring' || candidate.ruleId !== 'structuring') throw new Error('unexpected rule');
    expect(describeRuleChange(baseline.params, candidate.params)).toBe('minDistinctBranches 1 -> 2');
  });
});

describe('lintSkill', () => {
  it('accepts the seed skill fixture', () => {
    expect(lintSkill(seedSkill)).toEqual([]);
  });

  it('reports a missing section and a badly numbered step', () => {
    const broken = seedSkill.replace('## Learned', '## Notes').replace('2. Count', '7. Count');
    expect(lintSkill(broken)).toEqual(['missing section: Learned', 'step 2 must be numbered consecutively']);
  });

  it('reports a missing version line', () => {
    expect(lintSkill(seedSkill.replace('Version: 1', 'Rev 1'))).toContain('second line must be "Version: <integer>"');
  });
});

describe('distillSkill', () => {
  const distilled = distillSkill({ skillText: seedSkill, evidence });

  it('adds a numbered step and a learned bullet, drops the placeholder and bumps the version', () => {
    expect(distilled.changed).toBe(true);
    expect(distilled.text).toContain('Version: 2');
    expect(distilled.text).toContain(
      '6. Apply structuring v2 (minDistinctBranches 1 -> 2) before escalating, because it cut alert volume while planted recall held.',
    );
    expect(distilled.text).toContain(
      '- structuring v2 (minDistinctBranches 1 -> 2): alerts 55 -> 3, precision 5.5% -> 100.0% on simulated analyst verdicts, planted recall 100.0%.',
    );
    expect(distilled.text).not.toContain('No lessons recorded yet');
  });

  it('produces a skill that passes lint', () => {
    expect(distilled.lintErrors).toEqual([]);
  });

  it('is idempotent: distilling the same evidence again changes nothing', () => {
    const again = distillSkill({ skillText: distilled.text, evidence });
    expect(again.changed).toBe(false);
    expect(again.text).toBe(distilled.text);
  });

  it('refreshes the bullet in place when the evidence numbers change', () => {
    const refreshed = distillSkill({ skillText: distilled.text, evidence: { ...evidence, candidateAlerts: 4 } });
    expect(refreshed.changed).toBe(true);
    expect(refreshed.text.match(/- structuring v2 \(/g)).toHaveLength(1);
    expect(refreshed.text).toContain('alerts 55 -> 4');
  });
});
