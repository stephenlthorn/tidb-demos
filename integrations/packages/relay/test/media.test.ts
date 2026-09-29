import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captionFromFilename, collectDemoMedia, titleFromFilename } from '../src/media';

describe('captionFromFilename', () => {
  it('captions a phase screenshot', () => {
    expect(captionFromFilename('06-phase-provision.jpg')).toBe('Phase: provision');
  });

  it('captions a check screenshot', () => {
    expect(captionFromFilename('11-check-revoked-user-rejected-pass.jpg')).toBe('Check revoked-user-rejected: pass');
  });

  it('captions start and end', () => {
    expect(captionFromFilename('01-start.jpg')).toBe('Start');
    expect(captionFromFilename('16-end.jpg')).toBe('End');
  });
});

describe('titleFromFilename', () => {
  it('strips the demo id prefix and hyphenates into words', () => {
    expect(titleFromFilename('okta-live-side-by-side.mp4', 'okta')).toBe('Live side by side');
  });
});

const makeMediaDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'lab-media-'));
  const dir = join(root, 'demos', 'okta');
  await mkdir(join(dir, 'media', 'screenshots'), { recursive: true });
  await mkdir(join(dir, 'media', 'raw-capture', 'raw'), { recursive: true });
  await writeFile(join(dir, 'media', 'okta-live-side-by-side.mp4'), 'video-bytes');
  await writeFile(join(dir, 'media', 'pages.json'), '{}');
  await writeFile(join(dir, 'media', 'screenshots', '01-start.jpg'), 'jpg-bytes');
  await writeFile(join(dir, 'media', 'screenshots', '06-phase-provision.jpg'), 'jpg-bytes');
  await writeFile(join(dir, 'media', 'raw-capture', 'contact.png'), 'raw-bytes');
  await writeFile(join(dir, 'media', 'raw-capture', 'raw', 'frames.txt'), 'raw');
  return dir;
};

describe('collectDemoMedia', () => {
  it('returns undefined media when there is no media directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lab-media-'));
    const dir = join(root, 'demos', 'example');
    await mkdir(dir, { recursive: true });
    const result = await collectDemoMedia({ demoDir: dir, id: 'example' });
    expect(result.media).toBeUndefined();
  });

  it('builds videos and screenshots sorted by filename with site-relative src paths', async () => {
    const dir = await makeMediaDir();
    const result = await collectDemoMedia({ demoDir: dir, id: 'okta' });
    expect(result.media).toEqual({
      videos: [{ src: 'data/media/okta/okta-live-side-by-side.mp4', title: 'Live side by side' }],
      screenshots: [
        { src: 'data/media/okta/screenshots/01-start.jpg', caption: 'Start', group: 'console' },
        { src: 'data/media/okta/screenshots/06-phase-provision.jpg', caption: 'Phase: provision', group: 'console' },
      ],
    });
  });

  it('copies only the featured video and screenshots, never raw-capture or pages.json', async () => {
    const dir = await makeMediaDir();
    const result = await collectDemoMedia({ demoDir: dir, id: 'okta' });
    const outRoot = await mkdtemp(join(tmpdir(), 'lab-out-'));
    await result.copy(outRoot);
    const destDir = join(outRoot, 'media', 'okta');
    expect((await readdir(destDir)).sort()).toEqual(['okta-live-side-by-side.mp4', 'screenshots']);
    expect((await readdir(join(destDir, 'screenshots'))).sort()).toEqual(['01-start.jpg', '06-phase-provision.jpg']);
  });
});
