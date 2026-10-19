import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '@lab/agent-stack-kit';
import { loadAttemptScripts } from '../src/fixtureStore';
import { pushWinnerBranch, remoteBranchExists } from '../src/git';
import { runAttempt } from '../src/harness';

const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));
const baselineDir = join(fixturesDir, 'payments-api');

describe('pushWinnerBranch', () => {
  it('pushes the winning attempt as a branch of a local bare repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-coding-git-'));
    try {
      const winnerDir = join(root, 'attempt-1');
      await cp(baselineDir, winnerDir, { recursive: true });
      const script = (await loadAttemptScripts(fixturesDir)).find((candidate) => candidate.attemptId === 'attempt-1');
      if (script === undefined) throw new Error('missing attempt-1');
      await runAttempt(script, { repoDir: winnerDir, fixturesDir }, async () => undefined);

      const remoteDir = join(root, 'remote.git');
      const result = await pushWinnerBranch({
        run: runCli,
        remoteDir,
        cloneDir: join(root, 'clone'),
        baselineDir,
        winnerDir,
        branch: 'fix/KIT-8812-attempt-1',
        message: 'KIT-8812: fix double charge on retried payments',
      });

      expect(result.files).toEqual(['src/charge.js', 'src/idempotency.js']);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(await remoteBranchExists(runCli, remoteDir, 'fix/KIT-8812-attempt-1')).toBe(true);
      expect(await remoteBranchExists(runCli, remoteDir, 'fix/never-pushed')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
