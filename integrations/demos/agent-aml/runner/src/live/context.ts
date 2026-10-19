import type { BranchInfo } from '@lab/agent-stack-kit';
import type { Emitter } from '@lab/runner-kit';
import type { AmlConfig } from '../config';
import type { Account, Alert, GroundTruthEntry, WatchlistEntry } from '../domain';
import type { PastCase, Playbook } from '../fixtures';
import type { Population } from '../generator';
import type { DistilledSkill } from '../skills';
import type { StarterPool } from '../starter';
import type { Store } from '../store';
import type { WhatIfResult } from '../whatIf';
import type { CaseWorkingSet } from '../workingSet';
import type { Lake } from './lake';
import type { RowSink } from './sinks';

export type World = {
  readonly population: Population;
  readonly accounts: readonly Account[];
  readonly truth: readonly GroundTruthEntry[];
  readonly watchlistEntries: number;
  readonly watchlistCandidates: ReadonlyMap<string, readonly WatchlistEntry[]>;
  readonly nextTxnId: number;
  readonly lastDayStartMs: number;
  readonly dayCounter: number;
  readonly ringCount: number;
  readonly ringAccountCount: number;
  readonly nearMatchCount: number;
  readonly exportedUpToTxnId: number;
  readonly lastAlertCommitWallMs: number;
  readonly runEventSeq: number;
  readonly flagsEmitted: number;
  readonly coverageStatus: 'pending' | 'pass' | 'fail';
};

export type CaseRecord = {
  readonly caseId: string;
  readonly alert: Alert;
  readonly layerId: string;
  readonly grantToken: string;
  readonly branchEndpoint: BranchInfo | undefined;
  readonly workingSet: CaseWorkingSet | undefined;
  readonly whatIf: WhatIfResult | undefined;
  readonly shadowAlerts: readonly Alert[];
  readonly skillLayerId: string | undefined;
  readonly distilled: DistilledSkill | undefined;
  readonly skillPath: string | undefined;
  readonly lakeRecallV2: number | undefined;
};

export type Fixtures = {
  readonly directory: string;
  readonly watchlistNames: readonly string[];
  readonly watchlistTag: string;
  readonly pastCases: readonly PastCase[];
  readonly playbook: Playbook;
};

export type Context = {
  readonly config: AmlConfig;
  readonly database: string;
  readonly runId: string;
  readonly emitter: Emitter;
  readonly pool: StarterPool;
  readonly lake: Lake;
  readonly sinks: { readonly truth: RowSink; readonly flags: RowSink; readonly run: RowSink };
  readonly fixtures: Fixtures;
  readonly world: Store<World>;
  readonly cases: Store<readonly CaseRecord[]>;
};

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
