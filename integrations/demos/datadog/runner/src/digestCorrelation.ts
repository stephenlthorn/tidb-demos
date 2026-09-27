export type StatementSummaryRow = { readonly QUERY_SAMPLE_TEXT: string; readonly DIGEST: string };

export const findMatchingDigestRow = (options: {
  readonly spanSql: string;
  readonly rows: readonly StatementSummaryRow[];
}): StatementSummaryRow | undefined => options.rows.find((row) => row.QUERY_SAMPLE_TEXT === options.spanSql);
