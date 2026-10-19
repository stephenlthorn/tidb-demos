import { z } from 'zod';
import { alertKey, type Account, type Alert, type Transaction, type WatchlistEntry } from './domain';
import { nameSimilarity } from './names';
import { DAY_MS, HOUR_MS, weekBucket } from './time';

export const StructuringParamsSchema = z.object({
  thresholdCents: z.number().int().positive(),
  bandPct: z.number().positive().max(50),
  windowDays: z.number().int().positive(),
  minDeposits: z.number().int().min(2),
  minDistinctBranches: z.number().int().min(1),
});

export const RapidInOutParamsSchema = z.object({
  windowHours: z.number().int().positive(),
  retainMaxPct: z.number().min(0).max(50),
  minPairs: z.number().int().min(1),
  minAmountCents: z.number().int().positive(),
});

export const WatchlistParamsSchema = z.object({ minSimilarity: z.number().min(0).max(1) });

export const RuleDefinitionSchema = z.discriminatedUnion('ruleId', [
  z.object({ ruleId: z.literal('structuring'), version: z.string().min(1), params: StructuringParamsSchema }),
  z.object({ ruleId: z.literal('rapid-in-out'), version: z.string().min(1), params: RapidInOutParamsSchema }),
  z.object({ ruleId: z.literal('watchlist-near-match'), version: z.string().min(1), params: WatchlistParamsSchema }),
]);

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;
export type StructuringParams = z.infer<typeof StructuringParamsSchema>;

const parseParams = (params: unknown): unknown => {
  if (typeof params !== 'string') return params;
  try {
    return JSON.parse(params);
  } catch {
    return undefined;
  }
};

export const parseRuleRow = (row: Readonly<Record<string, unknown>>): RuleDefinition =>
  RuleDefinitionSchema.parse({ ruleId: row.rule_id, version: row.version, params: parseParams(row.params) });

export const baselineRules = (thresholdCents: number): readonly RuleDefinition[] => [
  {
    ruleId: 'structuring',
    version: 'v1',
    params: { thresholdCents, bandPct: 10, windowDays: 5, minDeposits: 3, minDistinctBranches: 1 },
  },
  {
    ruleId: 'rapid-in-out',
    version: 'v1',
    params: { windowHours: 24, retainMaxPct: 10, minPairs: 2, minAmountCents: 1_000_000 },
  },
  { ruleId: 'watchlist-near-match', version: 'v1', params: { minSimilarity: 0.85 } },
];

export const candidateStructuring = (thresholdCents: number): RuleDefinition => ({
  ruleId: 'structuring',
  version: 'v2',
  params: { thresholdCents, bandPct: 10, windowDays: 5, minDeposits: 3, minDistinctBranches: 2 },
});

export type EvaluationInput = {
  readonly rules: readonly RuleDefinition[];
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly asOfMs: number;
  readonly watchlistCandidates: ReadonlyMap<string, readonly WatchlistEntry[]>;
};

const byAccount = (transactions: readonly Transaction[]): ReadonlyMap<string, readonly Transaction[]> =>
  transactions.reduce((map, txn) => {
    const existing = map.get(txn.accountId) ?? [];
    return new Map([...map, [txn.accountId, [...existing, txn]]]);
  }, new Map<string, readonly Transaction[]>());

const byTime = (a: Transaction, b: Transaction): number => a.txnTsMs - b.txnTsMs;

const distinctBranches = (window: readonly Transaction[]): number =>
  new Set(window.map((txn) => txn.branchCode)).size;

const evaluateStructuring = (
  rule: Extract<RuleDefinition, { ruleId: 'structuring' }>,
  grouped: ReadonlyMap<string, readonly Transaction[]>,
  asOfMs: number,
): readonly Alert[] => {
  const { thresholdCents, bandPct, windowDays, minDeposits, minDistinctBranches } = rule.params;
  const lower = Math.floor((thresholdCents * (100 - bandPct)) / 100);
  const windowMs = windowDays * DAY_MS;
  return [...grouped.entries()].flatMap(([accountId, txns]) => {
    const deposits = txns
      .filter((txn) => txn.txnType === 'cash_deposit' && txn.amountCents >= lower && txn.amountCents < thresholdCents)
      .sort(byTime);
    const windows = deposits.map((end, endIndex) =>
      deposits.filter((txn, index) => index <= endIndex && end.txnTsMs - txn.txnTsMs <= windowMs),
    );
    const latest = windows
      .filter((window) => window.length >= minDeposits && distinctBranches(window) >= minDistinctBranches)
      .at(-1);
    const first = latest?.[0];
    const last = latest?.at(-1);
    if (latest === undefined || first === undefined || last === undefined) return [];
    return [
      {
        ruleId: 'structuring',
        ruleVersion: rule.version,
        accountId,
        windowStartMs: first.txnTsMs,
        windowEndMs: last.txnTsMs,
        raisedAtMs: asOfMs,
        bucket: weekBucket(last.txnTsMs),
        txnIds: latest.map((txn) => txn.txnId),
        score: latest.length,
      },
    ];
  });
};

