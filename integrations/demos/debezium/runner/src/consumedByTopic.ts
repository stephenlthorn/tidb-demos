import type { EnvelopeParseResult } from './debeziumEnvelope';

export type ConsumedByTopicCounts = {
  readonly pgChanges: number;
  readonly tidbChanges: number;
};

const TICDC_CONNECTOR = 'TiCDC';

export const countConsumedByTopic = (results: readonly EnvelopeParseResult[]): ConsumedByTopicCounts =>
  results.reduce<ConsumedByTopicCounts>(
    (counts, result) => {
      if (!result.ok) return counts;
      return result.connector === TICDC_CONNECTOR
        ? { ...counts, tidbChanges: counts.tidbChanges + 1 }
        : { ...counts, pgChanges: counts.pgChanges + 1 };
    },
    { pgChanges: 0, tidbChanges: 0 },
  );
