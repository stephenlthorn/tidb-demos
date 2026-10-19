import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';
import manifest from '../manifest.json';

describe('agent-aml demo manifest', () => {
  it('parses against DemoManifestSchema', () => {
    expect(DemoManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('is demo number 13 with id agent-aml', () => {
    const result = DemoManifestSchema.parse(manifest);
    expect(result.id).toBe('agent-aml');
    expect(result.number).toBe(13);
  });

  it('runs the runner through node --import tsx runner/main.ts', () => {
    expect(DemoManifestSchema.parse(manifest).runner.command).toEqual(['node', '--import', 'tsx', 'runner/main.ts']);
  });

  it('gives every metric a howMeasured explanation', () => {
    DemoManifestSchema.parse(manifest).metrics.forEach((metric) => expect(metric.howMeasured.length).toBeGreaterThan(20));
  });

  it('labels every metric that depends on simulated verdicts as simulated', () => {
    const verdictMetrics = DemoManifestSchema.parse(manifest).metrics.filter((metric) => metric.id.startsWith('precision-'));
    expect(verdictMetrics).toHaveLength(2);
    verdictMetrics.forEach((metric) => expect(metric.label).toContain('simulated'));
  });

  it('declares the five agreed controls and five agreed checks', () => {
    const parsed = DemoManifestSchema.parse(manifest);
    expect(parsed.controls.map((control) => control.id)).toEqual([
      'inject-structuring-ring',
      'inject-watchlist-near-match',
      'open-investigation',
      'test-rule-on-branch',
      'promote-skill',
    ]);
    expect(parsed.checks.map((check) => check.id)).toEqual([
      'every-planted-case-flagged',
      'investigation-branch-isolated',
      'journal-verifies',
      'skill-commit-lands-on-base',
      'lake-history-matches-export',
    ]);
  });

  it('walks the eleven agreed phases in order', () => {
    expect(DemoManifestSchema.parse(manifest).phases.map((phase) => phase.id)).toEqual([
      'setup',
      'baseline-traffic',
      'inject-pattern',
      'alert',
      'open-investigation',
      'recall-similar-cases',
      'test-rule-on-branch',
      'analyst-verdict',
      'lake-eval',
      'distill-commit-skill',
      'lesson-to-memory',
    ]);
  });
});
