import { describe, expect, it } from 'vitest';
import type { CliOptions, CliResult, RunCli } from '../src/cli';
import { branchWaitDecision, createBranchArgs, createBranches } from '../src/branches';

const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '' });

const scriptedRunner = (
  responses: readonly CliResult[],
): { readonly calls: readonly CliOptions[]; readonly run: RunCli } => {
  const calls: CliOptions[] = [];
  const queue = [...responses];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      return queue.shift() ?? ok('[]');
    },
  };
};

const listOf = (state: string): CliResult => ok(JSON.stringify([{ branchId: 'br_1', state }]));

describe('createBranchArgs', () => {
  it('builds a branch from the instance', () => {
    expect(createBranchArgs({ clusterId: 'c1', name: 'attempt-1' })).toEqual([
      'serverless',
      'branch',
      'create',
      '--cluster-id',
      'c1',
      '--display-name',
      'attempt-1',
      '--no-color',
    ]);
  });

  it('builds a point-in-time branch of another branch', () => {
    const args = createBranchArgs({
      clusterId: 'c1',
      name: 'replay',
      parentId: 'br_2',
      parentTimestamp: '2026-10-17T10:00:01Z',
    });
    expect(args).toContain('--parent-id');
    expect(args.slice(-3)).toEqual(['--parent-timestamp', '2026-10-17T10:00:01Z', '--no-color']);
  });

  it('rejects a parent timestamp that is not RFC3339', () => {
    expect(() => createBranchArgs({ clusterId: 'c1', name: 'x', parentTimestamp: '2026-10-17 10:00:01' })).toThrow(
      RangeError,
    );
  });
});

describe('branchWaitDecision', () => {
  it('is ready when ACTIVE regardless of case', () => {
    expect(branchWaitDecision({ state: 'active', elapsedMs: 0, timeoutMs: 10 })).toBe('ready');
  });

  it('fails on a terminal bad state', () => {
    expect(branchWaitDecision({ state: 'FAILED', elapsedMs: 0, timeoutMs: 10 })).toBe('failed');
  });

  it('waits while creating and times out afterwards', () => {
    expect(branchWaitDecision({ state: 'CREATING', elapsedMs: 5, timeoutMs: 10 })).toBe('wait');
    expect(branchWaitDecision({ state: 'CREATING', elapsedMs: 10, timeoutMs: 10 })).toBe('timeout');
    expect(branchWaitDecision({ state: undefined, elapsedMs: 11, timeoutMs: 10 })).toBe('timeout');
  });
});

describe('createBranches', () => {
  it('creates a branch and returns its id and state', async () => {
    const { calls, run } = scriptedRunner([ok('{"branchId":"br_1","state":"CREATING"}')]);
    const result = await createBranches(run).create({ clusterId: 'c1', name: 'attempt-1' });
    expect(result).toEqual({ branchId: 'br_1', state: 'CREATING' });
    expect(calls[0]?.bin).toBe('ticloud');
  });

  it('polls the list until the branch is ACTIVE', async () => {
    const { calls, run } = scriptedRunner([listOf('CREATING'), listOf('CREATING'), listOf('ACTIVE')]);
    const slept: number[] = [];
    const result = await createBranches(run, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).waitActive({ clusterId: 'c1', branchId: 'br_1', pollMs: 5 });
    expect(result.state).toBe('ACTIVE');
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([5, 5]);
  });

  it('throws when the branch fails', async () => {
    const { run } = scriptedRunner([listOf('FAILED')]);
    await expect(createBranches(run).waitActive({ clusterId: 'c1', branchId: 'br_1' })).rejects.toThrow(
      'branch br_1 entered state FAILED',
    );
  });

  it('throws when the timeout passes', async () => {
    const times = [0, 50, 100];
    const { run } = scriptedRunner([listOf('CREATING'), listOf('CREATING')]);
    await expect(
      createBranches(run, {
        clock: () => times.shift() ?? 100,
        sleep: async () => undefined,
      }).waitActive({ clusterId: 'c1', branchId: 'br_1', timeoutMs: 60, pollMs: 1 }),
    ).rejects.toThrow('not ACTIVE after 60ms');
  });

  it('deletes without a confirmation prompt', async () => {
    const { calls, run } = scriptedRunner([ok('')]);
    await createBranches(run).remove({ clusterId: 'c1', branchId: 'br_1' });
    expect(calls[0]?.args).toContain('--force');
  });
});
