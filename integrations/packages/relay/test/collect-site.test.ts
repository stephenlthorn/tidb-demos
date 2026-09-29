import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aManifest, manifestInput } from '@lab/contract/testing';
import { buildCatalog, collectSite } from '../src/collect-site';

const kafkaDemo = { manifest: aManifest({ id: 'kafka', number: 2, title: 'Kafka' }), hasFeaturedTrace: true };
const demos = [
  kafkaDemo,
  { manifest: aManifest({ id: 'example', number: 0, publish: false }), hasFeaturedTrace: true },
  { manifest: aManifest({ id: 'aws-dms', number: 1, title: 'DMS' }), hasFeaturedTrace: false },
];

describe('buildCatalog', () => {
  it('lists published demos in number order', () => {
    expect(buildCatalog(demos, false).map((entry) => [entry.id, entry.hasReplay])).toEqual([
      ['aws-dms', false],
      ['kafka', true],
    ]);
  });

  it('includes unpublished demos only when asked', () => {
    expect(buildCatalog(demos, true).map((entry) => entry.id)).toEqual(['example', 'aws-dms', 'kafka']);
  });

  it('omits the media field when a demo has no media', () => {
    const [entry] = buildCatalog([kafkaDemo], false);
    expect(entry?.media).toBeUndefined();
  });

  it('includes the media field when a demo has media', () => {
    const media = { videos: [{ src: 'data/media/kafka/kafka.mp4', title: 'Kafka' }], screenshots: [] };
    const [entry] = buildCatalog([{ ...kafkaDemo, media }], false);
    expect(entry?.media).toEqual(media);
  });
});

describe('collectSite', () => {
  it('copies published media into the site output and excludes raw-capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lab-site-'));
    const demoDir = join(root, 'demos', 'okta');
    await mkdir(join(demoDir, 'media', 'screenshots'), { recursive: true });
    await mkdir(join(demoDir, 'media', 'raw-capture', 'raw'), { recursive: true });
    await writeFile(join(demoDir, 'manifest.json'), JSON.stringify(manifestInput({ id: 'okta', number: 5 })));
    await writeFile(join(demoDir, 'media', 'okta-live.mp4'), 'video-bytes');
    await writeFile(join(demoDir, 'media', 'pages.json'), '{}');
    await writeFile(join(demoDir, 'media', 'screenshots', '01-start.jpg'), 'jpg-bytes');
    await writeFile(join(demoDir, 'media', 'raw-capture', 'contact.png'), 'raw-bytes');

    const catalog = await collectSite({ root, includeUnpublished: false });

    expect(catalog[0]?.media).toEqual({
      videos: [{ src: 'data/media/okta/okta-live.mp4', title: 'Live' }],
      screenshots: [{ src: 'data/media/okta/screenshots/01-start.jpg', caption: 'Start', group: 'console' }],
    });
    const mediaOut = join(root, 'packages', 'ui', 'public', 'data', 'media', 'okta');
    expect((await readdir(mediaOut)).sort()).toEqual(['okta-live.mp4', 'screenshots']);
    expect(await readFile(join(mediaOut, 'okta-live.mp4'), 'utf8')).toBe('video-bytes');
  });
});
