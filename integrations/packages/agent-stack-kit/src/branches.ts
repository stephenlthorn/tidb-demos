import { setTimeout as delay } from 'node:timers/promises';
import { runCli, stdoutOrThrow, type RunCli } from './cli';
import { parseBranch, parseBranchList, type BranchInfo } from './parse';

export type Branches = {
  readonly create: (options: {
    readonly clusterId: string;
    readonly name: string;
    readonly parentId?: string;
    readonly parentTimestamp?: string;
  }) => Promise<{ readonly branchId: string; readonly state: string }>;
  readonly waitActive: (options: {
    readonly clusterId: string;
    readonly branchId: string;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
  }) => Promise<BranchInfo>;
  readonly remove: (options: { readonly clusterId: string; readonly branchId: string }) => Promise<void>;
  readonly list: (options: { readonly clusterId: string }) => Promise<readonly BranchInfo[]>;
};

export type BranchWaitDecision = 'ready' | 'wait' | 'failed' | 'timeout';

const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const flag = (name: string, value: string | undefined): readonly string[] => (value === undefined ? [] : [name, value]);

export const branchWaitDecision = (options: {
  readonly state: string | undefined;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}): BranchWaitDecision => {
  const state = options.state?.toUpperCase();
  if (state === 'ACTIVE') return 'ready';
  if (state === 'FAILED' || state === 'DELETED' || state === 'DELETING') return 'failed';
  return options.elapsedMs >= options.timeoutMs ? 'timeout' : 'wait';
};

export const createBranchArgs = (options: Parameters<Branches['create']>[0]): readonly string[] => {
  if (options.parentTimestamp !== undefined && !rfc3339Pattern.test(options.parentTimestamp)) {
    throw new RangeError(`parentTimestamp must be RFC3339, got: ${options.parentTimestamp}`);
  }
  return [
    'serverless',
    'branch',
    'create',
    '--cluster-id',
    options.clusterId,
    '--display-name',
    options.name,
    ...flag('--parent-id', options.parentId),
    ...flag('--parent-timestamp', options.parentTimestamp),
    '--no-color',
  ];
};

export const listBranchArgs = (options: { readonly clusterId: string }): readonly string[] => [
  'serverless',
  'branch',
  'list',
  options.clusterId,
  '-o',
  'json',
  '--no-color',
];

export const deleteBranchArgs = (options: { readonly clusterId: string; readonly branchId: string }): readonly string[] => [
  'serverless',
  'branch',
  'delete',
  '--cluster-id',
  options.clusterId,
  '--branch-id',
  options.branchId,
  '--force',
  '--no-color',
];

export const createBranches = (
  run: RunCli,
  options: { readonly clock?: () => number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Branches => {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const exec = async (label: string, args: readonly string[]): Promise<string> =>
    stdoutOrThrow(await run({ bin: 'ticloud', args }), label);
  const list: Branches['list'] = async (listOptions) =>
    parseBranchList(await exec('ticloud serverless branch list', listBranchArgs(listOptions)));
  const poll = async (
    waitOptions: Parameters<Branches['waitActive']>[0],
    startedAt: number,
  ): Promise<BranchInfo> => {
    const timeoutMs = waitOptions.timeoutMs ?? 900000;
    const found = (await list({ clusterId: waitOptions.clusterId })).find(
      (branch) => branch.branchId === waitOptions.branchId,
    );
    const decision = branchWaitDecision({ state: found?.state, elapsedMs: clock() - startedAt, timeoutMs });
    if (decision === 'ready' && found !== undefined) return found;
    if (decision === 'failed') throw new Error(`branch ${waitOptions.branchId} entered state ${found?.state}`);
    if (decision === 'timeout') {
      throw new Error(`branch ${waitOptions.branchId} not ACTIVE after ${timeoutMs}ms (state ${found?.state ?? 'missing'})`);
    }
    await sleep(waitOptions.pollMs ?? 10000);
    return poll(waitOptions, startedAt);
  };
  return {
    create: async (createOptions) =>
      parseBranch(await exec('ticloud serverless branch create', createBranchArgs(createOptions))),
    waitActive: (waitOptions) => poll(waitOptions, clock()),
    remove: async (removeOptions) => {
      await exec('ticloud serverless branch delete', deleteBranchArgs(removeOptions));
    },
    list,
  };
};

export const branches: Branches = createBranches(runCli);
