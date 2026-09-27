import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createMonitorClient } from './src/monitorClient';

const MonitorDefinitionSchema = z.record(z.string(), z.unknown());

const demoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const main = async (): Promise<void> => {
  const monitors = createMonitorClient({
    apiKey: process.env.DD_API_KEY ?? '',
    appKey: process.env.DD_APP_KEY ?? '',
    site: process.env.DD_SITE ?? 'datadoghq.com',
  });
  const monitorsDir = join(demoRoot, 'infra', 'monitors');
  const files = (await readdir(monitorsDir)).filter((file) => file.endsWith('.json'));
  const entries = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(monitorsDir, file), 'utf8');
      const definition = MonitorDefinitionSchema.parse(JSON.parse(text));
      const id = await monitors.create(definition);
      return [file.replace('.json', ''), id] as const;
    }),
  );
  const monitorIds = Object.fromEntries(entries);
  await writeFile(join(demoRoot, '.monitor-ids.json'), `${JSON.stringify(monitorIds, null, 2)}\n`);
  entries.forEach(([slug, id]) => console.log(`created monitor ${slug} -> ${id}`));
};

void main();
