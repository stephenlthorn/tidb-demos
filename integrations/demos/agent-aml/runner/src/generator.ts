import type { Account, GroundTruthEntry, Transaction, TxnType, WatchlistEntry } from './domain';
import type { Rng } from './prng';
import { DAY_MS, HOUR_MS } from './time';

export const firstNames: readonly string[] = [
  'Alder', 'Briar', 'Calder', 'Dorian', 'Elspeth', 'Fenner', 'Garrick', 'Hollis', 'Isolde', 'Jarvis',
  'Kestrel', 'Lowen', 'Marlow', 'Nerys', 'Orrin', 'Pelham', 'Quillon', 'Rowan', 'Sabine', 'Tamsin',
];

export const lastNames: readonly string[] = [
  'Ashdown', 'Birchall', 'Copeland', 'Dunmore', 'Eastwick', 'Fairlie', 'Gladwin', 'Harcourt', 'Ingleby', 'Jessop',
  'Kingsley', 'Lovelace', 'Merrow', 'Netherby', 'Oakhurst', 'Penhallow', 'Quenby', 'Redfern', 'Stanhope', 'Thornley',
];

export type Population = {
  readonly accounts: readonly Account[];
  readonly lookAlikeIds: readonly string[];
};

export type Generated = {
  readonly transactions: readonly Transaction[];
  readonly nextTxnId: number;
};

export type Planted = Generated & {
  readonly accounts: readonly Account[];
  readonly truth: readonly GroundTruthEntry[];
};

export type PlantedWatchlist = {
  readonly entry: WatchlistEntry;
  readonly truth: GroundTruthEntry;
};

const branchCode = (index: number): string => `B${String(index).padStart(2, '0')}`;

const accountId = (prefix: string, index: number): string => `${prefix}-${String(index).padStart(4, '0')}`;

const holderName = (rng: Rng): string => `${rng.pick(firstNames)} ${rng.pick(lastNames)}`;

export const buildPopulation = (options: {
  readonly rng: Rng;
  readonly retailCount: number;
  readonly businessCount: number;
  readonly lookAlikeCount: number;
  readonly branchCount: number;
}): Population => {
  const { rng, retailCount, businessCount, lookAlikeCount, branchCount } = options;
  const make = (index: number, kind: Account['kind']): Account => ({
    accountId: accountId('ACC', index + 1),
    holderName: kind === 'business' ? `${holderName(rng)} Trading` : holderName(rng),
    kind,
    homeBranch: branchCode(rng.int(1, branchCount)),
  });
  const retail = Array.from({ length: retailCount }, (_, index) => make(index, 'retail'));
  const business = Array.from({ length: businessCount }, (_, index) => make(retailCount + index, 'business'));
  return {
    accounts: [...retail, ...business],
    lookAlikeIds: business.slice(0, lookAlikeCount).map((account) => account.accountId),
  };
};

const memosByType: Readonly<Record<TxnType, readonly string[]>> = {
  cash_deposit: ['cash gift', 'savings top-up', 'cash deposit'],
  wire_in: ['invoice payment', 'transfer in', 'refund received'],
  wire_out: ['supplier payment', 'rent', 'transfer out'],
  card_purchase: ['groceries', 'fuel', 'dining', 'online shop'],
};

const weightedType = (rng: Rng, kind: Account['kind']): TxnType => {
  const roll = rng.next();
  const [card, cash, wireIn] = kind === 'retail' ? [0.7, 0.8, 0.9] : [0.3, 0.5, 0.75];
  if (roll < card) return 'card_purchase';
  if (roll < cash) return 'cash_deposit';
  if (roll < wireIn) return 'wire_in';
  return 'wire_out';
};

const amountFor = (rng: Rng, txnType: TxnType): number => {
  if (txnType === 'card_purchase') return rng.int(500, 25_000);
  if (txnType === 'cash_deposit') return rng.int(2_000, 200_000);
  return rng.int(5_000, 300_000);
};

