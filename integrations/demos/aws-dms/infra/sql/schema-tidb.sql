CREATE TABLE accounts (
  account_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  external_ref VARCHAR(36) NOT NULL,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  risk_tags TEXT NOT NULL,
  metadata JSON NOT NULL,
  opened_at DATETIME NOT NULL,
  INDEX idx_accounts_active (is_active)
);

CREATE TABLE orders (
  order_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL,
  placed_at DATETIME NOT NULL,
  INDEX idx_orders_account (account_id),
  INDEX idx_orders_status (status)
);

CREATE TABLE heartbeat (
  heartbeat_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inserted_at DATETIME NOT NULL
);
