export type DbRole = 'analyst' | 'engineer';

type GroupRoleEntry = {
  readonly group: string;
  readonly role: DbRole;
};

const GROUP_ROLE_PRECEDENCE: readonly GroupRoleEntry[] = [
  { group: 'lab_engineers', role: 'engineer' },
  { group: 'lab_analysts', role: 'analyst' },
];

export const roleForGroups = (groupNames: readonly string[]): DbRole | null => {
  const match = GROUP_ROLE_PRECEDENCE.find((entry) => groupNames.includes(entry.group));
  return match === undefined ? null : match.role;
};
