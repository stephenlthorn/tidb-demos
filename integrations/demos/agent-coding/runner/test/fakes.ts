import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli, type BranchInfo, type Branches, type CliOptions, type CliResult, type LakeClient, type RunCli, type S3EventSink, type TiFs } from '@lab/agent-stack-kit';
import { readTree } from '../src/harness';
import type { Row, Sql } from '../src/sql';
import { changedPaths, type Tree } from '../src/tree';

export type FakeTiFs = {
  readonly tiFs: TiFs;
  readonly calls: string[];
  readonly journal: Record<string, unknown>[];
};

export const createFakeTiFs = (root: string): FakeTiFs => {
  const calls: string[] = [];
  const journal: Record<string, unknown>[] = [];
  const layers = new Map<string, string>();
  const state: { next: number; seed: Tree } = { next: 0, seed: {} };
  const newLayer = async (copyFrom: string | undefined): Promise<{ readonly layerId: string }> => {
    state.next += 1;
    const layerId = `lyr_${state.next}`;
    const dir = join(root, 'layers', layerId);
    await mkdir(dir, { recursive: true });
    if (copyFrom !== undefined) await cp(copyFrom, dir, { recursive: true });
    layers.set(layerId, dir);
    return { layerId };
  };
  const dirOf = (layerId: string): string => {
    const dir = layers.get(layerId);
    if (dir === undefined) throw new Error(`unknown layer ${layerId}`);
    return dir;
  };
  const tiFs: TiFs = {
    createLayer: async () => {
      calls.push('createLayer');
      return newLayer(undefined);
    },
    checkpoint: async (options) => {
      calls.push(`checkpoint ${options.layerId} ${options.checkpointId}`);
      const dir = dirOf(options.layerId);
      await rm(dir, { recursive: true, force: true });
      await cp(options.mountPath, dir, { recursive: true });
      const snapshot = join(root, 'cp', `${options.layerId}-${options.checkpointId}`);
      await cp(options.mountPath, snapshot, { recursive: true });
      if (options.checkpointId === 'seed') state.seed = await readTree(join(snapshot, 'payments-api'));
      return { checkpointId: options.checkpointId, drainMs: 1, checkpointMs: 2 };
    },
    forkLayer: async (options) => {
      calls.push(`forkLayer ${options.parentLayerRef} ${options.checkpointId ?? 'tip'}`);
      const source =
        options.checkpointId === undefined
          ? dirOf(options.parentLayerRef)
          : join(root, 'cp', `${options.parentLayerRef}-${options.checkpointId}`);
      return newLayer(source);
    },
    mountLayer: async (options) => {
      calls.push(`mountLayer ${options.layerRef}`);
      await mkdir(options.mountPath, { recursive: true });
      await cp(dirOf(options.layerRef), options.mountPath, { recursive: true });
    },
    unmount: async (options) => {
      calls.push(`unmount ${options.mountPath}`);
    },
    diffLayer: async (options) => {
      const tree = await readTree(join(dirOf(options.layerId), 'payments-api'));
      return changedPaths(state.seed, tree).map((path) => `/workspace/payments-api/${path}`);
    },
    commitLayer: async () => {
      calls.push('commitLayer');
      throw new Error('a coding attempt must never commit its layer');
    },
    rollbackLayer: async () => {
      calls.push('rollbackLayer');
    },
    deleteLayer: async () => {
      calls.push('deleteLayer');
    },
    grep: async () => '',
    createJournal: async (options) => {
      journal.push({ type: 'journal.created', journalId: options.journalId });
    },
    appendJournal: async (options) => {
      journal.push({ journalId: options.journalId, ...options.entry });
    },
    verifyJournal: async () => ({ ok: true }),
    createGrant: async () => 'token',
  };
  return { tiFs, calls, journal };
};

export type BranchCall = { readonly clusterId: string; readonly name: string; readonly parentId?: string; readonly parentTimestamp?: string };

