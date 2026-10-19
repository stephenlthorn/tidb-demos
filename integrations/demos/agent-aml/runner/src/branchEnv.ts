export type BranchEnvOptions = {
  readonly base: Readonly<Record<string, string | undefined>>;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
};

export const branchUser = (options: { readonly userPrefix: string | undefined; readonly user: string }): string => {
  const bare = options.user.includes('.') ? (options.user.split('.').at(-1) ?? options.user) : options.user;
  if (options.userPrefix === undefined || options.userPrefix === '') return options.user;
  if (options.user.startsWith(`${options.userPrefix}.`)) return options.user;
  return `${options.userPrefix}.${bare}`;
};

export const branchEnv = (options: BranchEnvOptions): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(options.base).filter(([, value]) => value !== undefined)),
  TIDB_HOST: options.host,
  TIDB_PORT: String(options.port),
  TIDB_USER: options.user,
  TIDB_PASSWORD: options.password,
  TIDB_DATABASE: options.database,
  TIDB_TLS: 'true',
  TIDB_POOL_SIZE: '2',
});
