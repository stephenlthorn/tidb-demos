import { describe, expect, it } from 'vitest';
import type { Account, Alert, Transaction } from '../src/domain';
import type { RecallHit } from '../src/recallSql';
import {
  buildWorkingSet,
  caseIdFor,
  findLinks,
  pickCaseAlert,
  renderDraftReport,
  renderNotes,
  summarizePeers,
} from '../src/workingSet';

const account: Account = { accountId: 'RNG-0001', holderName: 'Marlow Quenby', kind: 'retail', homeBranch: 'B01' };

const aTxn = (overrides: Partial<Transaction>): Transaction => ({
  txnId: 1,
  accountId: 'RNG-0001',
  counterpartyId: 'CP-TILL',
  txnType: 'cash_deposit',
  amountCents: 950_000,
  txnTsMs: 0,
  branchCode: 'B01',
  memo: 'cash deposit',
  ...overrides,
});

const alert: Alert = {
  ruleId: 'structuring',
  ruleVersion: 'v1',
  accountId: 'RNG-0001',
  windowStartMs: 0,
  windowEndMs: 0,
  raisedAtMs: 10,
  bucket: 1,
  txnIds: [1, 2, 3],
  score: 3,
};

const transactions: readonly Transaction[] = [
  aTxn({ txnId: 1, branchCode: 'B01' }),
  aTxn({ txnId: 2, branchCode: 'B02', amountCents: 960_000 }),
  aTxn({ txnId: 3, branchCode: 'B03', amountCents: 940_000 }),
  aTxn({ txnId: 4, txnType: 'wire_out', counterpartyId: 'CP-MULE-01', amountCents: 2_700_000 }),
  aTxn({ txnId: 5, accountId: 'RNG-0002', txnType: 'wire_out', counterpartyId: 'CP-MULE-01' }),
  aTxn({ txnId: 6, accountId: 'ACC-0100', txnType: 'wire_out', counterpartyId: 'CP-007' }),
  aTxn({ txnId: 7, accountId: 'RNG-0001', txnType: 'wire_out', counterpartyId: 'CP-007' }),
];

describe('caseIdFor', () => {
  it('zero pads the sequence', () => {
    expect(caseIdFor(7)).toBe('CASE-0007');
  });
});

describe('summarizePeers', () => {
  it('counts peers and the single-branch subset', () => {
    expect(summarizePeers([{ branches: '1' }, { branches: 1 }, { branches: 3 }])).toEqual({
      accountsWithBandActivity: 3,
      singleBranchAccounts: 2,
    });
  });
});

describe('findLinks', () => {
  it('links accounts that share an outgoing counterparty used by a small group', () => {
    expect(findLinks({ accountId: 'RNG-0001', transactions, maxSharers: 6 })).toEqual({
      accounts: ['ACC-0100', 'RNG-0002'],
      counterparties: ['CP-007', 'CP-MULE-01'],
    });
  });

  it('ignores counterparties shared by more accounts than the cap', () => {
    expect(findLinks({ accountId: 'RNG-0001', transactions, maxSharers: 1 })).toEqual({
      accounts: [],
      counterparties: [],
    });
  });
});

describe('pickCaseAlert', () => {
  const other: Alert = { ...alert, ruleId: 'rapid-in-out', accountId: 'PAS-0001', raisedAtMs: 99 };

  it('prefers the requested pattern over a newer alert for another pattern', () => {
    expect(pickCaseAlert({ alerts: [other, alert], preferred: 'structuring', excludeAccounts: [] })?.accountId).toBe(
      'RNG-0001',
    );
  });

  it('ranks a higher score first even when another alert is newer', () => {
    const newerButWeaker: Alert = { ...alert, accountId: 'ACC-0100', score: 3, raisedAtMs: 500 };
    const stronger: Alert = { ...alert, accountId: 'RNG-0002', score: 6, raisedAtMs: 100 };
    expect(
      pickCaseAlert({ alerts: [newerButWeaker, stronger], preferred: 'structuring', excludeAccounts: [] })?.accountId,
    ).toBe('RNG-0002');
  });

  it('skips accounts that already have a case', () => {
    expect(
      pickCaseAlert({ alerts: [other, alert], preferred: 'structuring', excludeAccounts: ['RNG-0001'] })?.accountId,
    ).toBe('PAS-0001');
  });

  it('returns undefined when nothing is open', () => {
    expect(pickCaseAlert({ alerts: [], preferred: 'structuring', excludeAccounts: [] })).toBeUndefined();
  });
});

describe('buildWorkingSet and renderers', () => {
  const hits: readonly RecallHit[] = [
    {
      memoryId: 1,
      caseId: 'PAST-001',
      pattern: 'structuring',
      outcome: 'confirmed',
      summary: 's',
      rrfScore: 0.0328,
      vectorRank: 1,
      fulltextRank: 1,
    },
  ];
  const workingSet = buildWorkingSet({
    caseId: 'CASE-0001',
    alert,
    account,
    windowTransactions: transactions,
    recallHits: hits,
    peers: { accountsWithBandActivity: 4, singleBranchAccounts: 4 },
    facts: { home_branch: 'B01' },
  });

  it('summarizes the flagged activity from the alert transaction ids', () => {
    expect(workingSet).toMatchObject({
      flaggedTxnCount: 3,
      flaggedTotalCents: 2_850_000,
      distinctBranches: 3,
      linkedAccounts: ['ACC-0100', 'RNG-0002'],
    });
  });

  it('renders analyst notes with the recalled cases and peers', () => {
    const notes = renderNotes(workingSet);
    expect(notes).toContain('Flagged transactions: 3, total $28,500.00');
    expect(notes).toContain('- PAST-001 (structuring, confirmed), fused score 0.0328');
    expect(notes).toContain('History peers with similar activity: 4, of which single branch: 4');
  });

  it('renders a draft report that says nothing was filed and makes no determination', () => {
    const report = renderDraftReport(workingSet);
    expect(report).toContain('Nothing has been filed. A human analyst decides what happens next.');
    expect(report).toContain('It makes no compliance or legal determination.');
  });
});
