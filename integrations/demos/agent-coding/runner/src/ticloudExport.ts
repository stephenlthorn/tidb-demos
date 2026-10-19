export type ExportState = 'running' | 'completed' | 'failed';

export const buildExportArgs = (options: {
  readonly clusterId: string;
  readonly s3Uri: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly filter: string;
}): readonly string[] => [
  'serverless',
  'export',
  'create',
  '--cluster-id',
  options.clusterId,
  '--target-type',
  'S3',
  '--s3.uri',
  options.s3Uri,
  '--s3.access-key-id',
  options.accessKeyId,
  '--s3.secret-access-key',
  options.secretAccessKey,
  '--file-type',
  'PARQUET',
  '--filter',
  options.filter,
  '--force',
  '--no-color',
];

export const buildExportDescribeArgs = (options: { readonly clusterId: string; readonly exportId: string }): readonly string[] => [
  'serverless',
  'export',
  'describe',
  '--cluster-id',
  options.clusterId,
  '--export-id',
  options.exportId,
  '--no-color',
];

export const parseExportId = (stdout: string): string => {
  const fromJson = /"(?:exportId|export_id|id)"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
  const fromText = /export[ _-]?id["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i.exec(stdout)?.[1];
  const found = fromJson ?? fromText;
  if (found === undefined) throw new Error(`export id not found in output: ${stdout.slice(0, 200)}`);
  return found;
};

export const parseExportState = (stdout: string): ExportState => {
  if (/\b(failed|canceled|cancelled)\b/i.test(stdout)) return 'failed';
  if (/\b(completed|succeeded|success)\b/i.test(stdout)) return 'completed';
  return 'running';
};
