import { branches, tiFs } from '@lab/agent-stack-kit';
import { createTidbPool } from '@lab/runner-kit';
import { loadConfig } from './src/config';
import { FILE_SYSTEM_ROOT } from './src/journal';
import { teardownStatements } from './src/lakeSql';
import { errorMessage } from './src/live/context';
import { runOrThrow } from './src/live/cli';
import { connectLake } from './src/live/lake';
import { rowsOf } from './src/starter';

const config = loadConfig(process.env);
const pool = createTidbPool(process.env);

const attempt = async (label: string, task: () => Promise<unknown>): Promise<void> => {
  try {
    await task();
    console.log(`ok      ${label}`);
  } catch (error) {
    console.log(`skipped ${label}: ${errorMessage(error)}`);
  }
};

const run = async (): Promise<void> => {
  const cases = await rowsOf(pool, 'SELECT case_id, layer_id, branch_id FROM cases ORDER BY case_id DESC').catch(() => []);
  await cases.reduce(async (previous, row) => {
    await previous;
    await attempt(`delete branch ${String(row.branch_id)}`, () =>
      branches.remove({ clusterId: config.clusterId, branchId: String(row.branch_id) }),
    );
    await attempt(`delete layer ${String(row.layer_id)}`, () =>
      tiFs.deleteLayer({ layerRef: String(row.layer_id), cascade: true }),
    );
  }, Promise.resolve());
  const remaining = await branches.list({ clusterId: config.clusterId }).catch(() => []);
  await remaining.reduce(async (previous, branch) => {
      await previous;
      await attempt(`delete leftover branch ${branch.branchId}`, () =>
        branches.remove({ clusterId: config.clusterId, branchId: branch.branchId }),
      );
    }, Promise.resolve());
  await attempt(`delete ${FILE_SYSTEM_ROOT}`, () =>
    runOrThrow({ bin: 'ti', args: ['fs', 'delete-file', '--path', FILE_SYSTEM_ROOT, '--recursive'] }),
  );
  const lake = connectLake(process.env);
  await teardownStatements.reduce(async (previous, sql) => {
    await previous;
    await attempt(sql, () => lake.query(sql));
  }, Promise.resolve());
  console.log('Next: empty and delete the S3 bucket, revoke the IAM user, stop the Lake warehouse, delete the Starter instance and the file system.');
};

run()
  .catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(() => {
    void Promise.race([pool.end(), new Promise((resolve) => setTimeout(resolve, 3000))]).then(() =>
      process.exit(process.exitCode ?? 0),
    );
  });
