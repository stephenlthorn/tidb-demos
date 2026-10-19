import { mkdir } from 'node:fs/promises';
import { timed } from '@lab/runner-kit';
import { injectedFaultTarget, type AttemptRuntime, type Stage } from '../context';
import { snapshotsVerdict } from '../checks';
import { buildSnapshotSql, parseSnapshotRow, type BranchSnapshot } from '../snapshot';
import { withLayer, withMount } from '../state';

const firstRow = <T>(rows: readonly T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error('query returned no rows');
  return row;
};

const forkAndMount = async ({ deps, memory }: Stage, attempt: AttemptRuntime): Promise<void> => {
  const { config, emitter, tiFs } = deps;
  const { value, ms } = await timed(() =>
    tiFs.forkLayer({
      parentLayerRef: memory.taskLayerId,
      layerName: `${attempt.script.attemptId}-${config.runId}`,
      checkpointId: 'seed',
      actorId: attempt.script.attemptId,
    }),
  );
  attempt.layerId = value.layerId;
  memory.state = withLayer(memory.state, value.layerId);
  emitter.metric('fork-layer-ms', ms);
  emitter.flow('layer-io', 1);
  await mkdir(attempt.mountPath, { recursive: true });
  await tiFs.mountLayer({ mountPath: attempt.mountPath, layerRef: value.layerId, remotePath: '/workspace' });
  memory.state = withMount(memory.state, attempt.mountPath);
  await deps.saveState(memory.state);
  emitter.log('info', `${attempt.script.attemptId}: layer ${value.layerId} forked from seed in ${Math.round(ms)} ms`, 'filesystem');
};

const snapshotOf = async (stage: Stage, attempt: AttemptRuntime): Promise<readonly [string, BranchSnapshot]> => {
  const { deps } = stage;
  const info = await attempt.branchReady;
  if (info === undefined) throw new Error(`${attempt.script.attemptId} has no branch`);
  attempt.pool = deps.openBranchPool(info);
  const snapshot = parseSnapshotRow(firstRow(await attempt.pool.rows(buildSnapshotSql(deps.config.fixtureDatabase))));
  deps.emitter.flow('branch-reads', 1);
  return [attempt.script.attemptId, snapshot];
};

export const fanOut = async (stage: Stage): Promise<void> => {
  const { deps, memory } = stage;
  const { emitter } = deps;
  emitter.phase('fan-out');
  emitter.check('fork-branches-identical', 'pending');
  if (memory.injectFault) emitter.log('warn', `flaky dependency armed: ${injectedFaultTarget} will hit a gateway reset at its first verification`, 'harness');
  emitter.node('filesystem', 'busy', `forking ${memory.attempts.length} attempt layers`);
  await Promise.all(memory.attempts.map((attempt) => forkAndMount(stage, attempt)));
  emitter.node('filesystem', 'healthy', 'attempt layers mounted');
  emitter.node('fixture-db', 'busy', 'waiting for attempt branches');
  const snapshots = await Promise.all(memory.attempts.map((attempt) => snapshotOf(stage, attempt)));
  emitter.node('fixture-db', 'healthy', `${snapshots.length} branches ACTIVE`);
  const verdict = snapshotsVerdict(Object.fromEntries(snapshots));
  emitter.check('fork-branches-identical', verdict.pass ? 'pass' : 'fail', verdict.observed);
};