const ordinaryTransaction = (options: {
  readonly rng: Rng;
  readonly account: Account;
  readonly dayStartMs: number;
}): Omit<Transaction, 'txnId'> => {
  const { rng, account, dayStartMs } = options;
  const txnType = weightedType(rng, account.kind);
  return {
    accountId: account.accountId,
    counterpartyId: `CP-${String(rng.int(1, 60)).padStart(3, '0')}`,
    txnType,
    amountCents: amountFor(rng, txnType),
    txnTsMs: dayStartMs + rng.int(8 * HOUR_MS, 20 * HOUR_MS - 1),
    branchCode: account.homeBranch,
    memo: rng.pick(memosByType[txnType]),
  };
};

const lookAlikeDeposit = (options: {
  readonly rng: Rng;
  readonly account: Account;
  readonly dayStartMs: number;
  readonly thresholdCents: number;
}): Omit<Transaction, 'txnId'> => ({
  accountId: options.account.accountId,
  counterpartyId: 'CP-TILL',
  txnType: 'cash_deposit',
  amountCents: Math.round(options.thresholdCents * (0.91 + options.rng.next() * 0.075)),
  txnTsMs: options.dayStartMs + options.rng.int(9 * HOUR_MS, 17 * HOUR_MS),
  branchCode: options.account.homeBranch,
  memo: 'till sweep',
});

const numbered = (drafts: readonly Omit<Transaction, 'txnId'>[], firstTxnId: number): Generated => {
  const ordered = [...drafts].sort((a, b) => a.txnTsMs - b.txnTsMs);
  return {
    transactions: ordered.map((draft, index) => ({ ...draft, txnId: firstTxnId + index })),
    nextTxnId: firstTxnId + ordered.length,
  };
};

export const generateDay = (options: {
  readonly rng: Rng;
  readonly dayStartMs: number;
  readonly dayIndex: number;
  readonly population: Population;
  readonly firstTxnId: number;
  readonly thresholdCents: number;
}): Generated => {
  const { rng, dayStartMs, dayIndex, population, firstTxnId, thresholdCents } = options;
  const lookAlike = new Set(population.lookAlikeIds);
  const drafts = population.accounts.flatMap((account, index) => {
    const ordinaryRate = account.kind === 'retail' ? 0.35 : 0.6;
    const ordinary = rng.chance(ordinaryRate) ? [ordinaryTransaction({ rng, account, dayStartMs })] : [];
    const deposits =
      lookAlike.has(account.accountId) && (dayIndex + index) % 2 === 0
        ? [lookAlikeDeposit({ rng, account, dayStartMs, thresholdCents })]
        : [];
    return [...ordinary, ...deposits];
  });
  return numbered(drafts, firstTxnId);
};

export const generateHistory = (options: {
  readonly rng: Rng;
  readonly population: Population;
  readonly days: number;
  readonly firstDayStartMs: number;
  readonly firstTxnId: number;
  readonly thresholdCents: number;
}): Generated => {
  const { rng, population, days, firstDayStartMs, firstTxnId, thresholdCents } = options;
  return Array.from({ length: days }, (_, dayIndex) => dayIndex).reduce<Generated>(
    (acc, dayIndex) => {
      const day = generateDay({
        rng,
        dayStartMs: firstDayStartMs + dayIndex * DAY_MS,
        dayIndex,
        population,
        firstTxnId: acc.nextTxnId,
        thresholdCents,
      });
      return { transactions: [...acc.transactions, ...day.transactions], nextTxnId: day.nextTxnId };
    },
    { transactions: [], nextTxnId: firstTxnId },
  );
};