export const createFakeBranches = (): { readonly branches: Branches; readonly created: BranchCall[] } => {
  const created: BranchCall[] = [];
  const info = (branchId: string): BranchInfo => ({
    branchId,
    state: 'ACTIVE',
    host: 'branch.example.test',
    port: 4000,
    userPrefix: 'pfx',
  });
  const branches: Branches = {
    create: async (options) => {
      created.push(options);
      return { branchId: `br_${created.length}`, state: 'CREATING' };
    },
    waitActive: async (options) => info(options.branchId),
    remove: async () => undefined,
    list: async () => [],
  };
  return { branches, created };
};

export const createFakeBranchSql = (): Sql => {
  const state = { seconds: 0 };
  return {
    rows: async () => {
      state.seconds += 1;
      const dbTime = new Date(Date.UTC(2026, 9, 17, 10, 0, state.seconds)).toISOString().replace('.000Z', '.250000Z');
      return [{ db_time: dbTime, row_count: '2000', checksum: '1234567890' }];
    },
    insert: async () => 0,
    exec: async () => undefined,
    end: async () => undefined,
  };
};

export type FakeOrg = {
  readonly sql: Sql;
  readonly memories: { readonly id: number; readonly kind: string; readonly content: string }[];
  readonly ledger: (readonly (string | number)[])[];
};

export const createFakeOrg = (): FakeOrg => {
  const memories: { id: number; kind: string; content: string }[] = [];
  const ledger: (readonly (string | number)[])[] = [];
  const sql: Sql = {
    rows: async (statement): Promise<readonly Row[]> => {
      if (statement.includes('COUNT(*) AS n FROM memories')) return [{ n: memories.length }];
      if (statement.includes('COUNT(*) AS n FROM ledger')) return [{ n: ledger.length }];
      if (statement.startsWith('WITH')) return [...memories].reverse().slice(0, 3);
      return [];
    },
    insert: async (statement, params) => {
      if (statement.includes('INTO memories')) {
        const id = memories.length + 1;
        memories.push({ id, kind: String(params[0]), content: String(params[1]) });
        return id;
      }
      ledger.push(params);
      return 0;
    },
    exec: async () => undefined,
    end: async () => undefined,
  };
  return { sql, memories, ledger };
};

export const createFakeSink = (): { readonly sink: S3EventSink; readonly lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      write: async (batch) => {
        lines.push(...batch);
        return { key: `events/${lines.length}.ndjson` };
      },
    },
  };
};

export const createFakeLake = (options: { readonly lines: readonly string[]; readonly ledgerRows: () => number }): LakeClient => ({
  query: async (statement) => {
    if (statement.includes("kind = 'marker'")) return [{ n: 1 }];
    if (statement.includes('FROM run_events WHERE run_id')) {
      const runId = /run_id = '([^']+)'/.exec(statement)?.[1];
      return [{ n: options.lines.filter((line) => line.includes(`"run_id":"${runId}"`)).length }];
    }
    if (statement.includes('FROM ledger_lake WHERE run_id')) return [{ n: options.ledgerRows() }];
    if (statement.includes("MATCH(message, 'ECONNRESET')")) return [{ matches: 12, runs: 7 }];
    if (statement.includes('GROUP BY model')) return [{ model: 'fixture-model-a', merged_per_dollar: 4.2 }];
    if (statement.includes('COSINE_DISTANCE')) return [{ distance: 0.12, message: 'ECONNRESET at step 7: connect ECONNRESET' }];
    return [];
  },
});

export const createFakeRun = (): RunCli => async (command: CliOptions): Promise<CliResult> => {
  if (command.bin === 'ticloud' && command.args.includes('create')) return { code: 0, stdout: '{"exportId":"exp-abc123"}', stderr: '' };
  if (command.bin === 'ticloud') return { code: 0, stdout: 'state: COMPLETED', stderr: '' };
  return runCli(command);
};
