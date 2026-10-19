import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { branches, rfc3339Second, tiFs } from '@lab/agent-stack-kit';
import { branchEnv, branchUser } from './src/branchEnv';
import { createTidbPool, timed } from '@lab/runner-kit';
import { loadConfig } from './src/config';
import { PastCasesSchema } from './src/fixtures';
import { skillsPath } from './src/journal';
import { errorMessage } from './src/live/context';
import {
  appendCaseJournal,
  makeDirectory,
  readBaseFile,
  seedFileSystem,
  writeLayerFile,
} from './src/live/filesystem';
import { connectLake, countRows, setupLake } from './src/live/lake';
import { buildRecallQuery } from './src/recallSql';
import { ensureSchema, execute, recall, rowsOf } from './src/starter';
import { episodicInsert } from './src/starterSql';

const fixturesDirectory = fileURLToPath(new URL('./fixtures', import.meta.url));
const config = loadConfig(process.env);
const out = (line: string): void => console.log(line);

const smokeFileSystem = async (): Promise<void> => {
  await seedFileSystem(fixturesDirectory);
  const smokePath = '/harbor/smoke';
  await makeDirectory(smokePath);
  const layer = await tiFs.createLayer({ baseRootPath: smokePath, layerName: 'smoke-layer' });
  out(`layer-created ${layer.layerId}`);
  await writeLayerFile({ layerId: layer.layerId, remotePath: `${smokePath}/note.md`, content: 'smoke\n' });
  const diff = await tiFs.diffLayer({ layerId: layer.layerId });
  out(`diff-changes ${diff.length}`);
  const before = await readBaseFile(`${smokePath}/note.md`).then(
    () => 'present',
    () => 'absent',
  );
  out(`base-before-commit ${before}`);
  const commit = await timed(() => tiFs.commitLayer({ layerId: layer.layerId }));
  out(`commit-ms ${commit.ms.toFixed(0)}`);
  const after = await readBaseFile(`${smokePath}/note.md`).then(
    () => 'present',
    () => 'absent',
  );
  out(`base-after-commit ${after}`);
  await tiFs.createJournal({ journalId: 'jrn-smoke', journalKind: 'smoke', title: 'smoke journal' });
  await appendCaseJournal({ caseId: 'SMOKE', type: 'smoke.checked', summary: 'one entry' });
  const verified = await tiFs.verifyJournal({ journalId: 'jrn-smoke' });
  out(`journal-verify ${verified.ok ? 'ok' : 'failed'}`);
  await tiFs.deleteLayer({ layerRef: layer.layerId });
  out(`skills-seeded ${(await readBaseFile(`${skillsPath}/structuring-triage.md`)).split('\n')[0]}`);
};

const smokeBranch = async (): Promise<void> => {
  const startedAt = Date.now();
  const created = await branches.create({
    clusterId: config.clusterId,
    name: 'aml-smoke',
    parentTimestamp: rfc3339Second(new Date(Date.now() - 60_000)),
  });
  out(`branch-created ${created.branchId}`);
  const endpoint = await branches.waitActive({ clusterId: config.clusterId, branchId: created.branchId, timeoutMs: 15 * 60_000 });
  out(`branch-create-seconds ${((Date.now() - startedAt) / 1000).toFixed(0)}`);
  if (endpoint.host === undefined || endpoint.port === undefined) throw new Error('branch reported no host or port');
  const pool = createTidbPool(
    branchEnv({
      base: process.env,
      host: endpoint.host,
      port: endpoint.port,
      user: branchUser({ userPrefix: endpoint.userPrefix, user: process.env.TIDB_USER ?? '' }),
      password: config.branchPassword === '' ? (process.env.TIDB_PASSWORD ?? '') : config.branchPassword,
      database: process.env.TIDB_DATABASE ?? 'harbor_core',
    }),
  );
  try {
    const [row] = await rowsOf(pool, 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    out(`branch-tables ${String(row?.n)}`);
  } finally {
    await pool.end();
    await branches.remove({ clusterId: config.clusterId, branchId: created.branchId });
    out('branch-removed');
  }
};

const smokeLake = async (): Promise<void> => {
  const lake = connectLake(process.env);
  await setupLake(lake, config);
  out('lake-setup-ok');
  const tables = ['txn_history', 'ground_truth', 'flag_log', 'run_events'];
  await tables.reduce(async (previous, table) => {
    await previous;
    out(`lake-${table} ${await countRows(lake, `SELECT COUNT(*) AS n FROM harbor.${table}`)}`);
  }, Promise.resolve());
};

const smokeRecall = async (): Promise<void> => {
  const pool = createTidbPool(process.env);
  try {
    await ensureSchema(pool, false);
    const [existing] = await rowsOf(pool, 'SELECT COUNT(*) AS n FROM episodic_memory');
    if (Number(existing?.n ?? 0) === 0) {
      const cases = PastCasesSchema.parse(JSON.parse(readFileSync(`${fixturesDirectory}/past-cases.json`, 'utf8')));
      await execute(pool, episodicInsert(cases));
    }
    const query = buildRecallQuery({ pattern: 'structuring', accountKind: 'retail', distinctBranches: 3 });
    const { value, ms } = await timed(() => recall(pool, query));
    out(`recall-ms ${ms.toFixed(0)}`);
    out(`recall-top ${value.map((hit) => hit.caseId).join(',')}`);
  } finally {
    await pool.end();
  }
};

const commands: Readonly<Record<string, () => Promise<void>>> = {
  fs: smokeFileSystem,
  branch: smokeBranch,
  lake: smokeLake,
  recall: smokeRecall,
};

const main = async (): Promise<void> => {
  const name = process.argv[2] ?? '';
  const command = commands[name];
  if (command === undefined) throw new Error(`usage: smoke.ts ${Object.keys(commands).join('|')}`);
  await command();
};

main()
  .catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
