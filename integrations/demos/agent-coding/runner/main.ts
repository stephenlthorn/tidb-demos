import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  branches,
  createLakeClient,
  createS3EventSink,
  lakeConfigFromEnv,
  runCli,
  tiFs,
  type BranchInfo,
} from '@lab/agent-stack-kit';
import { createEmitter, createTidbPool, onControl } from '@lab/runner-kit';
import { branchEnv, branchUser } from './src/branchEnv';
import { runConfigFromEnv } from './src/config';
import { errorMessage } from './src/context';
import { loadAttemptScripts } from './src/fixtureStore';
import { createRunner } from './src/runner';
import { fromMysql, type Sql } from './src/sql';
import { writeState } from './src/stateStore';

const env = process.env;
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const config = runConfigFromEnv(env, { fixturesDir, now: new Date(), homeDir: homedir() });
const emitter = createEmitter();

const openBranchPool = (branch: BranchInfo): Sql => {
  if (branch.host === undefined) throw new Error(`branch ${branch.branchId} has no public host in the CLI output`);
  return fromMysql(
    createTidbPool(
      branchEnv({
        base: env,
        host: branch.host,
        port: branch.port ?? 4000,
        user: branchUser({ userPrefix: branch.userPrefix, user: config.branchSqlUser }),
        password: config.branchSqlPassword,
        database: config.fixtureDatabase,
      }),
    ),
  );
};

const main = async (): Promise<void> => {
  const runner = createRunner({
    config,
    env,
    emitter,
    orgPool: fromMysql(createTidbPool(env)),
    tiFs,
    branches,
    lake: createLakeClient(lakeConfigFromEnv({ ...env, LAKE_DATABASE: config.lakeDatabase })),
    lakeBootstrap: createLakeClient(lakeConfigFromEnv({ ...env, LAKE_DATABASE: 'default' })),
    sink: createS3EventSink({
      bucket: config.bucket,
      prefix: `${config.prefix}/${config.runId}/events`,
      region: config.region,
    }),
    run: runCli,
    scripts: await loadAttemptScripts(fixturesDir),
    sleep: (ms) => delay(ms),
    openBranchPool,
    saveState: (state) => writeState(join(config.workDir, 'state.json'), state),
  });
  onControl((id) => runner.onControl(id));
  const stop = async (code: number): Promise<void> => {
    await runner.shutdown();
    process.exit(code);
  };
  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));
  try {
    await runner.start();
  } catch (error) {
    emitter.log('error', errorMessage(error));
    await stop(1);
  }
};

main().catch((error: unknown) => {
  emitter.log('error', errorMessage(error));
  process.exit(1);
});
