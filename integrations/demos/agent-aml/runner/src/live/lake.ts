import { createLakeClient, lakeConfigFromEnv } from '@lab/agent-stack-kit';
import { sleep, timed } from '@lab/runner-kit';
import type { AmlConfig } from '../config';
import { buildLakeSetupStatements, executeLoadTask } from '../lakeSql';

export type Lake = ReturnType<typeof createLakeClient>;

export const connectLake = (env: NodeJS.ProcessEnv): Lake => createLakeClient(lakeConfigFromEnv(env));

export const setupLake = async (lake: Lake, config: AmlConfig): Promise<void> => {
  const statements = buildLakeSetupStatements({
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    warehouse: config.lakeWarehouse,
  });
  await statements.reduce(async (previous, sql) => {
    await previous;
    await lake.query(sql);
  }, Promise.resolve());
};

export const countRows = async (lake: Lake, sql: string): Promise<number> => {
  const [row] = await lake.query(sql);
  return Number(row?.n ?? 0);
};

export const timedQuery = (lake: Lake, sql: string) => timed(() => lake.query(sql));

export const awaitRowCount = async (options: {
  readonly lake: Lake;
  readonly countSql: string;
  readonly expected: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly kickEveryMs: number;
}): Promise<{ readonly reached: boolean; readonly observed: number; readonly seconds: number }> => {
  const startedAt = Date.now();
  const kick = async (): Promise<void> => {
    await options.lake.query(executeLoadTask).catch(() => undefined);
  };
  await kick();
  const poll = async (observed: number, lastKickAt: number): Promise<{ reached: boolean; observed: number }> => {
    const now = Date.now();
    if (observed >= options.expected) return { reached: true, observed };
    if (now - startedAt > options.timeoutMs) return { reached: false, observed };
    await sleep(options.pollMs);
    const needsKick = Date.now() - lastKickAt >= options.kickEveryMs;
    if (needsKick) await kick();
    const next = await countRows(options.lake, options.countSql).catch(() => observed);
    return poll(next, needsKick ? Date.now() : lastKickAt);
  };
  const result = await poll(0, Date.now());
  return { ...result, seconds: (Date.now() - startedAt) / 1000 };
};
