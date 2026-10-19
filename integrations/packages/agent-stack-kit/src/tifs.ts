import { runCli, stdoutOrThrow, type RunCli } from './cli';
import { parseCheckpoint, parseJournalVerify, parseLayerDiff, parseLayerId } from './parse';

export type TiFs = {
  readonly createLayer: (options: {
    readonly baseRootPath: string;
    readonly layerName: string;
    readonly actorId?: string;
    readonly tags?: Readonly<Record<string, string>>;
  }) => Promise<{ readonly layerId: string }>;
  readonly checkpoint: (options: {
    readonly layerId: string;
    readonly mountPath: string;
    readonly checkpointId: string;
    readonly label?: string;
    readonly drainTimeout?: string;
  }) => Promise<{ readonly checkpointId: string; readonly drainMs: number; readonly checkpointMs: number }>;
  readonly forkLayer: (options: {
    readonly parentLayerRef: string;
    readonly layerName: string;
    readonly checkpointId?: string;
    readonly actorId?: string;
  }) => Promise<{ readonly layerId: string }>;
  readonly mountLayer: (options: {
    readonly mountPath: string;
    readonly layerRef: string;
    readonly remotePath: string;
    readonly checkpointId?: string;
    readonly readOnly?: boolean;
  }) => Promise<void>;
  readonly unmount: (options: { readonly mountPath: string }) => Promise<void>;
  readonly diffLayer: (options: { readonly layerId: string }) => Promise<readonly string[]>;
  readonly commitLayer: (options: { readonly layerId: string }) => Promise<void>;
  readonly rollbackLayer: (options: { readonly layerId: string }) => Promise<void>;
  readonly deleteLayer: (options: { readonly layerRef: string; readonly cascade?: boolean }) => Promise<void>;
  readonly grep: (options: {
    readonly pattern: string;
    readonly path?: string;
    readonly layerId?: string;
    readonly limit?: number;
  }) => Promise<string>;
  readonly createJournal: (options: {
    readonly journalId: string;
    readonly journalKind?: string;
    readonly title?: string;
  }) => Promise<void>;
  readonly appendJournal: (options: {
    readonly journalId: string;
    readonly entry: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
  }) => Promise<void>;
  readonly verifyJournal: (options: { readonly journalId: string }) => Promise<{ readonly ok: boolean }>;
  readonly createGrant: (options: {
    readonly agentId: string;
    readonly scope: string;
    readonly permission: 'read' | 'write';
    readonly ttl: string;
  }) => Promise<string>;
};

const flag = (name: string, value: string | undefined): readonly string[] => (value === undefined ? [] : [name, value]);
const jsonOutput: readonly string[] = ['--output', 'json'];

export const createLayerArgs = (options: Parameters<TiFs['createLayer']>[0]): readonly string[] => [
  'fs',
  'create-layer',
  '--base-root-path',
  options.baseRootPath,
  '--layer-name',
  options.layerName,
  '--durability-mode',
  'restore-safe',
  ...flag('--actor-id', options.actorId),
  ...Object.entries(options.tags ?? {}).flatMap(([key, value]) => ['--tag', `${key}=${value}`]),
  ...jsonOutput,
];

export const drainArgs = (options: { readonly mountPath: string; readonly timeout?: string }): readonly string[] => [
  'fs',
  'drain-file-system',
  '--mount-path',
  options.mountPath,
  ...flag('--timeout', options.timeout),
];

export const checkpointArgs = (options: {
  readonly layerId: string;
  readonly checkpointId: string;
  readonly label?: string;
}): readonly string[] => [
  'fs',
  'create-layer-checkpoint',
  '--layer-id',
  options.layerId,
  '--checkpoint-id',
  options.checkpointId,
  ...flag('--label', options.label),
  ...jsonOutput,
];

export const forkLayerArgs = (options: Parameters<TiFs['forkLayer']>[0]): readonly string[] => [
  'fs',
  'fork-layer',
  '--parent-layer-ref',
  options.parentLayerRef,
  '--layer-name',
  options.layerName,
  ...flag('--checkpoint-id', options.checkpointId),
  ...flag('--actor-id', options.actorId),
  ...jsonOutput,
];

export const mountArgs = (options: Parameters<TiFs['mountLayer']>[0]): readonly string[] => [
  'fs',
  'mount-file-system',
  '--mount-path',
  options.mountPath,
  '--remote-path',
  options.remotePath,
  '--driver',
  'fuse',
  '--layer-ref',
  options.layerRef,
  ...flag('--checkpoint-id', options.checkpointId),
  ...(options.readOnly === true ? ['--read-only'] : []),
];

