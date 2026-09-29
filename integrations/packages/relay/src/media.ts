import { cp, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { CatalogMedia, MediaGroup, MediaScreenshot, MediaVideo } from '@lab/contract';
import { readdirOptional } from './demo-files';

const SCREENSHOT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

const isScreenshot = (name: string): boolean => SCREENSHOT_EXTENSIONS.has(extname(name).toLowerCase());

const isVideo = (name: string): boolean => extname(name).toLowerCase() === '.mp4';

const capitalize = (word: string): string => (word.length === 0 ? word : `${word[0]?.toUpperCase()}${word.slice(1)}`);

const stripPrefixAndExt = (filename: string): string => filename.replace(/^\d+-/, '').replace(extname(filename), '');

export const captionFromFilename = (filename: string): string => {
  const slug = stripPrefixAndExt(filename);
  if (slug === 'start') return 'Start';
  if (slug === 'end') return 'End';
  if (slug.startsWith('phase-')) return `Phase: ${slug.slice('phase-'.length)}`;
  const checkMatch = /^check-(.+)-(pass|fail)$/.exec(slug);
  if (checkMatch !== null) return `Check ${checkMatch[1]}: ${checkMatch[2]}`;
  return capitalize(slug.split('-').join(' '));
};

export const titleFromFilename = (filename: string, id: string): string => {
  const withoutExt = filename.replace(extname(filename), '');
  const withoutId = withoutExt.startsWith(`${id}-`) ? withoutExt.slice(id.length + 1) : withoutExt;
  const words = withoutId.split('-').filter((word) => word !== '');
  return words.length === 0 ? withoutExt : capitalize(words.join(' '));
};

type ScreenshotFile = { readonly name: string; readonly subdir: string; readonly group: MediaGroup };

const listScreenshots = async (mediaDir: string, subdir: string, group: MediaGroup): Promise<readonly ScreenshotFile[]> =>
  (await readdirOptional(join(mediaDir, subdir)))
    .filter(isScreenshot)
    .sort()
    .map((name) => ({ name, subdir, group }));

const listVideoNames = async (mediaDir: string): Promise<readonly string[]> =>
  (await readdirOptional(mediaDir)).filter(isVideo).sort();

const copyScreenshot = async (mediaDir: string, destDir: string, file: ScreenshotFile): Promise<void> => {
  await mkdir(join(destDir, file.subdir), { recursive: true });
  await cp(join(mediaDir, file.subdir, file.name), join(destDir, file.subdir, file.name));
};

export type DemoMedia = { readonly media: CatalogMedia | undefined; readonly copy: (outRoot: string) => Promise<void> };

export const collectDemoMedia = async (options: { readonly demoDir: string; readonly id: string }): Promise<DemoMedia> => {
  const mediaDir = join(options.demoDir, 'media');
  const videoNames = await listVideoNames(mediaDir);
  const screenshotFiles = [
    ...(await listScreenshots(mediaDir, 'screenshots', 'console')),
    ...(await listScreenshots(mediaDir, 'replay', 'replay')),
  ];
  if (videoNames.length === 0 && screenshotFiles.length === 0) {
    return { media: undefined, copy: async () => undefined };
  }
  const videos: MediaVideo[] = videoNames.map((name) => ({
    src: `data/media/${options.id}/${name}`,
    title: titleFromFilename(name, options.id),
  }));
  const screenshots: MediaScreenshot[] = screenshotFiles.map((file) => ({
    src: `data/media/${options.id}/${file.subdir}/${file.name}`,
    caption: captionFromFilename(file.name),
    group: file.group,
  }));
  const copy = async (outRoot: string): Promise<void> => {
    const destDir = join(outRoot, 'media', options.id);
    await mkdir(destDir, { recursive: true });
    await Promise.all([
      ...videoNames.map((name) => cp(join(mediaDir, name), join(destDir, name))),
      ...screenshotFiles.map((file) => copyScreenshot(mediaDir, destDir, file)),
    ]);
  };
  return { media: { videos, screenshots }, copy };
};
