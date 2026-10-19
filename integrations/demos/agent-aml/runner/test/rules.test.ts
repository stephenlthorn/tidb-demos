import { describe, expect, it } from 'vitest';
import type { Account, Transaction, WatchlistEntry } from '../src/domain';
import { baselineRules, candidateStructuring, evaluateRules, parseRuleRow, replayHistory } from '../src/rules';
import { DAY_MS, HOUR_MS } from '../src/time';

const THRESHOLD = 1_000_000;
const day0 = Date.UTC(2026, 2, 2);

const anAccount = (overrides: Partial<Account> = {}): Account => ({
  accountId: 'ACC-1',
  holderName: 'Marlow Quenby',
  kind: 'retail',
  homeBranch: 'B01',
  ...overrides,
});

const aTxn = (overrides: Partial<Transaction> = {}): Transaction => ({
  txnId: 1,
  accountId: 'ACC-1',
  counterpartyId: 'CP-001',
  txnType: 'cash_deposit',
  amountCents: 950_000,
  txnTsMs: day0 + 10 * HOUR_MS,
  branchCode: 'B01',
  memo: 'cash deposit',
  ...overrides,
});

const deposits = (branches: readonly string[]): readonly Transaction[] =>
  branches.map((branchCode, index) => aTxn({ txnId: index + 1, txnTsMs: day0 + index * DAY_MS + 10 * HOUR_MS, branchCode }));

const noWatchlist = new Map<string, readonly WatchlistEntry[]>();

const evaluate = (rules: ReturnType<typeof baselineRules>, transactions: readonly Transaction[], accounts = [anAccount()]) =>
  evaluateRules({ rules, accounts, transactions, asOfMs: day0 + 10 * DAY_MS, watchlistCandidates: noWatchlist });

describe('structuring rule', () => {
  it('flags three near-threshold deposits at one branch under v1', () => {
    const alerts = evaluate(baselineRules(THRESHOLD), deposits(['B01', 'B01', 'B01']));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ ruleId: 'structuring', ruleVersion: 'v1', accountId: 'ACC-1', score: 3 });
  });

  it('does not flag the same single-branch pattern under the v2 candidate', () => {
    const alerts = evaluate([candidateStructuring(THRESHOLD)], deposits(['B01', 'B01', 'B01']));
    expect(alerts).toHaveLength(0);
  });

  it('flags a multi-branch pattern under both versions', () => {
    const spread = deposits(['B01', 'B02', 'B03']);
    expect(evaluate(baselineRules(THRESHOLD), spread)).toHaveLength(1);
    expect(evaluate([candidateStructuring(THRESHOLD)], spread)).toHaveLength(1);
  });

  it('ignores deposits outside the band and at or above the threshold', () => {
    const outside = [
      aTxn({ txnId: 1, amountCents: 500_000 }),
      aTxn({ txnId: 2, amountCents: THRESHOLD, txnTsMs: day0 + DAY_MS }),
      aTxn({ txnId: 3, amountCents: 950_000, txnTsMs: day0 + 2 * DAY_MS }),
    ];
    expect(evaluate(baselineRules(THRESHOLD), outside)).toHaveLength(0);
  });

  it('requires the deposits to fall inside the window', () => {
    const slow = [0, 3, 6].map((offset, index) =>
      aTxn({ txnId: index + 1, txnTsMs: day0 + offset * DAY_MS + 10 * HOUR_MS }),
    );
    expect(evaluate(baselineRules(THRESHOLD), slow)).toHaveLength(0);
  });
});

