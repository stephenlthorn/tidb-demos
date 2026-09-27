export const createTableSql = `
  CREATE TABLE IF NOT EXISTS cache_demo_rows (
    id BIGINT PRIMARY KEY,
    payload VARCHAR(255) NOT NULL,
    version BIGINT NOT NULL,
    written_at_ms BIGINT NOT NULL
  )
`;
