import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { patternKinds } from '../src/domain';
import { PastCasesSchema, PlaybookSchema, skillFileFor, stepsFor, WatchlistFixtureSchema } from '../src/fixtures';
import { firstNames, lastNames } from '../src/generator';
import { tokenizeName } from '../src/names';
import { lintSkill } from '../src/skills';

const fixturePath = (name: string): string => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const readJson = (name: string): unknown => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

describe('watchlist fixture', () => {
  const watchlist = WatchlistFixtureSchema.parse(readJson('watchlist.json'));

  it('contains only invented names that share no token with the customer name pools', () => {
    const customerTokens = new Set([...firstNames, ...lastNames].flatMap(tokenizeName));
    watchlist.entries.flatMap(tokenizeName).forEach((token) => expect(customerTokens.has(token)).toBe(false));
  });

  it('has unique entries', () => {
    expect(new Set(watchlist.entries).size).toBe(watchlist.entries.length);
  });
});

describe('past cases fixture', () => {
  const cases = PastCasesSchema.parse(readJson('past-cases.json'));

  it('covers every pattern and marks all summaries as synthetic', () => {
    expect(new Set(cases.map((item) => item.pattern))).toEqual(new Set(patternKinds));
    cases.forEach((item) => expect(item.summary).toContain('Synthetic'));
  });

  it('uses unique case ids', () => {
    expect(new Set(cases.map((item) => item.caseId)).size).toBe(cases.length);
  });
});

describe('playbook fixture', () => {
  const playbook = PlaybookSchema.parse(readJson('playbook.json'));

  it('loads the working set first and writes evidence before any branch test', () => {
    patternKinds.forEach((pattern) => {
      const steps = stepsFor(pattern, playbook);
      expect(steps[0]).toBe('load-working-set');
      const branchIndex = steps.indexOf('test-rule-on-branch');
      if (branchIndex !== -1) expect(steps.indexOf('write-evidence')).toBeLessThan(branchIndex);
    });
  });
});

describe('skill fixtures', () => {
  it('has one lint-clean skill file per pattern', () => {
    const files = readdirSync(fixturePath('skills')).sort();
    expect(files).toEqual(patternKinds.map(skillFileFor).sort());
    files.forEach((file) => expect(lintSkill(readFileSync(fixturePath(`skills/${file}`), 'utf8'))).toEqual([]));
  });
});
