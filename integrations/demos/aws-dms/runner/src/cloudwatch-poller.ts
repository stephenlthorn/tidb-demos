import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { buildCdcLatencyQuery, parseGetMetricDataResponse, type LatestMetricValues } from './cloudwatch-query';

export type CloudwatchPoller = {
  readonly pollCdcLatency: () => Promise<LatestMetricValues>;
};

export type CreateCloudwatchPollerOptions = {
  readonly region: string;
  readonly replicationInstanceId: string;
  readonly replicationTaskId: string;
  readonly windowMs: number;
};

export const createCloudwatchPoller = (options: CreateCloudwatchPollerOptions): CloudwatchPoller => {
  const client = new CloudWatchClient({ region: options.region });

  const pollCdcLatency = async (): Promise<LatestMetricValues> => {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - options.windowMs);
    const request = buildCdcLatencyQuery({
      replicationInstanceId: options.replicationInstanceId,
      replicationTaskId: options.replicationTaskId,
      startTime,
      endTime,
    });
    const response = await client.send(
      new GetMetricDataCommand({
        StartTime: request.StartTime,
        EndTime: request.EndTime,
        MetricDataQueries: request.MetricDataQueries.map((query) => ({
          Id: query.Id,
          MetricStat: {
            Metric: {
              Namespace: query.MetricStat.Metric.Namespace,
              MetricName: query.MetricStat.Metric.MetricName,
              Dimensions: [...query.MetricStat.Metric.Dimensions],
            },
            Period: query.MetricStat.Period,
            Stat: query.MetricStat.Stat,
          },
          ReturnData: query.ReturnData,
        })),
      }),
    );
    return parseGetMetricDataResponse(response);
  };

  return { pollCdcLatency };
};
