import {
  DatabaseMigrationServiceClient,
  DescribeTableStatisticsCommand,
} from '@aws-sdk/client-database-migration-service';
import { parseTableStatistics, type TableProgress } from './table-stats';

export type DmsPoller = {
  readonly pollTableStatistics: () => Promise<readonly TableProgress[]>;
};

export type CreateDmsPollerOptions = {
  readonly region: string;
  readonly replicationTaskArn: string;
};

export const createDmsPoller = (options: CreateDmsPollerOptions): DmsPoller => {
  const client = new DatabaseMigrationServiceClient({ region: options.region });

  const pollTableStatistics = async (): Promise<readonly TableProgress[]> => {
    const response = await client.send(
      new DescribeTableStatisticsCommand({ ReplicationTaskArn: options.replicationTaskArn }),
    );
    return parseTableStatistics(response);
  };

  return { pollTableStatistics };
};
