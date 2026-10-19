import { z } from 'zod';
import type { Account, Alert, GroundTruthEntry, Transaction, WatchlistEntry } from './domain';
import { parseDateTime } from './time';

const PatternSchema = z.enum(['structuring', 'rapid-in-out', 'watchlist-near-match']);

const TransactionRowSchema = z.object({
  txn_id: z.coerce.number(),
  account_id: z.string(),
  counterparty_id: z.string(),
  txn_type: z.enum(['cash_deposit', 'wire_in', 'wire_out', 'card_purchase']),
  amount_cents: z.coerce.number(),
  txn_ts_text: z.string(),
  branch_code: z.string(),
  memo: z.string(),
});

const AccountRowSchema = z.object({
  account_id: z.string(),
  holder_name: z.string(),
  kind: z.enum(['retail', 'business']),
  home_branch: z.string(),
});

const GroundTruthRowSchema = z.object({
  account_id: z.string(),
  pattern: PatternSchema,
  injected_at_text: z.string(),
});

const JsonNumberArraySchema = z
  .union([z.string().transform((text): unknown => JSON.parse(text)), z.array(z.number())])
  .pipe(z.array(z.number()));

const AlertRowSchema = z.object({
  rule_id: PatternSchema,
  rule_version: z.string(),
  account_id: z.string(),
  bucket: z.coerce.number(),
  window_start_text: z.string(),
  window_end_text: z.string(),
  score: z.coerce.number(),
  txn_ids: JsonNumberArraySchema,
  raised_at_text: z.string(),
});

const WatchlistRowSchema = z.object({
  entry_id: z.coerce.number(),
  full_name: z.string(),
  list_tag: z.string(),
});

export const transactionFromRow = (row: unknown): Transaction => {
  const parsed = TransactionRowSchema.parse(row);
  return {
    txnId: parsed.txn_id,
    accountId: parsed.account_id,
    counterpartyId: parsed.counterparty_id,
    txnType: parsed.txn_type,
    amountCents: parsed.amount_cents,
    txnTsMs: parseDateTime(parsed.txn_ts_text),
    branchCode: parsed.branch_code,
    memo: parsed.memo,
  };
};

export const accountFromRow = (row: unknown): Account => {
  const parsed = AccountRowSchema.parse(row);
  return {
    accountId: parsed.account_id,
    holderName: parsed.holder_name,
    kind: parsed.kind,
    homeBranch: parsed.home_branch,
  };
};

export const groundTruthFromRow = (row: unknown): GroundTruthEntry => {
  const parsed = GroundTruthRowSchema.parse(row);
  return { accountId: parsed.account_id, pattern: parsed.pattern, injectedAtMs: parseDateTime(parsed.injected_at_text) };
};

export const alertFromRow = (row: unknown): Alert => {
  const parsed = AlertRowSchema.parse(row);
  return {
    ruleId: parsed.rule_id,
    ruleVersion: parsed.rule_version,
    accountId: parsed.account_id,
    bucket: parsed.bucket,
    windowStartMs: parseDateTime(parsed.window_start_text),
    windowEndMs: parseDateTime(parsed.window_end_text),
    txnIds: parsed.txn_ids,
    score: parsed.score,
    raisedAtMs: parseDateTime(parsed.raised_at_text),
  };
};

export const watchlistEntryFromRow = (row: unknown): WatchlistEntry => {
  const parsed = WatchlistRowSchema.parse(row);
  return { entryId: parsed.entry_id, fullName: parsed.full_name, listTag: parsed.list_tag };
};
