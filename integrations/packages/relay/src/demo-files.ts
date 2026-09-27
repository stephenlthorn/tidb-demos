import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { DemoManifestSchema, TraceSchema, type DemoManifest, type Trace } from '@lab/contract';

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

export const loadManifest = async (dir: string): Promise<DemoManifest> =>
  DemoManifestSchema.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));

export const loadDemoEnv = async (dir: string): Promise<Readonly<Record<string, string>>> => {
  const text = await readOptional(join(dir, '.env'));
  return text === undefined ? {} : parse(text);
};

export const loadFeaturedTrace = async (dir: string): Promise<Trace | undefined> => {
  const text = await readOptional(join(dir, 'traces', 'featured.json'));
  return text === undefined ? undefined : TraceSchema.parse(JSON.parse(text));
};

export const listDemoIds = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(join(root, 'demos'), { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const withManifest = await Promise.all(
    candidates.map(async (id) => ((await readOptional(join(root, 'demos', id, 'manifest.json'))) === undefined ? undefined : id)),
  );
  return withManifest.filter((id): id is string => id !== undefined).sort();
};
