export type JournalEntry = {
  readonly type: string;
  readonly subjects: readonly string[];
  readonly summary: string;
  readonly idempotencyKey: string;
};

const entryTypePattern = /^[a-z][a-z0-9_.-]*$/;

export const FILE_SYSTEM_ROOT = '/harbor';

export const casePathFor = (caseId: string): string => `${FILE_SYSTEM_ROOT}/cases/${caseId}`;

export const skillsPath = `${FILE_SYSTEM_ROOT}/skills`;

export const layerNameFor = (caseId: string): string => `case-${caseId.toLowerCase()}`;

export const journalIdFor = (caseId: string): string => `jrn-${caseId.toLowerCase()}`;

export const branchNameFor = (caseId: string): string => `aml-${caseId.toLowerCase()}`;

export const agentIdFor = (caseId: string): string => `aml-agent-${caseId.toLowerCase()}`;

export const journalEntry = (options: {
  readonly caseId: string;
  readonly type: string;
  readonly summary: string;
}): JournalEntry => {
  if (!entryTypePattern.test(options.type)) throw new Error(`invalid journal entry type: ${options.type}`);
  return {
    type: options.type,
    subjects: [`case:${options.caseId}`],
    summary: options.summary,
    idempotencyKey: `${options.caseId}:${options.type}`,
  };
};
