export const schemaStatements: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
    account_id VARCHAR(16) PRIMARY KEY,
    holder_name VARCHAR(120) NOT NULL,
    kind VARCHAR(12) NOT NULL,
    home_branch VARCHAR(8) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    txn_id BIGINT PRIMARY KEY,
    account_id VARCHAR(16) NOT NULL,
    counterparty_id VARCHAR(16) NOT NULL,
    txn_type VARCHAR(16) NOT NULL,
    amount_cents BIGINT NOT NULL,
    txn_ts DATETIME(3) NOT NULL,
    branch_code VARCHAR(8) NOT NULL,
    memo VARCHAR(80) NOT NULL,
    KEY idx_account_ts (account_id, txn_ts),
    KEY idx_ts (txn_ts)
  )`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    entry_id INT PRIMARY KEY AUTO_INCREMENT,
    full_name VARCHAR(120) NOT NULL,
    list_tag VARCHAR(24) NOT NULL,
    FULLTEXT INDEX ft_full_name (full_name) WITH PARSER STANDARD
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    rule_id VARCHAR(32) NOT NULL,
    version VARCHAR(8) NOT NULL,
    params JSON NOT NULL,
    active TINYINT NOT NULL DEFAULT 1,
    PRIMARY KEY (rule_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    alert_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    rule_id VARCHAR(32) NOT NULL,
    rule_version VARCHAR(8) NOT NULL,
    account_id VARCHAR(16) NOT NULL,
    bucket BIGINT NOT NULL,
    window_start DATETIME(3) NOT NULL,
    window_end DATETIME(3) NOT NULL,
    score DOUBLE NOT NULL,
    txn_ids JSON NOT NULL,
    raised_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_alert (rule_id, rule_version, account_id, bucket)
  )`,
  `CREATE TABLE IF NOT EXISTS ground_truth (
    account_id VARCHAR(16) PRIMARY KEY,
    pattern VARCHAR(32) NOT NULL,
    injected_at DATETIME(3) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cases (
    case_id VARCHAR(24) PRIMARY KEY,
    alert_id BIGINT NOT NULL,
    account_id VARCHAR(16) NOT NULL,
    pattern VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL,
    opened_at DATETIME(3) NOT NULL,
    layer_id VARCHAR(64) NOT NULL,
    branch_id VARCHAR(64) NOT NULL,
    journal_id VARCHAR(64) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS entity_facts (
    entity_id VARCHAR(16) NOT NULL,
    fact_key VARCHAR(40) NOT NULL,
    fact_value VARCHAR(200) NOT NULL,
    PRIMARY KEY (entity_id, fact_key)
  )`,
  `CREATE TABLE IF NOT EXISTS episodic_memory (
    memory_id INT PRIMARY KEY AUTO_INCREMENT,
    case_id VARCHAR(24) NOT NULL,
    pattern VARCHAR(32) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    summary TEXT NOT NULL,
    summary_vector VECTOR(1024) GENERATED ALWAYS AS (
      EMBED_TEXT("tidbcloud_free/amazon/titan-embed-text-v2", summary)
    ) STORED,
    FULLTEXT INDEX ft_summary (summary) WITH PARSER STANDARD,
    VECTOR INDEX idx_summary_vec ((VEC_COSINE_DISTANCE(summary_vector)))
  )`,
];

export const resetStatements: readonly string[] = [
  'TRUNCATE TABLE transactions',
  'TRUNCATE TABLE accounts',
  'TRUNCATE TABLE alerts',
  'TRUNCATE TABLE ground_truth',
  'TRUNCATE TABLE cases',
  'TRUNCATE TABLE entity_facts',
  'TRUNCATE TABLE watchlist',
  'TRUNCATE TABLE rules',
  'TRUNCATE TABLE episodic_memory',
];
