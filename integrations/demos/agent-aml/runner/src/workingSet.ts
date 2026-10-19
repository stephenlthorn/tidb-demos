import type { Account, Alert, PatternKind, Transaction } from './domain';
import { formatCents } from './format';
import type { RecallHit } from './recallSql';

export type PeerSummary = {
  readonly accountsWithBandActivity: number;
  readonly singleBranchAccounts: number;
};

export type PriorCase = {
  readonly caseId: string;
  readonly pattern: string;
  readonly outcome: string;
  readonly rrfScore: number;
};

export type CaseWorkingSet = {
  readonly caseId: string;
  readonly pattern: PatternKind;
  readonly ruleVersion: string;
  readonly accountId: string;
  readonly holderName: string;
  readonly accountKind: string;
  readonly alertScore: number;
  readonly flaggedTxnCount: number;
  readonly flaggedTotalCents: number;
  readonly distinctBranches: number;
  readonly linkedAccounts: readonly string[];
  readonly sharedCounterparties: readonly string[];
  readonly priorCases: readonly PriorCase[];
  readonly peers: PeerSummary;
  readonly facts: Readonly<Record<string, string>>;
};

export const caseIdFor = (sequence: number): string => `CASE-${String(sequence).padStart(4, '0')}`;

export const summarizePeers = (rows: readonly Readonly<Record<string, unknown>>[]): PeerSummary => ({
  accountsWithBandActivity: rows.length,
  singleBranchAccounts: rows.filter((row) => Number(row.branches) === 1).length,
});

export const findLinks = (options: {
  readonly accountId: string;
  readonly transactions: readonly Transaction[];
  readonly maxSharers: number;
}): { readonly accounts: readonly string[]; readonly counterparties: readonly string[] } => {
  const outgoing = options.transactions.filter((txn) => txn.txnType === 'wire_out');
  const sharersByCounterparty = outgoing.reduce(
    (map, txn) => new Map([...map, [txn.counterpartyId, new Set([...(map.get(txn.counterpartyId) ?? []), txn.accountId])]]),
    new Map<string, ReadonlySet<string>>(),
  );
  const shared = [...sharersByCounterparty.entries()].filter(
    ([, sharers]) => sharers.has(options.accountId) && sharers.size > 1 && sharers.size <= options.maxSharers,
  );
  return {
    counterparties: shared.map(([counterparty]) => counterparty).sort(),
    accounts: [...new Set(shared.flatMap(([, sharers]) => [...sharers]))]
      .filter((id) => id !== options.accountId)
      .sort(),
  };
};

export const pickCaseAlert = (options: {
  readonly alerts: readonly Alert[];
  readonly preferred: PatternKind;
  readonly excludeAccounts: readonly string[];
}): Alert | undefined => {
  const open = options.alerts.filter((alert) => !options.excludeAccounts.includes(alert.accountId));
  const ranked = [...open].sort(
    (a, b) =>
      Number(b.ruleId === options.preferred) - Number(a.ruleId === options.preferred) ||
      b.score - a.score ||
      b.raisedAtMs - a.raisedAtMs ||
      a.accountId.localeCompare(b.accountId),
  );
  return ranked[0];
};

export const buildWorkingSet = (options: {
  readonly caseId: string;
  readonly alert: Alert;
  readonly account: Account;
  readonly windowTransactions: readonly Transaction[];
  readonly recallHits: readonly RecallHit[];
  readonly peers: PeerSummary;
  readonly facts: Readonly<Record<string, string>>;
}): CaseWorkingSet => {
  const { alert, account } = options;
  const flagged = options.windowTransactions.filter(
    (txn) => txn.accountId === account.accountId && alert.txnIds.includes(txn.txnId),
  );
  const links = findLinks({ accountId: account.accountId, transactions: options.windowTransactions, maxSharers: 6 });
  return {
    caseId: options.caseId,
    pattern: alert.ruleId,
    ruleVersion: alert.ruleVersion,
    accountId: account.accountId,
    holderName: account.holderName,
    accountKind: account.kind,
    alertScore: alert.score,
    flaggedTxnCount: flagged.length,
    flaggedTotalCents: flagged.reduce((sum, txn) => sum + txn.amountCents, 0),
    distinctBranches: new Set(flagged.map((txn) => txn.branchCode)).size,
    linkedAccounts: links.accounts,
    sharedCounterparties: links.counterparties,
    priorCases: options.recallHits.map((hit) => ({
      caseId: hit.caseId,
      pattern: hit.pattern,
      outcome: hit.outcome,
      rrfScore: hit.rrfScore,
    })),
    peers: options.peers,
    facts: options.facts,
  };
};

const listOrNone = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join(', '));

export const renderNotes = (workingSet: CaseWorkingSet): string =>
  [
    `# ${workingSet.caseId} investigation notes`,
    '',
    `Account: ${workingSet.accountId} (${workingSet.holderName}, ${workingSet.accountKind})`,
    `Rule: ${workingSet.pattern} ${workingSet.ruleVersion}, score ${workingSet.alertScore}`,
    `Flagged transactions: ${workingSet.flaggedTxnCount}, total ${formatCents(workingSet.flaggedTotalCents)}`,
    `Distinct branches in flagged activity: ${workingSet.distinctBranches}`,
    `Linked accounts via shared counterparty: ${listOrNone(workingSet.linkedAccounts)}`,
    `Shared counterparties: ${listOrNone(workingSet.sharedCounterparties)}`,
    `History peers with similar activity: ${workingSet.peers.accountsWithBandActivity}, of which single branch: ${workingSet.peers.singleBranchAccounts}`,
    '',
    '## Similar past cases',
    ...(workingSet.priorCases.length === 0
      ? ['none recalled']
      : workingSet.priorCases.map(
          (prior) => `- ${prior.caseId} (${prior.pattern}, ${prior.outcome}), fused score ${prior.rrfScore.toFixed(4)}`,
        )),
    '',
  ].join('\n');

export const renderDraftReport = (workingSet: CaseWorkingSet): string =>
  [
    `# DRAFT for analyst review: ${workingSet.caseId}`,
    '',
    'Status: draft. Nothing has been filed. A human analyst decides what happens next.',
    '',
    `Subject account ${workingSet.accountId} triggered the ${workingSet.pattern} rule (${workingSet.ruleVersion}).`,
    `The flagged activity covers ${workingSet.flaggedTxnCount} transactions totalling ${formatCents(workingSet.flaggedTotalCents)} across ${workingSet.distinctBranches} branches.`,
    `Accounts sharing an outgoing counterparty: ${listOrNone(workingSet.linkedAccounts)}.`,
    '',
    'This is synthetic data from a demonstration. It makes no compliance or legal determination.',
    '',
  ].join('\n');
