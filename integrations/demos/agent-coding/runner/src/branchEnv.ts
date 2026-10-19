type EnvLike = Readonly<Record<string, string | undefined>>;

export const branchUser = (options: { readonly userPrefix: string | undefined; readonly user: string }): string => {
  if (options.userPrefix === undefined || options.user.includes('.')) return options.user;
  return `${options.userPrefix}.${options.user}`;
};

export const branchEnv = (options: {
  readonly base: EnvLike;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}): Record<string, string> => {
  const inherited = Object.fromEntries(
    Object.entries(options.base).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    TIDB_HOST: options.host,
    TIDB_PORT: String(options.port),
    TIDB_USER: options.user,
    TIDB_PASSWORD: options.password,
    TIDB_DATABASE: options.database,
    TIDB_TLS: 'true',
    TIDB_POOL_SIZE: '2',
  };
};
