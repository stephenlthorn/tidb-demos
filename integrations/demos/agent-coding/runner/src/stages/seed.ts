import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stage } from '../context';
import { readTree } from '../harness';
import { withMount, withoutMount } from '../state';

export const seedCheckpoint = async ({ deps, memory }: Stage): Promise<void> => {
  const { config, emitter, tiFs } = deps;
  emitter.phase('seed-checkpoint');
  const mountPath = join(config.workDir, 'task');
  const baselineDir = join(config.fixturesDir, 'payments-api');
  await mkdir(mountPath, { recursive: true });
  await tiFs.mountLayer({ mountPath, layerRef: memory.taskLayerId, remotePath: '/workspace' });
  memory.state = withMount(memory.state, mountPath);
  await deps.saveState(memory.state);
  emitter.node('filesystem', 'busy', 'seeding the task layer');
  await cp(baselineDir, join(mountPath, 'payments-api'), { recursive: true });
  memory.baselineTree = await readTree(baselineDir);
  emitter.flow('seed-repo', Object.keys(memory.baselineTree).length);
  const checkpoint = await tiFs.checkpoint({
    layerId: memory.taskLayerId,
    mountPath,
    checkpointId: 'seed',
    label: `${config.ticket.id} seed`,
  });
  emitter.metric('checkpoint-ms', checkpoint.drainMs + checkpoint.checkpointMs);
  emitter.flow('layer-io', 2);
  emitter.log('info', `checkpoint ${checkpoint.checkpointId}: drain ${Math.round(checkpoint.drainMs)} ms, checkpoint ${Math.round(checkpoint.checkpointMs)} ms`, 'filesystem');
  await tiFs.unmount({ mountPath });
  memory.state = withoutMount(memory.state, mountPath);
  await deps.saveState(memory.state);
  emitter.node('filesystem', 'healthy', 'seed checkpoint recorded');
};
