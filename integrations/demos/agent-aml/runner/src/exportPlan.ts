export type ExportOptions = {
  readonly clusterId: string;
  readonly database: string;
  readonly table: string;
  readonly s3Uri: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly afterTxnId?: number;
  readonly upToTxnId?: number;
};

export const exportUri = (options: { readonly bucket: string; readonly batch: number }): string =>
  `s3://${options.bucket}/lake/export/transactions/batch-${String(options.batch).padStart(2, '0')}/`;

export const buildExportWhere = (options: {
  readonly afterTxnId?: number;
  readonly upToTxnId?: number;
}): string | undefined => {
  const clauses = [
    options.afterTxnId === undefined ? undefined : `txn_id > ${Math.trunc(options.afterTxnId)}`,
    options.upToTxnId === undefined ? undefined : `txn_id <= ${Math.trunc(options.upToTxnId)}`,
  ].filter((clause): clause is string => clause !== undefined);
  return clauses.length === 0 ? undefined : clauses.join(' AND ');
};

export const buildExportArgs = (options: ExportOptions): readonly string[] => {
  const where = buildExportWhere(options);
  return [
    'serverless',
    'export',
    'create',
    '-c',
    options.clusterId,
    '--file-type',
    'PARQUET',
    '--target-type',
    'S3',
    '--s3.uri',
    options.s3Uri,
    '--s3.access-key-id',
    options.accessKeyId,
    '--s3.secret-access-key',
    options.secretAccessKey,
    '--filter',
    `${options.database}.${options.table}`,
    ...(where === undefined ? [] : ['--where', where]),
    '--force',
  ];
};

const secretFlags: ReadonlySet<string> = new Set(['--s3.access-key-id', '--s3.secret-access-key']);

export const redactArgs = (args: readonly string[]): readonly string[] =>
  args.map((arg, index) => (secretFlags.has(args[index - 1] ?? '') ? '<redacted>' : arg));
