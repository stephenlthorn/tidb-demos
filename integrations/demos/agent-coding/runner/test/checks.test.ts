import { describe, expect, it } from 'vitest';
import { countVerdict, isolationVerdict, replayVerdict, snapshotsVerdict } from '../src/checks';

const owners = { 'src/idempotency.js': 'attempt-1', 'src/retry.js': 'attempt-3' };

describe('isolationVerdict', () => {
  it('passes when each private file shows only in its own layer', () => {
    const verdict = isolationVerdict({
      owners,
      diffs: {
        'attempt-1': ['/workspace/payments-api/src/charge.js', '/workspace/payments-api/src/idempotency.js'],
        'attempt-2': ['/workspace/payments-api/src/charge.js'],
        'attempt-3': ['/workspace/payments-api/src/retry.js'],
      },
    });
    expect(verdict).toEqual({ pass: true, observed: '2 attempt-private files appear only in their own layer diff' });
  });

  it('fails when one attempt edit shows up in another layer', () => {
    const verdict = isolationVerdict({
      owners,
      diffs: {
        'attempt-1': ['src/idempotency.js'],
        'attempt-2': ['src/idempotency.js'],
        'attempt-3': ['src/retry.js'],
      },
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.observed).toBe('src/idempotency.js written by attempt-1 appears in attempt-2');
  });

  it('fails when an owner diff is missing its own file', () => {
    const verdict = isolationVerdict({ owners, diffs: { 'attempt-1': [], 'attempt-3': ['src/retry.js'] } });
    expect(verdict.observed).toBe('src/idempotency.js missing from attempt-1');
  });

  it('does not treat a longer file name as a match', () => {
    const verdict = isolationVerdict({
      owners: { 'src/retry.js': 'attempt-3' },
      diffs: { 'attempt-1': ['src/backoff-retry.js'], 'attempt-3': ['src/retry.js'] },
    });
    expect(verdict.pass).toBe(true);
  });
});

describe('snapshotsVerdict', () => {
  const snapshot = { dbTime: '2026-10-17T10:00:00.000Z', rowCount: 2000, checksum: '99' };

  it('passes when every branch has the same rows and checksum', () => {
    expect(snapshotsVerdict({ 'attempt-1': snapshot, 'attempt-2': snapshot, 'attempt-3': snapshot }).pass).toBe(true);
  });

  it('names the branch that differs', () => {
    const verdict = snapshotsVerdict({
      'attempt-1': snapshot,
      'attempt-2': { ...snapshot, checksum: '100' },
      'attempt-3': snapshot,
    });
    expect(verdict).toEqual({ pass: false, observed: 'differs from attempt-1: attempt-2' });
  });

  it('fails when nothing was measured', () => {
    expect(snapshotsVerdict({}).pass).toBe(false);
  });
});

describe('replayVerdict', () => {
  const record = { failing: ['a', 'b'], signature: 'ECONNRESET', treeHash: 'h', checksum: 'c' };

  it('passes when the failure, tree and rows all match', () => {
    expect(replayVerdict({ original: record, replay: { ...record } }).pass).toBe(true);
  });

  it('lists every mismatch', () => {
    const verdict = replayVerdict({
      original: record,
      replay: { failing: ['a'], signature: 'AssertionError', treeHash: 'x', checksum: 'y' },
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.observed).toBe(
      'failing tests differ; failure signature differs; file tree differs from the checkpoint record; branch row checksum differs from the ledger record',
    );
  });
});

describe('countVerdict', () => {
  it('passes on equal counts and reports both numbers otherwise', () => {
    expect(countVerdict({ emitted: 26, visible: 26 }).pass).toBe(true);
    expect(countVerdict({ emitted: 26, visible: 20 })).toEqual({
      pass: false,
      observed: '20 visible in Lake but 26 emitted',
    });
  });
});
