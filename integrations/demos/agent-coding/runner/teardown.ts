import { homedir } from 'node:os';
import { join } from 'node:path';
import { branches, createLakeClient, lakeConfigFromEnv, runCli } from '@lab/agent-stack-kit';
import { emptyState } from './src/state';
import { readState } from './src/stateStore';
import { lakeTeardownStatements } from './src/lakeSql';
import { buildTeardownPlan } from './src/teardownPlan';

const env = process.env;

const need = (name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const main = async (): Promise<void> => {
  const destroyInstances = process.argv.includes('--destroy-instances');
  const workDir = env.WORK_DIR === undefined || env.WORK_DIR === '' ? join(homedir(), 'lab-agent-coding-work') : env.WORK_DIR;
  const state = (await readState(join(workDir, 'state.json'))) ?? emptyState('none');
  const fixtureClusterId = need('AGENT_FIXTURE_CLUSTER_ID');
  const listed = await branches.list({ clusterId: fixtureClusterId }).catch(() => []);
  const plan = buildTeardownPlan({
    state,
    fixtureClusterId,
    fixtureBranchIds: listed.map((branch) => branch.branchId),
    orgClusterId: need('AGENT_ORG_CLUSTER_ID'),
    fileSystemId: need('TI_FS_FILE_SYSTEM_ID'),
    bucket: need('S3_BUCKET'),
    prefix: env.S3_PREFIX === undefined || env.S3_PREFIX === '' ? 'agent-coding' : env.S3_PREFIX,
    destroyInstances,
  });
  const failures = await plan.reduce<Promise<number>>(async (previous, step) => {
    const failed = await previous;
    const result = await runCli({ bin: step.bin, args: step.args });
    console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${step.label}${result.code === 0 ? '' : `: ${result.stderr.trim()}`}`);
    return failed + (result.code === 0 ? 0 : 1);
  }, Promise.resolve(0));

  const lake = createLakeClient(lakeConfigFromEnv({ ...env, LAKE_DATABASE: 'default' }));
  const lakeFailures = await lakeTeardownStatements({
    warehouse: need('LAKE_WAREHOUSE'),
    database: env.LAKE_DATABASE === undefined || env.LAKE_DATABASE === '' ? 'agent_coding' : env.LAKE_DATABASE,
  }).reduce<Promise<number>>(async (previous, sql) => {
    const failed = await previous;
    try {
      await lake.query(sql);
      console.log(`ok   ${sql}`);
      return failed;
    } catch (error) {
      console.log(`FAIL ${sql}: ${message(error)}`);
      return failed + 1;
    }
  }, Promise.resolve(0));

  console.log(`teardown finished with ${failures + lakeFailures} failed steps`);
  if (failures + lakeFailures > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(message(error));
  process.exitCode = 1;
});
