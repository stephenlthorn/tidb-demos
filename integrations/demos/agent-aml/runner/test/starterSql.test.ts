import { describe, expect, it } from 'vitest';
import type { Alert, Transaction } from '../src/domain';
import { alertFromRow, transactionFromRow } from '../src/rowMappers';
import {
  alertInsert,
  buildBulkInsert,
  caseInsert,
  chunk,
  entityFactsInsert,
  episodicInsert,
  ruleUpsert,
  selectWatchlistCandidates,
  transactionInserts,
  watchlistInsert,
} from '../src/starterSql';
import { candidateStructuring } from '../src/rules';

const aTxn = (txnId: number): Transaction => ({
  txnId,
  accountId: 'ACC-0001',
  counterpartyId: 'CP-001',
  txnType: 'cash_deposit',
  amountCents: 950_000,
  txnTsMs: Date.UTC(2026, 0, 5, 10, 30, 15, 123),
  branchCode: 'B01',
  memo: 'cash deposit',
});

describe('buildBulkInsert', () => {
  it('returns an empty statement for no rows', () => {
    expect(buildBulkInsert({ table: 't', columns: ['a'], rows: [] })).toEqual({ sql: '', params: [] });
  });

  it('quotes identifiers and builds one placeholder group per row', () => {
    const result = buildBulkInsert({ table: 't', columns: ['a', 'b'], rows: [[1, 2], [3, 4]], ignoreDuplicates: true });
    expect(result.sql).toBe('INSERT IGNORE INTO `t` (`a`, `b`) VALUES (?, ?), (?, ?)');
    expect(result.params).toEqual([1, 2, 3, 4]);
  });
});

describe('chunk', () => {
  it('splits into batches with a short final batch', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('transactionInserts', () => {
  it('formats timestamps to millisecond precision and batches 500 rows', () => {
    const statements = transactionInserts(Array.from({ length: 501 }, (_, index) => aTxn(index + 1)));
    expect(statements).toHaveLength(2);
    expect(statements[0]?.params).toHaveLength(500 * 8);
    expect(statements[0]?.params[5]).toBe('2026-01-05 10:30:15.123');
  });
});

describe('alertInsert and ruleUpsert', () => {
  it('serializes txn ids as JSON and ignores duplicate alert keys', () => {
    const alert: Alert = {
      ruleId: 'structuring',
      ruleVersion: 'v1',
      accountId: 'ACC-0001',
      windowStartMs: Date.UTC(2026, 0, 5),
      windowEndMs: Date.UTC(2026, 0, 6),
      raisedAtMs: Date.UTC(2026, 0, 6, 23, 59, 59, 999),
      bucket: 2900,
      txnIds: [1, 2, 3],
      score: 3,
    };
    const statement = alertInsert([alert]);
    expect(statement.sql.startsWith('INSERT IGNORE INTO `alerts`')).toBe(true);
    expect(statement.params).toContain('[1,2,3]');
  });

  it('upserts the candidate rule params as JSON text', () => {
    const statement = ruleUpsert(candidateStructuring(1_000_000));
    expect(statement.params[0]).toBe('structuring');
    expect(statement.params[1]).toBe('v2');
    expect(JSON.parse(String(statement.params[2]))).toMatchObject({ minDistinctBranches: 2 });
  });
});

describe('selectWatchlistCandidates', () => {
  it('uses fts_match_word for filtering and for relevance ordering', () => {
    const sql = selectWatchlistCandidates('queaby marlow');
    expect(sql).toContain("WHERE fts_match_word('queaby marlow', full_name)");
    expect(sql).toContain("ORDER BY fts_match_word('queaby marlow', full_name) DESC");
  });
});

describe('row mappers', () => {
  it('parses a transaction row with a microsecond timestamp as UTC', () => {
    const txn = transactionFromRow({
      txn_id: '7',
      account_id: 'ACC-0001',
      counterparty_id: 'CP-001',
      txn_type: 'wire_in',
      amount_cents: '12345',
      txn_ts_text: '2026-01-05 10:30:15.123000',
      branch_code: 'B01',
      memo: 'invoice payment',
    });
    expect(txn.txnTsMs).toBe(Date.UTC(2026, 0, 5, 10, 30, 15, 123));
    expect(txn.amountCents).toBe(12345);
  });

  it('rejects a transaction row with an unknown type', () => {
    expect(() =>
      transactionFromRow({
        txn_id: 1,
        account_id: 'a',
        counterparty_id: 'c',
        txn_type: 'crypto',
        amount_cents: 1,
        txn_ts_text: '2026-01-05 10:30:15.123000',
        branch_code: 'B01',
        memo: 'm',
      }),
    ).toThrow();
  });

  it('parses an alert row whose JSON column arrives as text or as an array', () => {
    const base = {
      rule_id: 'structuring',
      rule_version: 'v1',
      account_id: 'ACC-0001',
      bucket: '2900',
      window_start_text: '2026-01-05 00:00:00.000000',
      window_end_text: '2026-01-06 00:00:00.000000',
      score: 3,
      raised_at_text: '2026-01-06 23:59:59.999000',
    };
    expect(alertFromRow({ ...base, txn_ids: '[1,2]' }).txnIds).toEqual([1, 2]);
    expect(alertFromRow({ ...base, txn_ids: [3] }).txnIds).toEqual([3]);
  });
});

describe('seed inserts', () => {
  it('writes three entity facts per account', () => {
    const statement = entityFactsInsert([{ accountId: 'ACC-0001', holderName: 'Marlow Quenby', kind: 'retail', homeBranch: 'B01' }]);
    expect(statement.params).toEqual([
      'ACC-0001', 'holder_name', 'Marlow Quenby',
      'ACC-0001', 'kind', 'retail',
      'ACC-0001', 'home_branch', 'B01',
    ]);
  });

  it('inserts watchlist and episodic rows without the generated vector column', () => {
    expect(watchlistInsert([{ fullName: 'Veskar Tolmund Draycott', listTag: 'SYNTH-LIST' }]).sql).toBe(
      'INSERT INTO `watchlist` (`full_name`, `list_tag`) VALUES (?, ?)',
    );
    expect(
      episodicInsert([{ caseId: 'PAST-001', pattern: 'structuring', outcome: 'confirmed', summary: 's' }]).sql,
    ).toBe('INSERT INTO `episodic_memory` (`case_id`, `pattern`, `outcome`, `summary`) VALUES (?, ?, ?, ?)');
  });

  it('records a case with its layer, branch and journal ids', () => {
    const statement = caseInsert({
      caseId: 'CASE-0001',
      accountId: 'RNG-0001',
      pattern: 'structuring',
      openedAtMs: Date.UTC(2026, 3, 1),
      layerId: 'layer-1',
      branchId: 'br-1',
      journalId: 'jrn-case-0001',
    });
    expect(statement.params).toEqual(['CASE-0001', 'RNG-0001', 'structuring', '2026-04-01 00:00:00.000', 'layer-1', 'br-1', 'jrn-case-0001']);
  });
});
