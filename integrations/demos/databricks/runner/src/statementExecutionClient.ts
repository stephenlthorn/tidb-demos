import { decidePoll, parseStatementResponse, type StatementResponse } from './statementResponse';

export type DatabricksConfig = {
  readonly host: string;
  readonly token: string;
  readonly warehouseId: string;
  readonly statementTimeoutMs: number;
};

const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const submitStatement = async (config: DatabricksConfig, statement: string): Promise<StatementResponse> => {
  const response = await fetch(`https://${config.host}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: authHeaders(config.token),
    body: JSON.stringify({ warehouse_id: config.warehouseId, statement, wait_timeout: '5s' }),
  });
  const json: unknown = await response.json();
  return parseStatementResponse(json);
};

const fetchStatement = async (config: DatabricksConfig, statementId: string): Promise<StatementResponse> => {
  const response = await fetch(`https://${config.host}/api/2.0/sql/statements/${statementId}`, {
    headers: authHeaders(config.token),
  });
  const json: unknown = await response.json();
  return parseStatementResponse(json);
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const runStatement = async (config: DatabricksConfig, statement: string): Promise<StatementResponse> => {
  const startedAtMs = Date.now();
  let current = await submitStatement(config, statement);
  for (;;) {
    const decision = decidePoll(current.state, Date.now() - startedAtMs, config.statementTimeoutMs);
    if (decision === 'ready') return current;
    if (decision === 'failed') throw new Error(`statement failed: ${current.errorMessage ?? current.state}`);
    if (decision === 'timeout') throw new Error(`statement timed out after ${config.statementTimeoutMs}ms`);
    await wait(500);
    current = await fetchStatement(config, current.statementId);
  }
};
