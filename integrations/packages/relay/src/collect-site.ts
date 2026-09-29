import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogEntry, CatalogMedia, DemoManifest } from '@lab/contract';
import { listDemoIds, loadFeaturedTrace, loadManifest } from './demo-files';
import { collectDemoMedia } from './media';
import { demoDir } from './paths';

export type DemoSummary = {
  readonly manifest: DemoManifest;
  readonly hasFeaturedTrace: boolean;
  readonly media?: CatalogMedia;
};

export const buildCatalog = (demos: readonly DemoSummary[], includeUnpublished: boolean): readonly CatalogEntry[] =>
  demos
    .filter((demo) => includeUnpublished || demo.manifest.publish)
    .map(({ manifest, hasFeaturedTrace, media }) => ({
      id: manifest.id,
      number: manifest.number,
      title: manifest.title,
      tagline: manifest.tagline,
      integrations: manifest.integrations,
      hasReplay: hasFeaturedTrace,
      ...(media === undefined ? {} : { media }),
    }))
    .sort((a, b) => a.number - b.number);

const writeJson = (path: string, value: unknown): Promise<void> => writeFile(path, `${JSON.stringify(value)}\n`);

export const collectSite = async (options: { readonly root: string; readonly includeUnpublished: boolean }): Promise<readonly CatalogEntry[]> => {
  const ids = await listDemoIds(options.root);
  const demos = await Promise.all(
    ids.map(async (id) => {
      const dir = demoDir(options.root, id);
      const [manifest, trace, mediaResult] = await Promise.all([
        loadManifest(dir),
        loadFeaturedTrace(dir),
        collectDemoMedia({ demoDir: dir, id }),
      ]);
      return { manifest, trace, mediaResult };
    }),
  );
  const catalog = buildCatalog(
    demos.map(({ manifest, trace, mediaResult }) => ({ manifest, hasFeaturedTrace: trace !== undefined, media: mediaResult.media })),
    options.includeUnpublished,
  );
  const out = join(options.root, 'packages', 'ui', 'public', 'data');
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'manifests'), { recursive: true });
  await mkdir(join(out, 'traces'), { recursive: true });
  const included = demos.filter(({ manifest }) => catalog.some((entry) => entry.id === manifest.id));
  await Promise.all([
    ...included.flatMap(({ manifest, trace }) => [
      writeJson(join(out, 'manifests', `${manifest.id}.json`), manifest),
      ...(trace === undefined ? [] : [writeJson(join(out, 'traces', `${manifest.id}.json`), trace)]),
    ]),
    ...included.flatMap(({ mediaResult }) => (mediaResult.media === undefined ? [] : [mediaResult.copy(out)])),
  ]);
  await writeJson(join(out, 'catalog.json'), catalog);
  return catalog;
};
