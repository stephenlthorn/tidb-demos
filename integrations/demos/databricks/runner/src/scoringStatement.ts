import type { ScoringRule } from './scoringRule';

export type FederationConfig = {
  readonly federatedCatalog: string;
  readonly federatedSchema: string;
  readonly eventsTable: string;
  readonly heartbeatsTable: string;
  readonly scoresCatalog: string;
  readonly scoresSchema: string;
  readonly scoresTable: string;
};

const formatWeight = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error(`weight must be finite: ${value}`);
  return value.toFixed(4);
};

const qualifiedEvents = (config: FederationConfig): string =>
  `${config.federatedCatalog}.${config.federatedSchema}.${config.eventsTable}`;

const qualifiedHeartbeats = (config: FederationConfig): string =>
  `${config.federatedCatalog}.${config.federatedSchema}.${config.heartbeatsTable}`;

const qualifiedScores = (config: FederationConfig): string =>
  `${config.scoresCatalog}.${config.scoresSchema}.${config.scoresTable}`;

export const buildScoringStatement = (rule: ScoringRule, config: FederationConfig): string => `
INSERT INTO ${qualifiedScores(config)} (customer_id, score, rule, scored_at)
SELECT
  customer_id,
  ROUND(
    SUM(
      CASE event_type
        WHEN 'chargeback' THEN amount * ${formatWeight(rule.chargebackWeight)}
        WHEN 'refund' THEN amount * ${formatWeight(rule.refundWeight)}
        ELSE amount * ${formatWeight(rule.baseWeight)}
      END
    ) / GREATEST(COUNT(*), 1),
    3
  ) AS score,
  '${rule.name}' AS rule,
  current_timestamp() AS scored_at
FROM ${qualifiedEvents(config)}
WHERE created_at >= current_timestamp() - INTERVAL '${rule.windowMinutes}' MINUTE
GROUP BY customer_id
`.trim();

export const buildFederatedHeartbeatStatement = (config: FederationConfig): string =>
  `SELECT MAX(written_at) AS last_heartbeat FROM ${qualifiedHeartbeats(config)}`.trim();