type Pairing = {
  readonly used: ReadonlySet<number>;
  readonly pairs: readonly (readonly [Transaction, Transaction])[];
};

const pairWires = (
  incoming: readonly Transaction[],
  outgoing: readonly Transaction[],
  params: Extract<RuleDefinition, { ruleId: 'rapid-in-out' }>['params'],
): Pairing =>
  incoming.reduce<Pairing>(
    (state, wireIn) => {
      const floor = (wireIn.amountCents * (100 - params.retainMaxPct)) / 100;
      const match = outgoing.find(
        (wireOut) =>
          !state.used.has(wireOut.txnId) &&
          wireOut.txnTsMs >= wireIn.txnTsMs &&
          wireOut.txnTsMs - wireIn.txnTsMs <= params.windowHours * HOUR_MS &&
          wireOut.amountCents >= floor &&
          wireOut.amountCents <= wireIn.amountCents,
      );
      if (match === undefined) return state;
      return { used: new Set([...state.used, match.txnId]), pairs: [...state.pairs, [wireIn, match]] };
    },
    { used: new Set<number>(), pairs: [] },
  );

const evaluateRapidInOut = (
  rule: Extract<RuleDefinition, { ruleId: 'rapid-in-out' }>,
  grouped: ReadonlyMap<string, readonly Transaction[]>,
  asOfMs: number,
): readonly Alert[] =>
  [...grouped.entries()].flatMap(([accountId, txns]) => {
    const incoming = txns
      .filter((txn) => txn.txnType === 'wire_in' && txn.amountCents >= rule.params.minAmountCents)
      .sort(byTime);
    const outgoing = txns.filter((txn) => txn.txnType === 'wire_out').sort(byTime);
    const { pairs } = pairWires(incoming, outgoing, rule.params);
    const last = pairs.at(-1)?.[1];
    const first = pairs[0]?.[0];
    if (pairs.length < rule.params.minPairs || first === undefined || last === undefined) return [];
    return [
      {
        ruleId: 'rapid-in-out',
        ruleVersion: rule.version,
        accountId,
        windowStartMs: first.txnTsMs,
        windowEndMs: last.txnTsMs,
        raisedAtMs: asOfMs,
        bucket: weekBucket(last.txnTsMs),
        txnIds: pairs.flatMap(([wireIn, wireOut]) => [wireIn.txnId, wireOut.txnId]),
        score: pairs.length,
      },
    ];
  });

const evaluateWatchlist = (
  rule: Extract<RuleDefinition, { ruleId: 'watchlist-near-match' }>,
  accounts: readonly Account[],
  candidates: ReadonlyMap<string, readonly WatchlistEntry[]>,
  asOfMs: number,
): readonly Alert[] =>
  accounts.flatMap((account) => {
    const best = (candidates.get(account.accountId) ?? []).reduce(
      (top, entry) => Math.max(top, nameSimilarity(account.holderName, entry.fullName)),
      0,
    );
    if (best < rule.params.minSimilarity) return [];
    return [
      {
        ruleId: 'watchlist-near-match',
        ruleVersion: rule.version,
        accountId: account.accountId,
        windowStartMs: asOfMs,
        windowEndMs: asOfMs,
        raisedAtMs: asOfMs,
        bucket: 0,
        txnIds: [],
        score: Math.round(best * 100) / 100,
      },
    ];
  });

export const evaluateRules = (input: EvaluationInput): readonly Alert[] => {
  const visible = input.transactions.filter((txn) => txn.txnTsMs <= input.asOfMs);
  const grouped = byAccount(visible);
  return input.rules.flatMap((rule) => {
    if (rule.ruleId === 'structuring') return evaluateStructuring(rule, grouped, input.asOfMs);
    if (rule.ruleId === 'rapid-in-out') return evaluateRapidInOut(rule, grouped, input.asOfMs);
    return evaluateWatchlist(rule, input.accounts, input.watchlistCandidates, input.asOfMs);
  });
};

export const replayHistory = (options: {
  readonly rules: readonly RuleDefinition[];
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly watchlistCandidates: ReadonlyMap<string, readonly WatchlistEntry[]>;
  readonly firstDayStartMs: number;
  readonly lastDayStartMs: number;
  readonly lookbackDays: number;
}): readonly Alert[] => {
  const dayCount = Math.floor((options.lastDayStartMs - options.firstDayStartMs) / DAY_MS) + 1;
  const days = Array.from({ length: dayCount }, (_, index) => options.firstDayStartMs + index * DAY_MS);
  const seen = new Set<string>();
  return days.flatMap((dayStartMs) => {
    const asOfMs = dayStartMs + DAY_MS - 1;
    const windowStartMs = asOfMs - options.lookbackDays * DAY_MS;
    const fresh = evaluateRules({
      rules: options.rules,
      accounts: options.accounts,
      transactions: options.transactions.filter((txn) => txn.txnTsMs > windowStartMs),
      asOfMs,
      watchlistCandidates: options.watchlistCandidates,
    }).filter((alert) => !seen.has(alertKey(alert)));
    fresh.forEach((alert) => seen.add(alertKey(alert)));
    return fresh;
  });
};
