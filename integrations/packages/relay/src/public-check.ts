import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readOptional } from './demo-files';

export type Finding = { readonly file: string; readonly line: number; readonly match: string };

export const INTERNAL_URL_PATTERNS: readonly RegExp[] = [
  /feishu\.cn/i,
  /larksuite\.com/i,
  /larkoffice\.com/i,
  /docs\.google\.com/i,
  /drive\.google\.com/i,
  /\.slack\.com/i,
  /atlassian\.net/i,
  /pingcap\.net/i,
];

const SKIPPED = /\.(png|jpe?g|gif|webp|ico|pdf|mp4|mov|woff2?)$|(^|\/)pnpm-lock\.yaml$/i;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const parseDenylist = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

export const isScannable = (file: string): boolean => !SKIPPED.test(file);

export const scanText = (options: {
  readonly file: string;
  readonly text: string;
  readonly denylist: readonly string[];
}): readonly Finding[] => {
  const patterns = [
    ...options.denylist.map((term, index) => ({ label: `denylist entry ${index + 1}`, pattern: new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i') })),
    ...INTERNAL_URL_PATTERNS.map((pattern) => ({ label: `internal URL ${pattern.source}`, pattern })),
  ];
  return options.text.split('\n').flatMap((content, index) =>
    patterns.filter(({ pattern }) => pattern.test(content)).map(({ label }) => ({ file: options.file, line: index + 1, match: label })),
  );
};

export const resolveDenylist = async (env: NodeJS.ProcessEnv): Promise<readonly string[] | undefined> => {
  if (env.LAB_DENYLIST !== undefined && env.LAB_DENYLIST.trim() !== '') return parseDenylist(env.LAB_DENYLIST);
  const text = await readOptional(env.LAB_DENYLIST_FILE ?? join(homedir(), '.config', 'tidb-lab', 'denylist.txt'));
  return text === undefined ? undefined : parseDenylist(text);
};

export const listPublishableFiles = async (root: string): Promise<readonly string[]> => {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\0').filter((file) => file !== '' && isScannable(file));
};
