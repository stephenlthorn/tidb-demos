import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { collectSite } from './collect-site';
import { runDbInit } from './db-init';
import { loadDemoEnv, loadFeaturedTrace, loadManifest } from './demo-files';
import { demoDir, labRoot } from './paths';
import { listPublishableFiles, resolveDenylist, scanText } from './public-check';
import { runDemo } from './run';
import { validateTrace } from './validate';

const USAGE = 'usage: lab run|validate|db-init <demo-id> [--record] [--port 7070]  |  lab check-public  |  lab collect-site';

const runCommand = async (root: string, id: string, record: boolean, port: number): Promise<number> => {
  const handle = await runDemo({ root, id, record, port });
  console.log(`lab relay for ${id} on ${handle.url}`);
  console.log(`open http://localhost:5173/#/demo/${id}?relay=${handle.url}`);
  process.on('SIGINT', () => handle.stop());
  const result = await handle.finished;
  if (result.tracePath !== undefined) console.log(`recorded trace: ${result.tracePath}`);
  return result.exitCode;
};

const validateCommand = async (root: string, id: string): Promise<number> => {
  const manifest = await loadManifest(demoDir(root, id));
  const trace = await loadFeaturedTrace(demoDir(root, id));
  if (trace === undefined) {
    console.log(`${id}: manifest ok, no featured trace yet`);
    return 0;
  }
  const report = validateTrace(manifest, trace);
  report.warnings.forEach((warning) => console.warn(`warning: ${warning}`));
  report.errors.forEach((error) => console.error(`error: ${error}`));
  console.log(`${id}: manifest ok, featured trace ${report.errors.length === 0 ? 'ok' : 'INVALID'} (${report.eventCount} events)`);
  return report.errors.length === 0 ? 0 : 1;
};

const dbInitCommand = async (root: string, id: string): Promise<number> => {
  const env = { ...process.env, ...(await loadDemoEnv(demoDir(root, id))) };
  const result = await runDbInit(env);
  console.log(`database ${result.database} ready (TiDB ${result.version})`);
  return 0;
};

const checkPublicCommand = async (root: string): Promise<number> => {
  const denylist = await resolveDenylist(process.env);
  if (denylist === undefined) {
    console.error('No denylist. Create ~/.config/tidb-lab/denylist.txt (one customer or prospect name per line) or set LAB_DENYLIST.');
    return 1;
  }
  const files = await listPublishableFiles(root);
  const findings = (await Promise.all(
    files.map(async (file) => scanText({ file, text: await readFile(join(root, file), 'utf8'), denylist })),
  )).flat();
  findings.forEach((finding) => console.error(`${finding.file}:${finding.line}  ${finding.match}`));
  console.log(`check-public: ${files.length} files scanned, ${findings.length} findings`);
  return findings.length === 0 ? 0 : 1;
};

const collectSiteCommand = async (root: string): Promise<number> => {
  const catalog = await collectSite({ root, includeUnpublished: process.env.LAB_INCLUDE_UNPUBLISHED === 'true' });
  console.log(`collect-site: ${catalog.length} demos, ${catalog.filter((entry) => entry.hasReplay).length} with replays`);
  return 0;
};

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const root = labRoot();
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: { record: { type: 'boolean' }, port: { type: 'string' } },
  });
  if (command === 'check-public') return checkPublicCommand(root);
  if (command === 'collect-site') return collectSiteCommand(root);
  const id = positionals[0];
  if (id === undefined) {
    console.error(USAGE);
    return 1;
  }
  if (command === 'run') return runCommand(root, id, values.record === true, Number(values.port ?? '7070'));
  if (command === 'validate') return validateCommand(root, id);
  if (command === 'db-init') return dbInitCommand(root, id);
  console.error(USAGE);
  return 1;
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
