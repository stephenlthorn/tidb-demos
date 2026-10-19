import { join } from 'node:path';
import type { Stage } from '../context';
import { pushWinnerBranch } from '../git';

export const verifyJournal = async ({ deps, memory }: Stage): Promise<void> => {
  const { emitter, tiFs } = deps;
  emitter.check('journal-verified', 'pending');
  const result = await tiFs.verifyJournal({ journalId: memory.journalId });
  emitter.check('journal-verified', result.ok ? 'pass' : 'fail', `hash chain of ${memory.journalId} ${result.ok ? 'verifies' : 'is broken'}`);
};

export const winnerPr = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { config, emitter, tiFs, run } = deps;
  emitter.phase('winner-pr');
  const winner = memory.winner;
  const attempt = memory.attempts.find((candidate) => candidate.script.attemptId === winner?.attemptId);
  if (winner === undefined || attempt === undefined) {
    emitter.log('warn', 'no attempt passed, so no pull request is opened', 'harness');
    await verifyJournal(stage);
    return;
  }
  const branch = `fix/${config.ticket.id}-${winner.attemptId}`;
  const pushed = await pushWinnerBranch({
    run,
    remoteDir: join(config.workDir, 'remote.git'),
    cloneDir: join(config.workDir, 'pr-clone'),
    baselineDir: join(config.fixturesDir, 'payments-api'),
    winnerDir: attempt.repoDir,
    branch,
    message: `${config.ticket.id}: ${config.ticket.title}`,
  });
  emitter.log(
    'info',
    `pushed ${branch} at ${pushed.commit.slice(0, 8)} touching ${pushed.files.join(', ')}; layer ${attempt.layerId} is left uncommitted`,
    'harness',
  );
  await tiFs.appendJournal({
    journalId: memory.journalId,
    entry: {
      type: 'pr.pushed',
      subjects: [`attempt:${winner.attemptId}`, `ticket:${config.ticket.id}`],
      summary: { branch, commit: pushed.commit, files: pushed.files },
    },
    idempotencyKey: `${config.runId}-pr`,
  });
  await verifyJournal(stage);
};
