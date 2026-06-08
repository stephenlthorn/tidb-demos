-- TiDB HTAP Demo: Schema Setup
-- Run this manually if you want to pre-create the schema,
-- or let demo.py handle it automatically.

CREATE DATABASE IF NOT EXISTS htap_demo;
USE htap_demo;

-- Main trades table — stored in TiKV (row store) by default
CREATE TABLE IF NOT EXISTS trades (
    id          BIGINT AUTO_RANDOM PRIMARY KEY,
    symbol      VARCHAR(10)    NOT NULL,
    side        ENUM('buy','sell') NOT NULL,
    price       DECIMAL(18,6)  NOT NULL,
    quantity    DECIMAL(18,8)  NOT NULL,
    trader_id   INT            NOT NULL,
    status      ENUM('pending','filled','cancelled') NOT NULL DEFAULT 'filled',
    created_at  TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_symbol_created (symbol, created_at),
    INDEX idx_trader (trader_id, created_at)
);

-- Enable TiFlash columnar replica for OLAP queries
-- TiDB automatically routes queries with large scans/aggregations to TiFlash
ALTER TABLE trades SET TIFLASH REPLICA 1;

-- Verify TiFlash replica status
-- Expected: AVAILABLE=1 after ~30 seconds
SELECT TABLE_NAME, REPLICA_COUNT, AVAILABLE, PROGRESS
FROM information_schema.tiflash_replica
WHERE TABLE_SCHEMA = 'htap_demo';

-- Sample OLTP query — routed to TiKV (point lookup by PK)
-- EXPLAIN should show: tikv_task
-- EXPLAIN SELECT * FROM trades WHERE id = 12345;

-- Sample OLAP query — routed to TiFlash (full scan + aggregation)
-- EXPLAIN should show: tiflash_task
-- EXPLAIN
-- SELECT
--     symbol,
--     DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS minute,
--     COUNT(*)                                   AS trade_count,
--     SUM(price * quantity)                      AS volume,
--     AVG(price)                                 AS avg_price,
--     MIN(price)                                 AS low,
--     MAX(price)                                 AS high
-- FROM trades
-- WHERE created_at >= NOW() - INTERVAL 1 HOUR
-- GROUP BY symbol, minute
-- ORDER BY minute DESC, volume DESC;
