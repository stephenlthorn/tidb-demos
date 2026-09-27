import { describe, expect, it } from 'vitest';
import {
  buildScoringStatement,
  buildFederatedHeartbeatStatement,
  type FederationConfig,
} from '../src/scoringStatement';
import { velocityRule } from '../src/scoringRule';

const config: FederationConfig = {
  federatedCatalog: 'tidb_fed',
  federatedSchema: 'lab',
  eventsTable: 'events',
  heartbeatsTable: 'heartbeats',
  scoresCatalog: 'main',
  scoresSchema: 'lab_databricks',
  scoresTable: 'risk_scores',
};

describe('buildScoringStatement', () => {
  it('reads from the federated events table and writes into the scores table', () => {
    const sql = buildScoringStatement(velocityRule, config);
    expect(sql).toContain('INSERT INTO main.lab_databricks.risk_scores');
    expect(sql).toContain('FROM tidb_fed.lab.events');
    expect(sql).toContain("'velocity' AS rule");
    expect(sql).toContain("INTERVAL '5' MINUTE");
  });

  it('bakes the rule weights into the CASE expression', () => {
    const sql = buildScoringStatement(velocityRule, config);
    expect(sql).toContain('amount * 4.0000');
    expect(sql).toContain('amount * 2.0000');
    expect(sql).toContain('amount * 1.0000');
  });

  it('rejects a non-finite weight rather than emit broken SQL', () => {
    const brokenRule = { ...velocityRule, baseWeight: Number.NaN };
    expect(() => buildScoringStatement(brokenRule, config)).toThrow('weight must be finite');
  });
});

describe('buildFederatedHeartbeatStatement', () => {
  it('selects the latest heartbeat from the federated table', () => {
    expect(buildFederatedHeartbeatStatement(config)).toBe(
      'SELECT MAX(written_at) AS last_heartbeat FROM tidb_fed.lab.heartbeats',
    );
  });
});
