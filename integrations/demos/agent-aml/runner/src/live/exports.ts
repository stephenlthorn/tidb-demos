import { runOrThrow } from './cli';
import { sleep } from '@lab/runner-kit';
import type { AmlConfig } from '../config';
import { exportState, parseExportId } from '../exportParse';
import { buildExportArgs, exportUri, redactArgs } from '../exportPlan';

export const runTransactionExport = async (options: {
  readonly config: AmlConfig;
  readonly database: string;
  readonly batch: number;
  readonly afterTxnId: number;
  readonly upToTxnId: number;
  readonly log: (message: string) => void;
}): Promise<{ readonly exportId: string; readonly seconds: number }> => {
  const startedAt = Date.now();
  const args = buildExportArgs({
    clusterId: options.config.clusterId,
    database: options.database,
    table: 'transactions',
    s3Uri: exportUri({ bucket: options.config.bucket, batch: options.batch }),
    accessKeyId: options.config.accessKeyId,
    secretAccessKey: options.config.secretAccessKey,
    afterTxnId: options.afterTxnId,
    upToTxnId: options.upToTxnId,
  });
  options.log(`ticloud ${redactArgs(args).join(' ')}`);
  const created = await runOrThrow({ bin: 'ticloud', args });
  const exportId = parseExportId(created.stdout);
  if (exportId === undefined) throw new Error(`could not read the export id from: ${created.stdout.slice(0, 200)}`);
  const wait = async (): Promise<void> => {
    if (Date.now() - startedAt > 10 * 60_000) throw new Error(`export ${exportId} did not finish in 10 minutes`);
    const described = await runOrThrow({
      bin: 'ticloud',
      args: ['serverless', 'export', 'describe', '-c', options.config.clusterId, '-e', exportId],
    });
    const state = exportState(described.stdout);
    if (state === 'failed') throw new Error(`export ${exportId} failed: ${described.stdout.slice(0, 200)}`);
    if (state === 'running') {
      await sleep(3000);
      await wait();
    }
  };
  await wait();
  return { exportId, seconds: (Date.now() - startedAt) / 1000 };
};

export const clearLakePrefix = async (config: AmlConfig): Promise<void> => {
  await runOrThrow({
    bin: 'aws',
    args: ['s3', 'rm', `s3://${config.bucket}/lake/`, '--recursive'],
    env: {
      AWS_ACCESS_KEY_ID: config.accessKeyId,
      AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
      AWS_DEFAULT_REGION: config.region,
    },
  });
};
