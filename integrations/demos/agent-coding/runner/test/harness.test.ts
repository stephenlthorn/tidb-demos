import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAttemptScripts } from '../src/fixtureStore';
import { readTree, runAttempt, runTests, type StepOutcome } from '../src/harness';
import { pickWinner, scoreAttempt } from '../src/score';
import { changedPaths } from '../src/tree';

const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));
const baselineDir = join(fixturesDir, 'payments-api');

const withRepo = async <T>(task: (repoDir: string) => Promise<T>): Promise<T> => {
  const repoDir = await mkdtemp(join(tmpdir(), 'agent-coding-test-'));
  try {
    await cp(baselineDir, repoDir, { recursive: true });
    return await task(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
};

const scriptFor = async (attemptId: string) => {
  const script = (await loadAttemptScripts(fixturesDir)).find((candidate) => candidate.attemptId === attemptId);
  if (script === undefined) throw new Error(`no script for ${attemptId}`);
  return script;
};

const play = async (attemptId: string, injectedFault = false) => {
  const script = await scriptFor(attemptId);
  const baseline = await readTree(baselineDir);
  return withRepo(async (repoDir) => {
    const seen: StepOutcome[] = [];
    const outcomes = await runAttempt(script, { repoDir, fixturesDir, injectedFault }, async (outcome) => {
      seen.push(outcome);
    });
    const changed = changedPaths(baseline, await readTree(repoDir));
    return { outcomes, seen, changed };
  });
};

describe('the fixture repo', () => {
  it('fails exactly the two idempotency tests before any patch', async () => {
    await withRepo(async (repoDir) => {
      const result = await runTests({ repoDir, fault: undefined });
      expect(result.passed).toBe(false);
      expect(result.failing).toEqual([
        'a retried request returns the original charge id',
        'a retried request with the same idempotency key records one charge',
      ]);
      expect(result.passing).toBe(2);
    });
  });

  it('fails every test when the gateway resets the connection', async () => {
    await withRepo(async (repoDir) => {
      const result = await runTests({ repoDir, fault: 'econnreset' });
      expect(result.failing).toHaveLength(4);
      expect(result.signature).toBe('ECONNRESET');
    });
  });
});

describe('the scripted attempts', () => {
  it('attempt 1 passes in seven steps and changes two files', async () => {
    const { outcomes, changed } = await play('attempt-1');
    expect(outcomes).toHaveLength(7);
    expect(outcomes.at(-1)?.test?.passed).toBe(true);
    expect(changed).toEqual(['src/charge.js', 'src/idempotency.js']);
  });

  it('attempt 2 halts at step 7 with a gateway reset', async () => {
    const { outcomes, seen } = await play('attempt-2');
    const last = outcomes.at(-1);
    expect(last).toMatchObject({ step: 7, halted: true });
    expect(last?.test?.signature).toBe('ECONNRESET');
    expect(last?.test?.failing).toHaveLength(4);
    expect(seen).toHaveLength(7);
  });

  it('attempt 2 passes its step 5 verification before it breaks', async () => {
    const { outcomes } = await play('attempt-2');
    expect(outcomes[4]?.test?.passed).toBe(true);
  });

  it('attempt 3 passes in nine steps and changes four files', async () => {
    const { outcomes, changed } = await play('attempt-3');
    expect(outcomes).toHaveLength(9);
    expect(outcomes.at(-1)?.test?.passed).toBe(true);
    expect(changed).toEqual(['README.md', 'src/charge.js', 'src/ledger.js', 'src/retry.js']);
  });

  it('an injected fault halts attempt 1 at its first verification', async () => {
    const { outcomes } = await play('attempt-1', true);
    expect(outcomes.at(-1)).toMatchObject({ step: 5, halted: true });
  });

  it('attempt 1 wins on score and attempt 3 loses', async () => {
    const results = await Promise.all(
      ['attempt-1', 'attempt-2', 'attempt-3'].map(async (attemptId) => {
        const { outcomes, changed } = await play(attemptId);
        return {
          attemptId,
          passed: outcomes.at(-1)?.halted === false && outcomes.at(-1)?.test?.passed === true,
          changedFiles: changed.length,
          steps: outcomes.length,
        };
      }),
    );
    expect(results.map(scoreAttempt.bind(null))).toEqual([73, 0, 51]);
    expect(pickWinner(results)?.attemptId).toBe('attempt-1');
  });
});
