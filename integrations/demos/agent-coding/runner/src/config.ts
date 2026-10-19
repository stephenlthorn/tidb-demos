export type RunConfig = {
  readonly runId: string;
  readonly ticket: { readonly id: string; readonly title: string };
  readonly workDir: string;
  readonly fixturesDir: string;
  readonly orgClusterId: string;
  readonly fixtureClusterId: string;
  readonly fixtureDatabase: string;
  readonly branchSqlUser: string;
  readonly branchSqlPassword: string;
  readonly branchQuota: number;
  readonly branchTimeoutMs: number;
  readonly branchPollMs: number;
  readonly stepWaitMs: number;
  readonly autoRun: boolean;
  readonly stagePauseMs: number;
  readonly freshnessTimeoutMs: number;
  readonly exportTimeoutMs: number;
  readonly executeLakeTask: boolean;
  readonly historyRuns: number;
  readonly historySeed: number;
  readonly bucket: string;
  readonly region: string;
  readonly prefix: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly lakeWarehouse: string;
  readonly lakeDatabase: string;
};

type EnvLike = Readonly<Record<string, string | undefined>>;

const required = (env: EnvLike, name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`missing required env var: ${name}`);
  return value;
};

const optional = (env: EnvLike, name: string, fallback: string): string => {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
};

const numberFrom = (env: EnvLike, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
};

export const makeRunId = (date: Date): string =>
  `run-${date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;

export const runConfigFromEnv = (
  env: EnvLike,
  options: { readonly fixturesDir: string; readonly now: Date; readonly homeDir: string },
): RunConfig => ({
  runId: makeRunId(options.now),
  ticket: { id: 'KIT-8812', title: 'fix double charge on retried payments' },
  workDir: optional(env, 'WORK_DIR', `${options.homeDir}/lab-agent-coding-work`),
  fixturesDir: options.fixturesDir,
  orgClusterId: required(env, 'AGENT_ORG_CLUSTER_ID'),
  fixtureClusterId: required(env, 'AGENT_FIXTURE_CLUSTER_ID'),
  fixtureDatabase: optional(env, 'FIXTURE_DATABASE', 'fixture'),
  branchSqlUser: required(env, 'FIXTURE_SQL_USER'),
  branchSqlPassword: required(env, 'FIXTURE_SQL_PASSWORD'),
  branchQuota: numberFrom(env, 'BRANCH_QUOTA', 5),
  branchTimeoutMs: numberFrom(env, 'BRANCH_TIMEOUT_MS', 900000),
  branchPollMs: numberFrom(env, 'BRANCH_POLL_MS', 10000),
  stepWaitMs: numberFrom(env, 'STEP_WAIT_MS', 1000),
  autoRun: env.AUTO_RUN === 'true',
  stagePauseMs: numberFrom(env, 'STAGE_PAUSE_MS', 3000),
  freshnessTimeoutMs: numberFrom(env, 'LAKE_FRESHNESS_TIMEOUT_MS', 240000),
  exportTimeoutMs: numberFrom(env, 'EXPORT_TIMEOUT_MS', 300000),
  executeLakeTask: env.LAKE_EXECUTE_TASK === 'true',
  historyRuns: numberFrom(env, 'HISTORY_RUNS', 200),
  historySeed: numberFrom(env, 'HISTORY_SEED', 42),
  bucket: required(env, 'S3_BUCKET'),
  region: optional(env, 'S3_REGION', 'us-east-1'),
  prefix: optional(env, 'S3_PREFIX', 'agent-coding'),
  s3AccessKeyId: required(env, 'AWS_ACCESS_KEY_ID'),
  s3SecretAccessKey: required(env, 'AWS_SECRET_ACCESS_KEY'),
  lakeWarehouse: required(env, 'LAKE_WAREHOUSE'),
  lakeDatabase: optional(env, 'LAKE_DATABASE', 'agent_coding'),
});
