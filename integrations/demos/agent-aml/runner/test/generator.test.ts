import { describe, expect, it } from 'vitest';
import { REPORTING_THRESHOLD_CENTS } from '../src/domain';
import {
  buildPopulation,
  generateDay,
  generateHistory,
  nameVariant,
  plantRapidInOut,
  plantStructuringRing,
  plantWatchlistNearMatch,
} from '../src/generator';
import { nameSimilarity } from '../src/names';
import { createRng } from '../src/prng';
import { DAY_MS } from '../src/time';

const day0 = Date.UTC(2026, 0, 5);
const populationOptions = { retailCount: 40, businessCount: 10, lookAlikeCount: 4, branchCount: 6 };

const aPopulation = (seed: number) => buildPopulation({ rng: createRng(seed), ...populationOptions });

describe('buildPopulation', () => {
  it('is deterministic for a seed', () => {
    expect(aPopulation(7)).toEqual(aPopulation(7));
  });

  it('marks the first business accounts as look-alikes', () => {
    const population = aPopulation(7);
    expect(population.accounts).toHaveLength(50);
    expect(population.lookAlikeIds).toHaveLength(4);
    population.lookAlikeIds.forEach((id) =>
      expect(population.accounts.find((account) => account.accountId === id)?.kind).toBe('business'),
    );
  });
});

describe('generateHistory', () => {
  const population = aPopulation(7);
  const history = generateHistory({
    rng: createRng(11),
    population,
    days: 30,
    firstDayStartMs: day0,
    firstTxnId: 1,
    thresholdCents: REPORTING_THRESHOLD_CENTS,
  });

  it('numbers transactions sequentially from firstTxnId', () => {
    expect(history.transactions[0]?.txnId).toBe(1);
    expect(history.nextTxnId).toBe(history.transactions.length + 1);
  });

  it('keeps ordinary cash deposits well under the near-threshold band', () => {
    const lookAlike = new Set(population.lookAlikeIds);
    const ordinaryCash = history.transactions.filter(
      (txn) => txn.txnType === 'cash_deposit' && !lookAlike.has(txn.accountId),
    );
    ordinaryCash.forEach((txn) => expect(txn.amountCents).toBeLessThan(REPORTING_THRESHOLD_CENTS * 0.5));
  });

  it('makes look-alike accounts deposit just under the threshold at their home branch only', () => {
    const lookAlikeId = population.lookAlikeIds[0] ?? '';
    const home = population.accounts.find((account) => account.accountId === lookAlikeId)?.homeBranch;
    const deposits = history.transactions.filter(
      (txn) => txn.accountId === lookAlikeId && txn.memo === 'till sweep',
    );
    expect(deposits.length).toBeGreaterThan(5);
    deposits.forEach((txn) => {
      expect(txn.amountCents).toBeGreaterThanOrEqual(REPORTING_THRESHOLD_CENTS * 0.91);
      expect(txn.amountCents).toBeLessThan(REPORTING_THRESHOLD_CENTS);
      expect(txn.branchCode).toBe(home);
    });
  });

  it('generates the same history for the same seeds', () => {
    const again = generateHistory({
      rng: createRng(11),
      population: aPopulation(7),
      days: 30,
      firstDayStartMs: day0,
      firstTxnId: 1,
      thresholdCents: REPORTING_THRESHOLD_CENTS,
    });
    expect(again).toEqual(history);
  });
});

describe('generateDay', () => {
  it('stamps every transaction inside the requested day', () => {
    const day = generateDay({
      rng: createRng(3),
      dayStartMs: day0,
      dayIndex: 0,
      population: aPopulation(7),
      firstTxnId: 100,
      thresholdCents: REPORTING_THRESHOLD_CENTS,
    });
    day.transactions.forEach((txn) => {
      expect(txn.txnTsMs).toBeGreaterThanOrEqual(day0);
      expect(txn.txnTsMs).toBeLessThan(day0 + DAY_MS);
    });
  });
});

describe('plantStructuringRing', () => {
  const ring = plantStructuringRing({
    rng: createRng(5),
    lastDayStartMs: day0 + 40 * DAY_MS,
    firstTxnId: 5000,
    firstAccountNumber: 1,
    ringSize: 3,
    thresholdCents: REPORTING_THRESHOLD_CENTS,
    branchCount: 6,
  });

  it('creates ring accounts with ground truth for each', () => {
    expect(ring.accounts).toHaveLength(3);
    expect(ring.truth.map((entry) => entry.pattern)).toEqual(['structuring', 'structuring', 'structuring']);
  });

  it('keeps every deposit under the threshold and inside the band', () => {
    const deposits = ring.transactions.filter((txn) => txn.txnType === 'cash_deposit');
    expect(deposits).toHaveLength(18);
    deposits.forEach((txn) => {
      expect(txn.amountCents).toBeLessThan(REPORTING_THRESHOLD_CENTS);
      expect(txn.amountCents).toBeGreaterThanOrEqual(REPORTING_THRESHOLD_CENTS * 0.9);
    });
  });

  it('spreads each account across at least two branches', () => {
    ring.accounts.forEach((account) => {
      const branches = new Set(
        ring.transactions
          .filter((txn) => txn.accountId === account.accountId && txn.txnType === 'cash_deposit')
          .map((txn) => txn.branchCode),
      );
      expect(branches.size).toBeGreaterThanOrEqual(2);
    });
  });

  it('sweeps most of the deposits to one shared counterparty', () => {
    const sweeps = ring.transactions.filter((txn) => txn.txnType === 'wire_out');
    expect(new Set(sweeps.map((txn) => txn.counterpartyId))).toEqual(new Set(['CP-MULE-01']));
  });
});

describe('plantRapidInOut', () => {
  it('creates three in and out wire pairs that retain about three percent', () => {
    const planted = plantRapidInOut({
      rng: createRng(9),
      dayStartMs: day0 + 30 * DAY_MS,
      firstTxnId: 9000,
      accountNumber: 1,
      branchCount: 6,
    });
    const incoming = planted.transactions.filter((txn) => txn.txnType === 'wire_in');
    const outgoing = planted.transactions.filter((txn) => txn.txnType === 'wire_out');
    expect(incoming).toHaveLength(3);
    expect(outgoing).toHaveLength(3);
    incoming.forEach((txn, index) => {
      const out = outgoing[index];
      expect(out?.amountCents).toBe(Math.round(txn.amountCents * 0.97));
    });
    expect(planted.truth[0]?.pattern).toBe('rapid-in-out');
  });
});

describe('plantWatchlistNearMatch', () => {
  it('builds a list entry that is similar to an existing retail holder but not identical', () => {
    const population = aPopulation(7);
    const planted = plantWatchlistNearMatch({
      rng: createRng(13),
      accounts: population.accounts,
      firstEntryId: 100,
      injectedAtMs: day0,
      listTag: 'SYNTH-LIVE',
    });
    const holder = population.accounts.find((account) => account.accountId === planted.truth.accountId);
    expect(holder?.kind).toBe('retail');
    const similarity = nameSimilarity(holder?.holderName ?? '', planted.entry.fullName);
    expect(similarity).toBeGreaterThan(0.85);
    expect(similarity).toBeLessThan(1);
    expect(planted.truth.pattern).toBe('watchlist-near-match');
  });
});

describe('nameVariant', () => {
  it('swaps the order and alters one letter of the family name', () => {
    expect(nameVariant('Marlow Quenby')).toBe('Queaby Marlow');
  });
});
