import { describe, expect, it } from 'vitest';
import { buildCdcLatencyQuery, parseGetMetricDataResponse } from '../runner/src/cloudwatch-query';

describe('buildCdcLatencyQuery', () => {
  it('builds a GetMetricData request for both CDC latency metrics scoped to one replication task', () => {
    const request = buildCdcLatencyQuery({
      replicationInstanceId: 'tidb-lab-aws-dms-repl',
      replicationTaskId: 'tidb-lab-aws-dms-task',
      startTime: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-01-01T00:05:00Z'),
    });
    expect(request).toEqual({
      StartTime: new Date('2026-01-01T00:00:00Z'),
      EndTime: new Date('2026-01-01T00:05:00Z'),
      MetricDataQueries: [
        {
          Id: 'cdc_latency_source',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/DMS',
              MetricName: 'CDCLatencySource',
              Dimensions: [
                { Name: 'ReplicationInstanceIdentifier', Value: 'tidb-lab-aws-dms-repl' },
                { Name: 'ReplicationTaskIdentifier', Value: 'tidb-lab-aws-dms-task' },
              ],
            },
            Period: 60,
            Stat: 'Average',
          },
          ReturnData: true,
        },
        {
          Id: 'cdc_latency_target',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/DMS',
              MetricName: 'CDCLatencyTarget',
              Dimensions: [
                { Name: 'ReplicationInstanceIdentifier', Value: 'tidb-lab-aws-dms-repl' },
                { Name: 'ReplicationTaskIdentifier', Value: 'tidb-lab-aws-dms-task' },
              ],
            },
            Period: 60,
            Stat: 'Average',
          },
          ReturnData: true,
        },
      ],
    });
  });
});

describe('parseGetMetricDataResponse', () => {
  it('extracts the most recent datapoint per metric id', () => {
    const parsed = parseGetMetricDataResponse({
      MetricDataResults: [
        { Id: 'cdc_latency_source', Timestamps: [new Date('2026-01-01T00:04:00Z'), new Date('2026-01-01T00:03:00Z')], Values: [2, 5] },
        { Id: 'cdc_latency_target', Timestamps: [new Date('2026-01-01T00:04:00Z')], Values: [3] },
      ],
    });
    expect(parsed).toEqual({ cdc_latency_source: 2, cdc_latency_target: 3 });
  });

  it('omits a metric id with no datapoints instead of defaulting to zero', () => {
    const parsed = parseGetMetricDataResponse({
      MetricDataResults: [{ Id: 'cdc_latency_source', Timestamps: [], Values: [] }],
    });
    expect(parsed).toEqual({});
  });

  it('returns an empty object for a response with no MetricDataResults field', () => {
    expect(parseGetMetricDataResponse({})).toEqual({});
  });
});
