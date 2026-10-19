import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { timed } from '@lab/runner-kit';
import type { Stage } from '../context';
import { isInjected, stepKey } from '../context';
import { replayVerdict } from '../checks';
import { readTree, runStep } from '../harness';
import { buildSnapshotSql, parseSnapshotRow } from '../snapshot';
import { withLayer, withMount, withoutMount } from '../state';
import { treeHash } from '../tree';

export const replayFailedStep = async ({ deps, memory }: Stage): Promise<void> => {
  const { config, emitter, tiFs } = deps;
  emitter.phase('replay-failed-step');
  emitter.check('replay-reproduces', 'pending');
  const target = memory.replayTarget;
  const attempt = memory.attempts.find((candidate) => candidate.script.attemptId === target?.attemptId);
  const original = target === undefined ? undefined : memory.stepEntries.get(stepKey(target.attemptId, target.haltedAtStep));
  const step = attempt?.script.steps.find((candidate) => candidate.step === target?.haltedAtStep);
  if (target === undefined || attempt === undefined || original === undefined || step === undefined || memory.replayBranch === undefined) {
    emitter.log('warn', 'no attempt failed, so there is nothing to replay', 'harness');
    emitter.check('replay-reproduces', 'fail', 'no attempt failed');
    return;
  }
  const checkpointId = `step-${String(target.haltedAtStep).padStart(2, '0')}`;
  emitter.node('filesystem', 'busy', `forking ${target.attemptId} from ${checkpointId}`);
  const { value: fork, ms: forkMs } = await timed(() =>
    tiFs.forkLayer({
      parentLayerRef: attempt.layerId,
      layerName: `replay-${target.attemptId}-${checkpointId}-${config.runId}`,
      checkpointId,
      actorId: 'replay',
    }),
  );
  emitter.metric('fork-layer-ms', forkMs);
  emitter.flow('layer-io', 1);
  memory.state = withLayer(memory.state, fork.layerId);
  const mountPath = join(config.workDir, 'replay');
  await mkdir(mountPath, { recursive: true });
  await tiFs.mountLayer({ mountPath, layerRef: fork.layerId, remotePath: '/workspace' });
  memory.state = withMount(memory.state, mountPath);
  await deps.saveState(memory.state);
  emitter.log('info', `replay layer ${fork.layerId} forked from ${target.attemptId}@${checkpointId} in ${Math.round(forkMs)} ms`, 'filesystem');

  emitter.node('fixture-db', 'busy', 'waiting for the replay branch');
  const branchInfo = await memory.replayBranch;
  const pool = deps.openBranchPool(branchInfo);
  try {
    const snapshot = parseSnapshotRow((await pool.rows(buildSnapshotSql(config.fixtureDatabase)))[0] ?? {});
    emitter.flow('branch-reads', 1);
    const repoDir = join(mountPath, 'payments-api');
    const hash = treeHash(await readTree(repoDir));
    const rerun = await runStep(attempt.script, step, {
      repoDir,
      fixturesDir: config.fixturesDir,
      run: deps.run,
      injectedFault: isInjected(memory, target.attemptId),
    });
    const verdict = replayVerdict({
      original,
      replay: {
        failing: rerun.test?.failing ?? [],
        signature: rerun.test?.signature,
        treeHash: hash,
        checksum: snapshot.checksum,
      },
    });
    memory.replayVerified = verdict.pass;
    emitter.check('replay-reproduces', verdict.pass ? 'pass' : 'fail', verdict.observed);
    emitter.log('info', `replayed ${target.attemptId} step ${target.haltedAtStep}: ${rerun.test?.failing.length ?? 0} failing tests, ${rerun.test?.signature ?? 'no signature'}`, 'harness');
    await tiFs.appendJournal({
      journalId: memory.journalId,
      entry: {
        type: 'step.replayed',
        status: verdict.pass ? 'ok' : 'failed',
        subjects: [`attempt:${target.attemptId}`],
        summary: { checkpointId, layerId: fork.layerId, observed: verdict.observed },
      },
      idempotencyKey: `${config.runId}-replay`,
    });
  } finally {
    await pool.end();
    await tiFs.unmount({ mountPath });
    memory.state = withoutMount(memory.state, mountPath);
    await deps.saveState(memory.state);
    emitter.node('filesystem', 'healthy');
    emitter.node('fixture-db', 'healthy');
  }
};
