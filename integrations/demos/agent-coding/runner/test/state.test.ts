import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyState, withBranch, withJournal, withLayer, withMount, withoutMount } from '../src/state';
import { readState, writeState } from '../src/stateStore';

describe('run state', () => {
  it('records layers, mounts, branches and the journal without mutating the original', () => {
    const start = emptyState('run-1');
    const next = withJournal(
      withBranch(withMount(withLayer(start, 'lyr_1'), '/mnt/a'), { clusterId: 'c1', branchId: 'br_1' }),
      'jrn-1',
    );
    expect(start).toEqual({ runId: 'run-1', layers: [], mounts: [], branches: [] });
    expect(next).toEqual({
      runId: 'run-1',
      layers: ['lyr_1'],
      mounts: ['/mnt/a'],
      branches: [{ clusterId: 'c1', branchId: 'br_1' }],
      journalId: 'jrn-1',
    });
  });

  it('does not list a mount twice and can drop one', () => {
    const mounted = withMount(withMount(emptyState('r'), '/mnt/a'), '/mnt/a');
    expect(mounted.mounts).toEqual(['/mnt/a']);
    expect(withoutMount(mounted, '/mnt/a').mounts).toEqual([]);
  });
});

describe('state store', () => {
  it('round-trips a state file and reports a missing file as undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-coding-state-'));
    try {
      const path = join(dir, 'nested', 'state.json');
      expect(await readState(path)).toBeUndefined();
      const state = withLayer(emptyState('run-1'), 'lyr_1');
      await writeState(path, state);
      expect(await readState(path)).toEqual(state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