describe('rapid in-out rule', () => {
  const pair = (index: number, incoming: number): readonly Transaction[] => [
    aTxn({ txnId: index * 2 + 1, txnType: 'wire_in', amountCents: incoming, txnTsMs: day0 + index * 4 * HOUR_MS }),
    aTxn({
      txnId: index * 2 + 2,
      txnType: 'wire_out',
      amountCents: Math.round(incoming * 0.97),
      txnTsMs: day0 + index * 4 * HOUR_MS + 2 * HOUR_MS,
    }),
  ];

  it('flags two or more near-full pass-through pairs inside the window', () => {
    const alerts = evaluate(baselineRules(THRESHOLD), [...pair(0, 3_000_000), ...pair(1, 4_000_000)]);
    expect(alerts.filter((alert) => alert.ruleId === 'rapid-in-out')).toHaveLength(1);
  });

  it('does not flag a single pair', () => {
    const alerts = evaluate(baselineRules(THRESHOLD), pair(0, 3_000_000));
    expect(alerts).toHaveLength(0);
  });

  it('does not flag when the outgoing wire keeps more than the retention limit', () => {
    const keeps = [
      aTxn({ txnId: 1, txnType: 'wire_in', amountCents: 3_000_000 }),
      aTxn({ txnId: 2, txnType: 'wire_out', amountCents: 1_000_000, txnTsMs: day0 + 11 * HOUR_MS }),
      aTxn({ txnId: 3, txnType: 'wire_in', amountCents: 3_000_000, txnTsMs: day0 + 12 * HOUR_MS }),
      aTxn({ txnId: 4, txnType: 'wire_out', amountCents: 1_000_000, txnTsMs: day0 + 13 * HOUR_MS }),
    ];
    expect(evaluate(baselineRules(THRESHOLD), keeps)).toHaveLength(0);
  });
});

describe('watchlist near-match rule', () => {
  const candidates = new Map<string, readonly WatchlistEntry[]>([
    ['ACC-1', [{ entryId: 1, fullName: 'Queaby Marlow', listTag: 'SYNTH' }]],
    ['ACC-2', [{ entryId: 2, fullName: 'Veskar Tolmund', listTag: 'SYNTH' }]],
  ]);
  const accounts = [anAccount(), anAccount({ accountId: 'ACC-2', holderName: 'Rowan Thornley' })];

  it('flags accounts whose name is close to a candidate and leaves weak matches alone', () => {
    const alerts = evaluateRules({
      rules: baselineRules(THRESHOLD),
      accounts,
      transactions: [],
      asOfMs: day0,
      watchlistCandidates: candidates,
    });
    expect(alerts.map((alert) => alert.accountId)).toEqual(['ACC-1']);
    expect(alerts[0]?.bucket).toBe(0);
  });
});

describe('replayHistory', () => {
  it('raises at most one alert per rule version, account and week', () => {
    const alwaysDepositing = Array.from({ length: 14 }, (_, index) =>
      aTxn({ txnId: index + 1, txnTsMs: day0 + index * DAY_MS + 10 * HOUR_MS }),
    );
    const alerts = replayHistory({
      rules: baselineRules(THRESHOLD),
      accounts: [anAccount()],
      transactions: alwaysDepositing,
      watchlistCandidates: noWatchlist,
      firstDayStartMs: day0,
      lastDayStartMs: day0 + 13 * DAY_MS,
      lookbackDays: 14,
    });
    const keys = alerts.map((alert) => `${alert.ruleVersion}|${alert.bucket}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
  });

  it('stamps raisedAtMs with the end of the day the pattern first qualified', () => {
    const alerts = replayHistory({
      rules: baselineRules(THRESHOLD),
      accounts: [anAccount()],
      transactions: deposits(['B01', 'B01', 'B01']),
      watchlistCandidates: noWatchlist,
      firstDayStartMs: day0,
      lastDayStartMs: day0 + 5 * DAY_MS,
      lookbackDays: 14,
    });
    expect(alerts[0]?.raisedAtMs).toBe(day0 + 2 * DAY_MS + DAY_MS - 1);
  });
});

describe('parseRuleRow', () => {
  it('parses a JSON string params column into a typed rule', () => {
    const rule = parseRuleRow({
      rule_id: 'structuring',
      version: 'v2',
      params: JSON.stringify({ thresholdCents: THRESHOLD, bandPct: 10, windowDays: 5, minDeposits: 3, minDistinctBranches: 2 }),
    });
    expect(rule).toMatchObject({ ruleId: 'structuring', version: 'v2' });
  });

  it('rejects params that do not match the rule type', () => {
    expect(() => parseRuleRow({ rule_id: 'rapid-in-out', version: 'v1', params: { windowHours: -1 } })).toThrow();
  });
});
