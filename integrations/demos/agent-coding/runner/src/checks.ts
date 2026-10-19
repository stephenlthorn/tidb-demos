import type { BranchSnapshot } from './snapshot';

export type CheckVerdict = { readonly pass: boolean; readonly observed: string };

const touches = (diff: readonly string[], path: string): boolean =>
  diff.some((entry) => entry === path || entry.endsWith(`/${path}`));

export const isolationVerdict = (options: {
  readonly diffs: Readonly<Record<string, readonly string[]>>;
  readonly owners: Readonly<Record<string, string>>;
}): CheckVerdict => {
  const violations = Object.entries(options.owners).flatMap(([path, owner]) =>
    Object.entries(options.diffs).flatMap(([attemptId, diff]) => {
      const present = touches(diff, path);
      if (attemptId === owner && !present) return [`${path} missing from ${owner}`];
      if (attemptId !== owner && present) return [`${path} written by ${owner} appears in ${attemptId}`];
      return [];
    }),
  );
  const checked = Object.keys(options.owners).length;
  return violations.length === 0
    ? { pass: true, observed: `${checked} attempt-private files appear only in their own layer diff` }
    : { pass: false, observed: violations.join('; ') };
};

export const snapshotsVerdict = (snapshots: Readonly<Record<string, BranchSnapshot>>): CheckVerdict => {
  const entries = Object.entries(snapshots);
  const first = entries[0]?.[1];
  if (first === undefined) return { pass: false, observed: 'no branch snapshots were taken' };
  const odd = entries.filter(([, snapshot]) => snapshot.checksum !== first.checksum || snapshot.rowCount !== first.rowCount);
  return odd.length === 0
    ? { pass: true, observed: `${entries.length} branches agree: ${first.rowCount} rows, checksum ${first.checksum}` }
    : { pass: false, observed: `differs from ${entries[0]?.[0]}: ${odd.map(([attemptId]) => attemptId).join(', ')}` };
};

export type StepRecord = {
  readonly failing: readonly string[];
  readonly signature: string | undefined;
  readonly treeHash: string;
  readonly checksum: string;
};

export const replayVerdict = (options: { readonly original: StepRecord; readonly replay: StepRecord }): CheckVerdict => {
  const { original, replay } = options;
  const mismatches = [
    original.failing.join('|') !== replay.failing.join('|') ? 'failing tests differ' : undefined,
    original.signature !== replay.signature ? 'failure signature differs' : undefined,
    original.treeHash !== replay.treeHash ? 'file tree differs from the checkpoint record' : undefined,
    original.checksum !== replay.checksum ? 'branch row checksum differs from the ledger record' : undefined,
  ].filter((item): item is string => item !== undefined);
  return mismatches.length === 0
    ? {
        pass: true,
        observed: `${replay.failing.length} failing tests, ${replay.signature ?? 'no signature'}, tree and rows match the step record`,
      }
    : { pass: false, observed: mismatches.join('; ') };
};

export const countVerdict = (options: { readonly emitted: number; readonly visible: number }): CheckVerdict =>
  options.emitted === options.visible
    ? { pass: true, observed: `${options.visible} of ${options.emitted} emitted events visible in Lake` }
    : { pass: false, observed: `${options.visible} visible in Lake but ${options.emitted} emitted` };
