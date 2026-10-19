import type { Emitter } from '@lab/runner-kit';
import type { Branches, BranchInfo, LakeClient, RunCli, S3EventSink, TiFs } from '@lab/agent-stack-kit';
import type { RunConfig } from './config';
import type { StepRecord } from './checks';
import type { StepOutcome } from './harness';
import type { AttemptResult } from './score';
import type { AttemptScript } from './scripts';
import type { RunState } from './state';
import type { Sql } from './sql';
import type { Tree } from './tree';

export type Deps = {
  readonly config: RunConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly emitter: Emitter;
  readonly orgPool: Sql;
  readonly tiFs: TiFs;
  readonly branches: Branches;
  readonly lake: LakeClient;
  readonly lakeBootstrap: LakeClient;
  readonly sink: S3EventSink;
  readonly run: RunCli;
  readonly scripts: readonly AttemptScript[];
  readonly sleep: (ms: number) => Promise<void>;
  readonly openBranchPool: (branch: BranchInfo) => Sql;
  readonly saveState: (state: RunState) => Promise<void>;
};

export type AttemptRuntime = {
  readonly script: AttemptScript;
  readonly mountPath: string;
  readonly repoDir: string;
  layerId: string;
  branchId: string;
  branchReady: Promise<BranchInfo> | undefined;
  pool: Sql | undefined;
  outcomes: readonly StepOutcome[];
  changedFiles: readonly string[];
};

export type StepEntry = StepRecord & { readonly dbTime: string };

export type Memory = {
  state: RunState;
  taskLayerId: string;
  journalId: string;
  baselineTree: Tree;
  attempts: readonly AttemptRuntime[];
  stepEntries: ReadonlyMap<string, StepEntry>;
  injectFault: boolean;
  done: readonly string[];
  results: readonly AttemptResult[];
  winner: AttemptResult | undefined;
  replayTarget: { readonly attemptId: string; readonly haltedAtStep: number } | undefined;
  replayBranch: Promise<BranchInfo> | undefined;
  eventsEmitted: number;
  firstEventWrittenAtMs: number | undefined;
  failureMessage: string | undefined;
  replayVerified: boolean | undefined;
  lessonId: number | undefined;
};

export const createMemory = (state: RunState): Memory => ({
  state,
  taskLayerId: '',
  journalId: '',
  baselineTree: {},
  attempts: [],
  stepEntries: new Map(),
  injectFault: false,
  done: [],
  results: [],
  winner: undefined,
  replayTarget: undefined,
  replayBranch: undefined,
  eventsEmitted: 0,
  firstEventWrittenAtMs: undefined,
  failureMessage: undefined,
  replayVerified: undefined,
  lessonId: undefined,
});

export type Stage = { readonly deps: Deps; readonly memory: Memory };

export const injectedFaultTarget = 'attempt-1';

export const isInjected = (memory: Memory, attemptId: string): boolean =>
  memory.injectFault && attemptId === injectedFaultTarget;

export const stepKey = (attemptId: string, step: number): string => `${attemptId}:${step}`;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
