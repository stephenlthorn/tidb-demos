import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tiFs } from '@lab/agent-stack-kit';
import {
  FILE_SYSTEM_ROOT,
  agentIdFor,
  casePathFor,
  journalEntry,
  journalIdFor,
  layerNameFor,
  skillsPath,
} from '../journal';
import { runOrThrow } from './cli';

export const SYNTHETIC_SECRET_NAME = 'watchlist-api';
export const SYNTHETIC_SECRET_FIELD = 'KEY';
export const SYNTHETIC_SECRET_VALUE = 'SYNTHETIC-WATCHLIST-KEY-NOT-REAL';

const ti = (args: readonly string[]) => runOrThrow({ bin: 'ti', args });

const withTempFile = async <T>(content: string, use: (localPath: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'aml-'));
  try {
    const localPath = join(directory, 'payload');
    await writeFile(localPath, content, 'utf8');
    return await use(localPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const makeDirectory = async (path: string): Promise<void> => {
  try {
    await ti(['fs', 'create-directory', '--path', path]);
  } catch (error) {
    if (!/exist/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
};

export const writeBaseFile = (options: { readonly remotePath: string; readonly content: string }): Promise<unknown> =>
  withTempFile(options.content, (localPath) =>
    ti(['fs', 'copy-file', '--from-local', localPath, '--to-remote', options.remotePath, '--overwrite']),
  );

export const writeLayerFile = (options: {
  readonly layerId: string;
  readonly remotePath: string;
  readonly content: string;
}): Promise<unknown> =>
  withTempFile(options.content, (localPath) =>
    ti([
      'fs',
      'copy-file',
      '--from-local',
      localPath,
      '--to-remote',
      options.remotePath,
      '--layer-id',
      options.layerId,
      '--overwrite',
    ]),
  );

export const readBaseFile = async (path: string): Promise<string> => (await ti(['fs', 'read-file', '--path', path])).stdout;

export const seedFileSystem = async (fixturesDirectory: string): Promise<void> => {
  await makeDirectory(FILE_SYSTEM_ROOT);
  await makeDirectory(`${FILE_SYSTEM_ROOT}/cases`);
  await makeDirectory(skillsPath);
  const skillsDirectory = join(fixturesDirectory, 'skills');
  const files = await readdir(skillsDirectory);
  await files.reduce(async (previous, file) => {
    await previous;
    await writeBaseFile({
      remotePath: `${skillsPath}/${file}`,
      content: await readFile(join(skillsDirectory, file), 'utf8'),
    });
  }, Promise.resolve());
};

export const seedVaultSecret = (): Promise<unknown> =>
  withTempFile(SYNTHETIC_SECRET_VALUE, (localPath) =>
    ti(['fs-vault', 'create-secret', '--secret-name', SYNTHETIC_SECRET_NAME, '--field', `${SYNTHETIC_SECRET_FIELD}=@${localPath}`]),
  );

export type CaseWorkspace = {
  readonly layerId: string;
  readonly journalId: string;
  readonly grantToken: string;
};

export const openCaseWorkspace = async (caseId: string): Promise<CaseWorkspace> => {
  await makeDirectory(casePathFor(caseId));
  const layer = await tiFs.createLayer({
    baseRootPath: casePathFor(caseId),
    layerName: layerNameFor(caseId),
    tags: { case: caseId },
  });
  const journalId = journalIdFor(caseId);
  await tiFs.createJournal({ journalId, journalKind: 'aml-case', title: `Investigation ${caseId}` });
  const grant = await tiFs.createGrant({
    agentId: agentIdFor(caseId),
    scope: `${SYNTHETIC_SECRET_NAME}/${SYNTHETIC_SECRET_FIELD}`,
    permission: 'read',
    ttl: '10m',
  });
  return { layerId: layer.layerId, journalId, grantToken: grant };
};

export const readSecretWithGrant = async (grantToken: string): Promise<string> =>
  (
    await runOrThrow({
      bin: 'ti',
      args: ['fs-vault', 'read-secret', '--secret-name', SYNTHETIC_SECRET_NAME, '--field', SYNTHETIC_SECRET_FIELD, '--format', 'raw'],
      env: { TI_VAULT_TOKEN: grantToken },
    })
  ).stdout.trim();

export const appendCaseJournal = (options: {
  readonly caseId: string;
  readonly type: string;
  readonly summary: string;
}): Promise<void> => {
  const entry = journalEntry(options);
  return tiFs.appendJournal({
    journalId: journalIdFor(options.caseId),
    entry: { type: entry.type, subjects: entry.subjects, summary: entry.summary },
    idempotencyKey: entry.idempotencyKey,
  });
};
