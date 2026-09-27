import { describe, expect, it } from 'vitest';
import { DASHBOARD_QUERIES } from '../src/dashboardQueries';

describe('DASHBOARD_QUERIES', () => {
  it('has exactly the 3 queries the Power BI report is pinned to', () => {
    expect(DASHBOARD_QUERIES.map((query) => query.id)).toEqual([
      'revenue-by-category',
      'orders-by-region',
      'orders-last-hour',
    ]);
  });

  it('excludes heartbeat rows from every query', () => {
    DASHBOARD_QUERIES.forEach((query) => {
      expect(query.sql).toContain('is_heartbeat = 0');
    });
  });
});