export const plantStructuringRing = (options: {
  readonly rng: Rng;
  readonly lastDayStartMs: number;
  readonly firstTxnId: number;
  readonly firstAccountNumber: number;
  readonly ringSize: number;
  readonly thresholdCents: number;
  readonly branchCount: number;
}): Planted => {
  const { rng, lastDayStartMs, firstTxnId, firstAccountNumber, ringSize, thresholdCents, branchCount } = options;
  const accounts: readonly Account[] = Array.from({ length: ringSize }, (_, index) => ({
    accountId: accountId('RNG', firstAccountNumber + index),
    holderName: holderName(rng),
    kind: 'retail',
    homeBranch: branchCode(rng.int(1, branchCount)),
  }));
  const dayOffsets: readonly number[] = [4, 3, 2, 1, 0, 0];
  const drafts = accounts.flatMap((account, accountIndex) => {
    const deposits = dayOffsets.map((offset, depositIndex): Omit<Transaction, 'txnId'> => ({
      accountId: account.accountId,
      counterpartyId: 'CP-TILL',
      txnType: 'cash_deposit',
      amountCents: Math.round(thresholdCents * (0.905 + rng.next() * 0.09)),
      txnTsMs: lastDayStartMs - offset * DAY_MS + rng.int(9 * HOUR_MS, 17 * HOUR_MS),
      branchCode: branchCode(((accountIndex + depositIndex) % Math.min(3, branchCount)) + 1),
      memo: 'cash deposit',
    }));
    const swept = deposits.reduce((sum, deposit) => sum + deposit.amountCents, 0);
    const sweep: Omit<Transaction, 'txnId'> = {
      accountId: account.accountId,
      counterpartyId: 'CP-MULE-01',
      txnType: 'wire_out',
      amountCents: Math.round(swept * 0.95),
      txnTsMs: lastDayStartMs + 18 * HOUR_MS,
      branchCode: account.homeBranch,
      memo: 'transfer out',
    };
    return [...deposits, sweep];
  });
  const numberedDrafts = numbered(drafts, firstTxnId);
  return {
    ...numberedDrafts,
    accounts,
    truth: accounts.map((account) => ({
      accountId: account.accountId,
      pattern: 'structuring',
      injectedAtMs: lastDayStartMs,
    })),
  };
};

export const plantRapidInOut = (options: {
  readonly rng: Rng;
  readonly dayStartMs: number;
  readonly firstTxnId: number;
  readonly accountNumber: number;
  readonly branchCount: number;
}): Planted => {
  const { rng, dayStartMs, firstTxnId, accountNumber, branchCount } = options;
  const account: Account = {
    accountId: accountId('PAS', accountNumber),
    holderName: `${holderName(rng)} Holdings`,
    kind: 'business',
    homeBranch: branchCode(rng.int(1, branchCount)),
  };
  const drafts = [0, 1, 2].flatMap((pair): readonly Omit<Transaction, 'txnId'>[] => {
    const incoming = rng.int(2_000_000, 8_000_000);
    const start = dayStartMs + (9 + pair * 4) * HOUR_MS;
    return [
      {
        accountId: account.accountId,
        counterpartyId: `CP-IN-${pair + 1}`,
        txnType: 'wire_in',
        amountCents: incoming,
        txnTsMs: start,
        branchCode: account.homeBranch,
        memo: 'invoice payment',
      },
      {
        accountId: account.accountId,
        counterpartyId: `CP-OUT-${pair + 1}`,
        txnType: 'wire_out',
        amountCents: Math.round(incoming * 0.97),
        txnTsMs: start + 2 * HOUR_MS,
        branchCode: account.homeBranch,
        memo: 'supplier payment',
      },
    ];
  });
  return {
    ...numbered(drafts, firstTxnId),
    accounts: [account],
    truth: [{ accountId: account.accountId, pattern: 'rapid-in-out', injectedAtMs: dayStartMs }],
  };
};

const mutateInterior = (token: string): string => {
  const index = Math.max(1, Math.floor(token.length / 2));
  const original = token[index] ?? 'a';
  const replacement = original === 'a' ? 'e' : 'a';
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
};

const capitalize = (token: string): string => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`;

export const nameVariant = (holder: string): string => {
  const [first, last] = holder.split(' ');
  if (first === undefined || last === undefined) throw new Error(`holder needs two names: ${holder}`);
  return `${capitalize(mutateInterior(last.toLowerCase()))} ${first}`;
};

export const plantWatchlistNearMatch = (options: {
  readonly rng: Rng;
  readonly accounts: readonly Account[];
  readonly firstEntryId: number;
  readonly injectedAtMs: number;
  readonly listTag: string;
}): PlantedWatchlist => {
  const { rng, accounts, firstEntryId, injectedAtMs, listTag } = options;
  const retail = accounts.filter((account) => account.kind === 'retail');
  const target = rng.pick(retail);
  return {
    entry: { entryId: firstEntryId, fullName: nameVariant(target.holderName), listTag },
    truth: { accountId: target.accountId, pattern: 'watchlist-near-match', injectedAtMs },
  };
};
