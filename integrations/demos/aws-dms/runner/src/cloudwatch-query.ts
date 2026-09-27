export type CdcLatencyQueryOptions = {
  readonly replicationInstanceId: string;
  readonly replicationTaskId: string;
  readonly startTime: Date;
  readonly endTime: Date;
};

type MetricDataQuery = {
  readonly Id: string;
  readonly MetricStat: {
    readonly Metric: {
      readonly Namespace: string;
      readonly MetricName: string;
      readonly Dimensions: readonly { readonly Name: string; readonly Value: string }[];
    };
    readonly Period: number;
    readonly Stat: string;
  };
  readonly ReturnData: boolean;
};

export type GetMetricDataRequest = {
  readonly StartTime: Date;
  readonly EndTime: Date;
  readonly MetricDataQueries: readonly MetricDataQuery[];
};

const buildMetricQuery = (options: {
  readonly id: string;
  readonly metricName: string;
  readonly replicationInstanceId: string;
  readonly replicationTaskId: string;
}): MetricDataQuery => ({
  Id: options.id,
  MetricStat: {
    Metric: {
      Namespace: 'AWS/DMS',
      MetricName: options.metricName,
      Dimensions: [
        { Name: 'ReplicationInstanceIdentifier', Value: options.replicationInstanceId },
        { Name: 'ReplicationTaskIdentifier', Value: options.replicationTaskId },
      ],
    },
    Period: 60,
    Stat: 'Average',
  },
  ReturnData: true,
});

export const buildCdcLatencyQuery = (options: CdcLatencyQueryOptions): GetMetricDataRequest => ({
  StartTime: options.startTime,
  EndTime: options.endTime,
  MetricDataQueries: [
    buildMetricQuery({
      id: 'cdc_latency_source',
      metricName: 'CDCLatencySource',
      replicationInstanceId: options.replicationInstanceId,
      replicationTaskId: options.replicationTaskId,
    }),
    buildMetricQuery({
      id: 'cdc_latency_target',
      metricName: 'CDCLatencyTarget',
      replicationInstanceId: options.replicationInstanceId,
      replicationTaskId: options.replicationTaskId,
    }),
  ],
});

type RawMetricDataResult = {
  readonly Id?: string;
  readonly Timestamps?: readonly Date[];
  readonly Values?: readonly number[];
};

type RawGetMetricDataResponse = {
  readonly MetricDataResults?: readonly RawMetricDataResult[];
};

export type LatestMetricValues = Readonly<Record<string, number>>;

export const parseGetMetricDataResponse = (response: RawGetMetricDataResponse): LatestMetricValues => {
  const results: Record<string, number> = {};
  for (const result of response.MetricDataResults ?? []) {
    const timestamps = result.Timestamps ?? [];
    const values = result.Values ?? [];
    if (result.Id === undefined || timestamps.length === 0 || values.length === 0) continue;
    let latestIndex = 0;
    for (let i = 1; i < timestamps.length; i += 1) {
      if (timestamps[i].getTime() > timestamps[latestIndex].getTime()) latestIndex = i;
    }
    results[result.Id] = values[latestIndex];
  }
  return results;
};
