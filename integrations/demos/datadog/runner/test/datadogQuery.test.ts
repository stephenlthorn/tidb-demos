import { describe, expect, it } from 'vitest';
import { qpsQuery, meanLatencyQuery, tikvCpuQuery, connectionsQuery } from '../src/datadogQuery';

describe('datadog query builders', () => {
  it('builds the qps query', () => {
    expect(qpsQuery()).toBe('sum:tidb_cluster.tidb_executor_statement_total{*}.as_rate()');
  });

  it('builds the mean latency query in milliseconds', () => {
    expect(meanLatencyQuery()).toBe(
      '(sum:tidb_cluster.tidb_server_handle_query_duration_seconds.sum{*}.as_rate() / sum:tidb_cluster.tidb_server_handle_query_duration_seconds.count{*}.as_rate()) * 1000',
    );
  });

  it('builds the TiKV CPU query as a percentage', () => {
    expect(tikvCpuQuery()).toBe('sum:tidb_cluster.process_cpu_seconds_total{component:tikv}.as_rate() * 100');
  });

  it('builds the connections query', () => {
    expect(connectionsQuery()).toBe('sum:tidb_cluster.tidb_server_connections{*}');
  });
});