export const unmountArgs = (options: { readonly mountPath: string }): readonly string[] => [
  'fs',
  'unmount-file-system',
  '--mount-path',
  options.mountPath,
];

export const diffArgs = (options: { readonly layerId: string }): readonly string[] => [
  'fs',
  'diff-layer',
  '--layer-id',
  options.layerId,
  ...jsonOutput,
];

export const commitArgs = (options: { readonly layerId: string }): readonly string[] => [
  'fs',
  'commit-layer',
  '--layer-id',
  options.layerId,
];

export const rollbackArgs = (options: { readonly layerId: string }): readonly string[] => [
  'fs',
  'rollback-layer',
  '--layer-id',
  options.layerId,
];

export const deleteLayerArgs = (options: { readonly layerRef: string; readonly cascade?: boolean }): readonly string[] => [
  'fs',
  'delete-layer',
  '--layer-ref',
  options.layerRef,
  ...(options.cascade === true ? ['--cascade'] : []),
];

export const grepArgs = (options: Parameters<TiFs['grep']>[0]): readonly string[] => [
  'fs',
  'search-file-content',
  '--pattern',
  options.pattern,
  ...flag('--path', options.path),
  ...flag('--layer-id', options.layerId),
  ...(options.limit === undefined ? [] : ['--limit', String(options.limit)]),
];

export const createJournalArgs = (options: Parameters<TiFs['createJournal']>[0]): readonly string[] => [
  'fs-journal',
  'create-journal',
  '--journal-id',
  options.journalId,
  ...flag('--journal-kind', options.journalKind),
  ...flag('--title', options.title),
];

export const appendJournalArgs = (options: Parameters<TiFs['appendJournal']>[0]): readonly string[] => [
  'fs-journal',
  'append-journal-entries',
  '--journal-id',
  options.journalId,
  '--entry-json',
  JSON.stringify(options.entry),
  '--idempotency-key',
  options.idempotencyKey,
];

export const verifyJournalArgs = (options: { readonly journalId: string }): readonly string[] => [
  'fs-journal',
  'verify-journal',
  '--journal-id',
  options.journalId,
  ...jsonOutput,
];

export const grantArgs = (options: Parameters<TiFs['createGrant']>[0]): readonly string[] => [
  'fs-vault',
  'create-grant',
  '--agent-id',
  options.agentId,
  '--scope',
  options.scope,
  '--permission',
  options.permission,
  '--ttl',
  options.ttl,
  '--token-only',
];

export const createTiFs = (run: RunCli, clock: () => number = () => performance.now()): TiFs => {
  const exec = async (label: string, args: readonly string[]): Promise<string> =>
    stdoutOrThrow(await run({ bin: 'ti', args }), label);
  return {
    createLayer: async (options) => ({ layerId: parseLayerId(await exec('ti fs create-layer', createLayerArgs(options))) }),
    checkpoint: async (options) => {
      const drainStart = clock();
      await exec('ti fs drain-file-system', drainArgs({ mountPath: options.mountPath, timeout: options.drainTimeout }));
      const checkpointStart = clock();
      const stdout = await exec('ti fs create-layer-checkpoint', checkpointArgs(options));
      const finished = clock();
      return {
        checkpointId: parseCheckpoint(stdout).checkpointId,
        drainMs: checkpointStart - drainStart,
        checkpointMs: finished - checkpointStart,
      };
    },
    forkLayer: async (options) => ({ layerId: parseLayerId(await exec('ti fs fork-layer', forkLayerArgs(options))) }),
    mountLayer: async (options) => {
      await exec('ti fs mount-file-system', mountArgs(options));
    },
    unmount: async (options) => {
      await exec('ti fs unmount-file-system', unmountArgs(options));
    },
    diffLayer: async (options) => parseLayerDiff(await exec('ti fs diff-layer', diffArgs(options))),
    commitLayer: async (options) => {
      await exec('ti fs commit-layer', commitArgs(options));
    },
    rollbackLayer: async (options) => {
      await exec('ti fs rollback-layer', rollbackArgs(options));
    },
    deleteLayer: async (options) => {
      await exec('ti fs delete-layer', deleteLayerArgs(options));
    },
    grep: (options) => exec('ti fs search-file-content', grepArgs(options)),
    createJournal: async (options) => {
      await exec('ti fs-journal create-journal', createJournalArgs(options));
    },
    appendJournal: async (options) => {
      await exec('ti fs-journal append-journal-entries', appendJournalArgs(options));
    },
    verifyJournal: async (options) => parseJournalVerify(await exec('ti fs-journal verify-journal', verifyJournalArgs(options))),
    createGrant: async (options) => (await exec('ti fs-vault create-grant', grantArgs(options))).trim(),
  };
};

export const tiFs: TiFs = createTiFs(runCli);
