export type LakeConfig = {
  readonly dsn: string;
  readonly warehouse: string;
  readonly database: string;
};

export type LakeClient = {
  readonly query: (sql: string) => Promise<readonly Record<string, unknown>[]>;
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

export const lakeConfigFromEnv = (env: EnvLike): LakeConfig => {
  const host = required(env, 'LAKE_HOST');
  const user = required(env, 'LAKE_USER');
  const password = required(env, 'LAKE_PASSWORD');
  const warehouse = required(env, 'LAKE_WAREHOUSE');
  const database = optional(env, 'LAKE_DATABASE', 'default');
  const port = optional(env, 'LAKE_PORT', '443');
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return {
    dsn: `lake://${credentials}@${host}:${port}/${database}?warehouse=${encodeURIComponent(warehouse)}`,
    warehouse,
    database,
  };
};

export const isReadStatement = (sql: string): boolean => /^\s*(select|show|describe|desc|with|explain|list)\b/i.test(sql);

export const zipRecord = (names: readonly string[], values: readonly unknown[]): Record<string, unknown> =>
  Object.fromEntries(names.map((name, index) => [name, values[index]]));
