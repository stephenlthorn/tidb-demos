import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadAttemptScripts } from '../src/fixtureStore';
import { parseAttemptScript, pathOwners, writtenPaths } from '../src/scripts';

const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));

describe('parseAttemptScript', () => {
  it('rejects steps that are out of order', () => {
    expect(() =>
      parseAttemptScript({
        attemptId: 'attempt-9',
        model: 'fixture-model-a',
        stepCostUsd: 0.01,
        steps: [
          { step: 1, kind: 'read', note: 'a' },
          { step: 3, kind: 'read', note: 'b' },
        ],
      }),
    ).toThrow('step 3 is out of order');
  });

  it('rejects an unknown step kind', () => {
    expect(() =>
      parseAttemptScript({
        attemptId: 'attempt-9',
        model: 'm',
        stepCostUsd: 0,
        steps: [{ step: 1, kind: 'think', note: 'a' }],
      }),
    ).toThrow();
  });
});

describe('fixture attempt scripts', () => {
  it('loads three attempts in order', async () => {
    const scripts = await loadAttemptScripts(fixturesDir);
    expect(scripts.map((script) => script.attemptId)).toEqual(['attempt-1', 'attempt-2', 'attempt-3']);
  });

  it('has an attempt that fails at step 7', async () => {
    const scripts = await loadAttemptScripts(fixturesDir);
    const second = scripts.find((script) => script.attemptId === 'attempt-2');
    expect(second?.steps).toHaveLength(7);
    expect(second?.steps[6]).toMatchObject({ kind: 'verify', fault: 'econnreset' });
  });

  it('lists the files each attempt writes', async () => {
    const scripts = await loadAttemptScripts(fixturesDir);
    expect(scripts.map(writtenPaths)).toEqual([
      ['src/idempotency.js', 'src/charge.js'],
      ['src/charge.js', 'src/gateway.js'],
      ['src/ledger.js', 'src/retry.js', 'src/charge.js', 'README.md'],
    ]);
  });

  it('finds the files that only one attempt writes', async () => {
    const scripts = await loadAttemptScripts(fixturesDir);
    expect(pathOwners(scripts)).toEqual({
      'src/idempotency.js': 'attempt-1',
      'src/gateway.js': 'attempt-2',
      'src/ledger.js': 'attempt-3',
      'src/retry.js': 'attempt-3',
      'README.md': 'attempt-3',
    });
  });
});
