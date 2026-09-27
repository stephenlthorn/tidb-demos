export const createEventsTableSql = `
CREATE TABLE IF NOT EXISTS events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_customer_created (customer_id, created_at)
)`.trim();

export const createHeartbeatsTableSql = `
CREATE TABLE IF NOT EXISTS heartbeats (
  id INT PRIMARY KEY,
  written_at DATETIME(3) NOT NULL
)`.trim();

export const createScoresTableSql = `
CREATE TABLE IF NOT EXISTS customer_risk_scores (
  customer_id INT PRIMARY KEY,
  score DECIMAL(10,3) NOT NULL,
  rule VARCHAR(20) NOT NULL,
  updated_at DATETIME(3) NOT NULL
)`.trim();

export const enableTiflashReplicaSql = 'ALTER TABLE events SET TIFLASH REPLICA 1';
