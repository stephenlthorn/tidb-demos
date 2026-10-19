import { describe, expect, it } from 'vitest';
import type { CliOptions, CliResult, RunCli } from '../src/cli';
import { createTiFs } from '../src/tifs';

const recordingRunner = (
  responses: readonly CliResult[],
): { readonly calls: readonly CliOptions[]; readonly run: RunCli } => {
  const calls: CliOptions[] = [];
  const queue = [...responses];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      return queue.shift() ?? { code: 0, stdout: '', stderr: '' };
    },
  };
};

const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '' });

describe('createTiFs', () => {
  it('creates a restore-safe layer and returns its id', async () => {
    const { calls, run } = recordingRunner([ok('{"layer_id":"lyr_1"}')]);
    const result = await createTiFs(run).createLayer({
      baseRootPath: '/workspace',
      layerName: 'task',
      tags: { task: 'KIT-8812' },
    });
    expect(result).toEqual({ layerId: 'lyr_1' });
    expect(calls[0]).toEqual({
      bin: 'ti',
      args: [
        'fs',
        'create-layer',
        '--base-root-path',
        '/workspace',
        '--layer-name',
        'task',
        '--durability-mode',
        'restore-safe',
        '--tag',
        'task=KIT-8812',
        '--output',
        'json',
      ],
    });
  });

  it('drains the mount before it creates the checkpoint and times both', async () => {
    const times = [100, 140, 190];
    const clock = (): number => times.shift() ?? 0;
    const { calls, run } = recordingRunner([ok(''), ok('{"checkpoint_id":"step-01"}')]);
    const result = await createTiFs(run, clock).checkpoint({
      layerId: 'lyr_1',
      mountPath: '/mnt/a1',
      checkpointId: 'step-01',
    });
    expect(result).toEqual({ checkpointId: 'step-01', drainMs: 40, checkpointMs: 50 });
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['fs', 'drain-file-system'],
      ['fs', 'create-layer-checkpoint'],
    ]);
  });

  it('forks from a checkpoint', async () => {
    const { calls, run } = recordingRunner([ok('{"layer_id":"lyr_2"}')]);
    const result = await createTiFs(run).forkLayer({
      parentLayerRef: 'lyr_1',
      layerName: 'attempt-1',
      checkpointId: 'seed',
    });
    expect(result).toEqual({ layerId: 'lyr_2' });
    expect(calls[0]?.args).toEqual([
      'fs',
      'fork-layer',
      '--parent-layer-ref',
      'lyr_1',
      '--layer-name',
      'attempt-1',
      '--checkpoint-id',
      'seed',
      '--output',
      'json',
    ]);
  });

  it('mounts a layer through FUSE and can request a read-only checkpoint mount', async () => {
    const { calls, run } = recordingRunner([ok(''), ok('')]);
    const tiFs = createTiFs(run);
    await tiFs.mountLayer({ mountPath: '/mnt/a1', layerRef: 'lyr_2', remotePath: '/workspace' });
    await tiFs.mountLayer({
      mountPath: '/mnt/c',
      layerRef: 'lyr_2',
      remotePath: '/workspace',
      checkpointId: 'step-07',
      readOnly: true,
    });
    expect(calls[0]?.args).toEqual([
      'fs',
      'mount-file-system',
      '--mount-path',
      '/mnt/a1',
      '--remote-path',
      '/workspace',
      '--driver',
      'fuse',
      '--layer-ref',
      'lyr_2',
    ]);
    expect(calls[1]?.args.slice(-5)).toEqual(['--layer-ref', 'lyr_2', '--checkpoint-id', 'step-07', '--read-only']);
  });

  it('returns the changed paths from diff-layer', async () => {
    const { run } = recordingRunner([ok('{"changes":[{"path":"/workspace/a.js"}]}')]);
    expect(await createTiFs(run).diffLayer({ layerId: 'lyr_2' })).toEqual(['/workspace/a.js']);
  });

  it('passes cascade to delete-layer only when asked', async () => {
    const { calls, run } = recordingRunner([ok(''), ok('')]);
    const tiFs = createTiFs(run);
    await tiFs.deleteLayer({ layerRef: 'lyr_1' });
    await tiFs.deleteLayer({ layerRef: 'lyr_1', cascade: true });
    expect(calls[0]?.args).toEqual(['fs', 'delete-layer', '--layer-ref', 'lyr_1']);
    expect(calls[1]?.args).toEqual(['fs', 'delete-layer', '--layer-ref', 'lyr_1', '--cascade']);
  });

  it('appends a journal entry with an idempotency key', async () => {
    const { calls, run } = recordingRunner([ok('')]);
    await createTiFs(run).appendJournal({
      journalId: 'jrn-1',
      entry: { type: 'step.completed' },
      idempotencyKey: 'a1-step-01',
    });
    expect(calls[0]?.args).toEqual([
      'fs-journal',
      'append-journal-entries',
      '--journal-id',
      'jrn-1',
      '--entry-json',
      '{"type":"step.completed"}',
      '--idempotency-key',
      'a1-step-01',
    ]);
  });

  it('verifies a journal', async () => {
    const { run } = recordingRunner([ok('{"ok":true}')]);
    expect(await createTiFs(run).verifyJournal({ journalId: 'jrn-1' })).toEqual({ ok: true });
  });

  it('returns a trimmed vault grant token', async () => {
    const { calls, run } = recordingRunner([ok('tok_abc\n')]);
    const token = await createTiFs(run).createGrant({
      agentId: 'agent-1',
      scope: 'watchlist/API_KEY',
      permission: 'read',
      ttl: '10m',
    });
    expect(token).toBe('tok_abc');
    expect(calls[0]?.args).toContain('--token-only');
  });

  it('searches content inside a layer', async () => {
    const { calls, run } = recordingRunner([ok('/workspace/a.js:3:match')]);
    const text = await createTiFs(run).grep({ pattern: 'idempotency', layerId: 'lyr_2', limit: 5 });
    expect(text).toBe('/workspace/a.js:3:match');
    expect(calls[0]?.args).toEqual([
      'fs',
      'search-file-content',
      '--pattern',
      'idempotency',
      '--layer-id',
      'lyr_2',
      '--limit',
      '5',
    ]);
  });

  it('throws with the command name when the CLI exits nonzero', async () => {
    const { run } = recordingRunner([{ code: 1, stdout: '', stderr: 'unauthorized' }]);
    await expect(createTiFs(run).commitLayer({ layerId: 'lyr_1' })).rejects.toThrow(
      'ti fs commit-layer failed with exit code 1: unauthorized',
    );
  });
});
