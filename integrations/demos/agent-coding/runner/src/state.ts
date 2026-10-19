import { z } from 'zod';

export const RunStateSchema = z.object({
  runId: z.string().min(1),
  layers: z.array(z.string()),
  mounts: z.array(z.string()),
  branches: z.array(z.object({ clusterId: z.string(), branchId: z.string() })),
  journalId: z.string().optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;

export const emptyState = (runId: string): RunState => ({ runId, layers: [], mounts: [], branches: [] });

export const withLayer = (state: RunState, layerId: string): RunState => ({ ...state, layers: [...state.layers, layerId] });

export const withMount = (state: RunState, mountPath: string): RunState => ({
  ...state,
  mounts: state.mounts.includes(mountPath) ? state.mounts : [...state.mounts, mountPath],
});

export const withoutMount = (state: RunState, mountPath: string): RunState => ({
  ...state,
  mounts: state.mounts.filter((candidate) => candidate !== mountPath),
});

export const withBranch = (state: RunState, branch: { readonly clusterId: string; readonly branchId: string }): RunState => ({
  ...state,
  branches: [...state.branches, branch],
});

export const withJournal = (state: RunState, journalId: string): RunState => ({ ...state, journalId });
