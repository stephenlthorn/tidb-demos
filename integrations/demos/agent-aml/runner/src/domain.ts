export const REPORTING_THRESHOLD_CENTS = 1_000_000;

export type PatternKind = 'structuring' | 'rapid-in-out' | 'watchlist-near-match';

export const patternKinds: readonly PatternKind[] = ['structuring', 'rapid-in-out', 'watchlist-near-match'];

export type TxnType = 'cash_deposit' | 'wire_in' | 'wire_out' | 'card_purchase';

export type AccountKind = 'retail' | 'business';

export type Account = {
  readonly accountId: string;
  readonly holderName: string;
  readonly kind: AccountKind;
  readonly homeBranch: string;
};

export type Transaction = {
  readonly txnId: number;
  readonly accountId: string;
  readonly counterpartyId: string;
  readonly txnType: TxnType;
  readonly amountCents: number;
  readonly txnTsMs: number;
  readonly branchCode: string;
  readonly memo: string;
};

export type GroundTruthEntry = {
  readonly accountId: string;
  readonly pattern: PatternKind;
  readonly injectedAtMs: number;
};

export type WatchlistEntry = {
  readonly entryId: number;
  readonly fullName: string;
  readonly listTag: string;
};

export type Alert = {
  readonly ruleId: PatternKind;
  readonly ruleVersion: string;
  readonly accountId: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly raisedAtMs: number;
  readonly bucket: number;
  readonly txnIds: readonly number[];
  readonly score: number;
};

export const alertKey = (alert: Pick<Alert, 'ruleId' | 'ruleVersion' | 'accountId' | 'bucket'>): string =>
  `${alert.ruleId}|${alert.ruleVersion}|${alert.accountId}|${alert.bucket}`;
