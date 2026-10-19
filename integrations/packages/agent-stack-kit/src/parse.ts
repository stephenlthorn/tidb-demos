export type ParsedBranch = { readonly branchId: string; readonly state: string };

export type BranchInfo = ParsedBranch & {
  readonly host?: string;
  readonly port?: number;
  readonly userPrefix?: string;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const findValue = <T>(
  value: unknown,
  keys: readonly string[],
  accept: (candidate: unknown) => candidate is T,
): T | undefined => {
  if (isList(value)) return value.map((item) => findValue(item, keys, accept)).find((found) => found !== undefined);
  if (!isRecord(value)) return undefined;
  const direct = keys.map((key) => value[key]).find(accept);
  if (direct !== undefined) return direct;
  return Object.values(value)
    .map((child) => findValue(child, keys, accept))
    .find((found) => found !== undefined);
};

const isNonEmptyString = (candidate: unknown): candidate is string => typeof candidate === 'string' && candidate !== '';
const isBoolean = (candidate: unknown): candidate is boolean => typeof candidate === 'boolean';
const isFiniteNumber = (candidate: unknown): candidate is number =>
  typeof candidate === 'number' && Number.isFinite(candidate);

const findString = (value: unknown, keys: readonly string[]): string | undefined =>
  findValue(value, keys, isNonEmptyString);

const labelled = (stdout: string, label: string): string | undefined =>
  new RegExp(`${label}["']?\\s*[:=]\\s*["']?([A-Za-z0-9_.-]+)`, 'i').exec(stdout)?.[1];

const unrecognised = (what: string, stdout: string): Error =>
  new Error(`${what} not found in output: ${stdout.slice(0, 200)}`);

export const parseLayerId = (stdout: string): string => {
  const found = findString(parseJson(stdout), ['layer_id', 'layerId', 'id']) ?? labelled(stdout, 'layer[_ ]?id');
  if (found === undefined) throw unrecognised('layer id', stdout);
  return found;
};

export const parseCheckpoint = (stdout: string): { readonly checkpointId: string } => {
  const found =
    findString(parseJson(stdout), ['checkpoint_id', 'checkpointId', 'id']) ?? labelled(stdout, 'checkpoint[_ ]?id');
  if (found === undefined) throw unrecognised('checkpoint id', stdout);
  return { checkpointId: found };
};

const diffListKeys: readonly string[] = ['changes', 'entries', 'diff', 'items', 'paths', 'files'];

const diffEntries = (value: unknown): readonly unknown[] => {
  if (isList(value)) return value;
  if (!isRecord(value)) return [];
  const listed = diffListKeys.map((key) => value[key]).find(isList);
  if (listed !== undefined) return listed;
  return Object.values(value).flatMap((child) => (isRecord(child) ? diffEntries(child) : []));
};

const entryPath = (entry: unknown): string | undefined =>
  isNonEmptyString(entry) ? entry : findString(entry, ['path', 'file_path', 'filePath']);

const textPaths = (stdout: string): readonly string[] =>
  stdout
    .split('\n')
    .map((line) => /(\/\S+)\s*$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined);

const sortedUnique = (paths: readonly string[]): readonly string[] => [...new Set(paths)].sort();

export const parseLayerDiff = (stdout: string): readonly string[] => {
  const parsed = parseJson(stdout);
  if (parsed === undefined) return sortedUnique(textPaths(stdout));
  return sortedUnique(diffEntries(parsed).map(entryPath).filter((path): path is string => path !== undefined));
};

const verifyFlagKeys: readonly string[] = ['ok', 'valid', 'verified', 'is_valid', 'chain_valid'];

export const parseJournalVerify = (stdout: string): { readonly ok: boolean } => {
  const parsed = parseJson(stdout);
  const flag = findValue(parsed, verifyFlagKeys, isBoolean);
  if (flag !== undefined) return { ok: flag };
  const status = findString(parsed, ['status', 'result']);
  if (status !== undefined) return { ok: /^(ok|valid|verified|pass|passed|success)$/i.test(status) };
  if (/\b(invalid|broken|mismatch|failed|tamper)/i.test(stdout)) return { ok: false };
  if (/\b(valid|verified|ok)\b/i.test(stdout)) return { ok: true };
  throw unrecognised('journal verification result', stdout);
};

const branchIdKeys: readonly string[] = ['branchId', 'branch_id', 'branchID', 'id'];

export const parseBranch = (stdout: string): ParsedBranch => {
  const parsed = parseJson(stdout);
  const branchId =
    findString(parsed, branchIdKeys) ?? labelled(stdout, 'branch[ _-]?id') ?? labelled(stdout, '\\bid');
  if (branchId === undefined) throw unrecognised('branch id', stdout);
  const state = findString(parsed, ['state', 'status']) ?? labelled(stdout, '\\bstate') ?? 'UNKNOWN';
  return { branchId, state };
};

const branchFrom = (entry: unknown): BranchInfo | undefined => {
  const branchId = findString(entry, branchIdKeys);
  if (branchId === undefined) return undefined;
  return {
    branchId,
    state: findString(entry, ['state', 'status']) ?? 'UNKNOWN',
    host: findString(entry, ['host']),
    port: findValue(entry, ['port'], isFiniteNumber),
    userPrefix: findString(entry, ['userPrefix', 'user_prefix']),
  };
};

export const parseBranchList = (stdout: string): readonly BranchInfo[] => {
  const parsed = parseJson(stdout);
  if (parsed === undefined) throw unrecognised('branch list', stdout);
  const listed = isRecord(parsed) ? [parsed.branches, parsed.items, parsed.data].find(isList) : undefined;
  const entries = isList(parsed) ? parsed : (listed ?? []);
  return entries.map(branchFrom).filter((branch): branch is BranchInfo => branch !== undefined);
};
