import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAttemptScript, type AttemptScript } from './scripts';

export const loadAttemptScripts = async (fixturesDir: string): Promise<readonly AttemptScript[]> => {
  const directory = join(fixturesDir, 'attempts');
  const names = (await readdir(directory)).filter((name) => /^attempt-[0-9]+\.json$/.test(name)).sort();
  return Promise.all(
    names.map(async (name) => parseAttemptScript(JSON.parse(await readFile(join(directory, name), 'utf8')))),
  );
};
