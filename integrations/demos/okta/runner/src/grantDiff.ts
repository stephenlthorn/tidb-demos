import type { DbRole } from './groupRoleMap';

export type DesiredAssignment = {
  readonly username: string;
  readonly role: DbRole | null;
};

export type ActualAssignment = {
  readonly username: string;
  readonly role: DbRole | null;
  readonly exists: boolean;
};

export type DriftKind = 'missing_user' | 'wrong_role' | 'orphan_user';

export type Drift = {
  readonly username: string;
  readonly kind: DriftKind;
  readonly desiredRole: DbRole | null;
  readonly actualRole: DbRole | null;
};

export const findDrift = (
  desired: readonly DesiredAssignment[],
  actual: readonly ActualAssignment[],
): readonly Drift[] => {
  const actualByUser = new Map(actual.map((entry) => [entry.username, entry]));
  const desiredByUser = new Map(desired.map((entry) => [entry.username, entry]));

  const desiredDrift = desired.flatMap((entry): readonly Drift[] => {
    const found = actualByUser.get(entry.username);
    if (found === undefined || !found.exists) {
      return entry.role === null
        ? []
        : [{ username: entry.username, kind: 'missing_user', desiredRole: entry.role, actualRole: null }];
    }
    if (found.role !== entry.role) {
      return [{ username: entry.username, kind: 'wrong_role', desiredRole: entry.role, actualRole: found.role }];
    }
    return [];
  });

  const orphanDrift = actual.flatMap((entry): readonly Drift[] => {
    if (!entry.exists) {
      return [];
    }
    const desiredEntry = desiredByUser.get(entry.username);
    if (desiredEntry !== undefined && desiredEntry.role !== null) {
      return [];
    }
    return [{ username: entry.username, kind: 'orphan_user', desiredRole: null, actualRole: entry.role }];
  });

  return [...desiredDrift, ...orphanDrift];
};
