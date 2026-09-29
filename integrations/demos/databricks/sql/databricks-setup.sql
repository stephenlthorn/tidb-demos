CREATE CONNECTION IF NOT EXISTS tidb_lab_connection
TYPE mysql
OPTIONS (
  host '<your-starter-cluster-host>',
  port '4000',
  user secret ('lab-tidb', 'tidb-user'),
  password secret ('lab-tidb', 'tidb-password')
);

CREATE FOREIGN CATALOG IF NOT EXISTS tidb_fed
USING CONNECTION tidb_lab_connection;

CREATE SCHEMA IF NOT EXISTS workspace.lab_databricks;

CREATE TABLE IF NOT EXISTS workspace.lab_databricks.risk_scores (
  customer_id BIGINT,
  score DOUBLE,
  rule STRING,
  scored_at TIMESTAMP
);

SELECT * FROM tidb_fed.<your-tidb-database>.heartbeats;
