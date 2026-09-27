export type DashboardQuery = {
  readonly id: string;
  readonly label: string;
  readonly sql: string;
};

export const DASHBOARD_QUERIES: readonly DashboardQuery[] = [
  {
    id: 'revenue-by-category',
    label: 'Revenue by category',
    sql: 'SELECT product_category, SUM(amount) AS revenue, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 GROUP BY product_category',
  },
  {
    id: 'orders-by-region',
    label: 'Orders by region',
    sql: 'SELECT region, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 GROUP BY region',
  },
  {
    id: 'orders-last-hour',
    label: 'Orders per minute (last hour)',
    sql: "SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS minute_bucket, COUNT(*) AS order_count FROM orders WHERE is_heartbeat = 0 AND created_at >= NOW() - INTERVAL 60 MINUTE GROUP BY minute_bucket ORDER BY minute_bucket",
  },
];
