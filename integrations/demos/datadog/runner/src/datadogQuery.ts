export const qpsQuery = (): string => 'sum:tidb_cluster.tidb_executor_statement_total{*}.as_rate()';

export const meanLatencyQuery = (): string =>
  '(sum:tidb_cluster.tidb_server_handle_query_duration_seconds.sum{*}.as_rate() / sum:tidb_cluster.tidb_server_handle_query_duration_seconds.count{*}.as_rate()) * 1000';

export const tikvCpuQuery = (): string => 'sum:tidb_cluster.process_cpu_seconds_total{component:tikv}.as_rate() * 100';

export const connectionsQuery = (): string => 'sum:tidb_cluster.tidb_server_connections{*}';
