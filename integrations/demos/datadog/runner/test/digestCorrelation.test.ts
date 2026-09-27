import { describe, expect, it } from 'vitest';
import { findMatchingDigestRow } from '../src/digestCorrelation';

describe('digest correlation', () => {
  const rows = [
    { QUERY_SAMPLE_TEXT: 'select count(*) from lab_orders where customer_id=3100', DIGEST: 'abc' },
    { QUERY_SAMPLE_TEXT: "select * from lab_orders where notes like '%steady%'", DIGEST: 'def' },
  ];

  it('finds the row whose QUERY_SAMPLE_TEXT matches the span sql tag exactly', () => {
    const match = findMatchingDigestRow({ spanSql: "select * from lab_orders where notes like '%steady%'", rows });
    expect(match?.DIGEST).toBe('def');
  });

  it('returns undefined when no row matches', () => {
    const match = findMatchingDigestRow({ spanSql: 'select 1', rows });
    expect(match).toBeUndefined();
  });
});
