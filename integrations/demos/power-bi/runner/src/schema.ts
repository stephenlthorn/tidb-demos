export const ORDERS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS orders (
  order_id VARCHAR(32) NOT NULL,
  region VARCHAR(32) NOT NULL,
  product_category VARCHAR(32) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  is_heartbeat TINYINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (order_id),
  KEY idx_created_at (created_at)
)`;
