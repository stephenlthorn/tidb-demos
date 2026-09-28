import { describe, expect, it } from 'vitest';
import { qpsQuery, p99LatencyQuery, tikvWriteRateQuery, connectionsQuery } from '../src/promql';

describe('promql builders', () => {
  it('builds the qps query', () => {
    expect(qpsQuery({ windowSeconds: 30 })).toBe('sum(rate(tidb_executor_statement_total[30s]))');
  });

  it('builds the p99 latency query in milliseconds', () => {
    expect(p99LatencyQuery({ windowSeconds: 30 })).toBe(
      'histogram_quantile(0.99, sum(rate(tidb_server_handle_query_duration_seconds_bucket[30s])) by (le)) * 1000',
    );
  });

  it('builds the TiKV write-rate query in ops/s per store', () => {
    expect(tikvWriteRateQuery({ windowSeconds: 30 })).toBe(
      'sum(rate(tikv_raftstore_write_cmd_total{type="put"}[30s])) by (instance)',
    );
  });

  it('builds the connections query', () => {
    expect(connectionsQuery()).toBe('sum(tidb_server_connections)');
  });
});
