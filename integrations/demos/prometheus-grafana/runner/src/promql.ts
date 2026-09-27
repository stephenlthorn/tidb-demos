export type WindowOptions = { readonly windowSeconds: number };

export const qpsQuery = ({ windowSeconds }: WindowOptions): string =>
  `sum(rate(tidb_executor_statement_total[${windowSeconds}s]))`;

export const p99LatencyQuery = ({ windowSeconds }: WindowOptions): string =>
  `histogram_quantile(0.99, sum(rate(tidb_server_handle_query_duration_seconds_bucket[${windowSeconds}s])) by (le)) * 1000`;

export const tikvCpuQuery = ({ windowSeconds }: WindowOptions): string =>
  `sum(rate(tikv_thread_cpu_seconds_total[${windowSeconds}s])) by (instance) * 100`;

export const connectionsQuery = (): string => 'sum(tidb_server_connections)';
