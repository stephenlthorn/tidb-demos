import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { formatEvalObserved, scoreHybridEval } from '../../src/eval-scoring';

const EvalRowSchema = z.object({ triggerText: z.string(), expectedFactId: z.string() });
const evalRows = z
  .array(EvalRowSchema)
  .parse(JSON.parse(readFileSync(fileURLToPath(new URL('./triggers.json', import.meta.url)), 'utf-8')));

describe('scoreHybridEval', () => {
  it('loads the labeled eval set with one row per scripted trigger', () => {
    expect(evalRows.length).toBe(8);
  });

  it('matches every row when the top retrieved fact equals the expected fact', () => {
    const topFactIdForTrigger = new Map(evalRows.map((row) => [row.triggerText, row.expectedFactId]));
    const score = scoreHybridEval({ rows: evalRows, topFactIdForTrigger });
    expect(score.matched).toBe(evalRows.length);
    expect(score.total).toBe(evalRows.length);
    expect(score.results.every((result) => result.matched)).toBe(true);
  });

  it('flags a row whose top retrieved fact does not equal the expected fact', () => {
    const topFactIdForTrigger = new Map(evalRows.map((row) => [row.triggerText, row.expectedFactId]));
    const firstRow = evalRows[0];
    if (firstRow === undefined) throw new Error('eval set must not be empty');
    topFactIdForTrigger.set(firstRow.triggerText, 'wrong-fact-id');
    const score = scoreHybridEval({ rows: evalRows, topFactIdForTrigger });
    expect(score.matched).toBe(evalRows.length - 1);
    const mismatched = score.results.find((result) => result.triggerText === firstRow.triggerText);
    expect(mismatched?.matched).toBe(false);
    expect(mismatched?.actualFactId).toBe('wrong-fact-id');
  });

  it('treats a missing retrieval result as unmatched rather than throwing', () => {
    const score = scoreHybridEval({ rows: evalRows, topFactIdForTrigger: new Map() });
    expect(score.matched).toBe(0);
    expect(score.results.every((result) => result.actualFactId === undefined)).toBe(true);
  });

  it('formats the observed string as "matched/total matched"', () => {
    const score = scoreHybridEval({ rows: evalRows, topFactIdForTrigger: new Map() });
    expect(formatEvalObserved(score)).toBe(`0/${evalRows.length} matched`);
  });
});
