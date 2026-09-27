import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestInput } from '@lab/contract/testing';
import { listDemoIds, loadDemoEnv, loadFeaturedTrace, loadManifest } from '../src/demo-files';
import { demoDir } from '../src/paths';

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'lab-'));
  const dir = demoDir(root, 'example');
  await mkdir(join(dir, 'traces'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifestInput()));
  await mkdir(join(root, 'demos', 'no-manifest'), { recursive: true });
  return root;
};

describe('demo files', () => {
  it('loads and validates a manifest', async () => {
    const root = await makeRoot();
    expect((await loadManifest(demoDir(root, 'example'))).id).toBe('example');
  });

  it('returns an empty env when .env is missing', async () => {
    const root = await makeRoot();
    expect(await loadDemoEnv(demoDir(root, 'example'))).toEqual({});
  });

  it('parses .env when present', async () => {
    const root = await makeRoot();
    await writeFile(join(demoDir(root, 'example'), '.env'), 'TIDB_HOST=db.local\nLAB_ENV_TIDB=playground\n');
    expect(await loadDemoEnv(demoDir(root, 'example'))).toEqual({ TIDB_HOST: 'db.local', LAB_ENV_TIDB: 'playground' });
  });

  it('returns undefined when there is no featured trace', async () => {
    const root = await makeRoot();
    expect(await loadFeaturedTrace(demoDir(root, 'example'))).toBeUndefined();
  });

  it('lists only demo folders that have a manifest', async () => {
    const root = await makeRoot();
    expect(await listDemoIds(root)).toEqual(['example']);
  });
});
