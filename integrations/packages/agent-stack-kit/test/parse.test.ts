import { describe, expect, it } from 'vitest';
import {
  parseBranch,
  parseBranchList,
  parseCheckpoint,
  parseJournalVerify,
  parseLayerDiff,
  parseLayerId,
} from '../src/parse';

describe('parseLayerId', () => {
  it('reads layer_id from JSON output', () => {
    expect(parseLayerId('{"layer_id":"lyr_9f2c","layer_name":"task","base_root_path":"/workspace"}')).toBe('lyr_9f2c');
  });

  it('finds a nested layer id', () => {
    expect(parseLayerId('{"layer":{"layerId":"lyr_nested"}}')).toBe('lyr_nested');
  });

  it('reads a labelled text line', () => {
    expect(parseLayerId('created layer\nlayer_id: lyr_text-1\nname: task')).toBe('lyr_text-1');
  });

  it('throws when no layer id is present', () => {
    expect(() => parseLayerId('{"ok":true}')).toThrow('layer id not found in output');
  });
});

describe('parseCheckpoint', () => {
  it('reads checkpoint_id from JSON output', () => {
    expect(parseCheckpoint('{"checkpoint_id":"step-03","layer_id":"lyr_1"}')).toEqual({ checkpointId: 'step-03' });
  });

  it('reads a labelled text line', () => {
    expect(parseCheckpoint('checkpoint id = seed')).toEqual({ checkpointId: 'seed' });
  });

  it('throws when no checkpoint id is present', () => {
    expect(() => parseCheckpoint('done')).toThrow('checkpoint id not found in output');
  });
});

describe('parseLayerDiff', () => {
  it('returns sorted unique paths from an array of change objects', () => {
    const stdout = JSON.stringify({
      changes: [
        { op: 'write', path: '/workspace/payments-api/src/charge.js' },
        { op: 'create', path: '/workspace/payments-api/src/idempotency.js' },
        { op: 'write', path: '/workspace/payments-api/src/charge.js' },
      ],
    });
    expect(parseLayerDiff(stdout)).toEqual([
      '/workspace/payments-api/src/charge.js',
      '/workspace/payments-api/src/idempotency.js',
    ]);
  });

  it('accepts a bare array of path strings', () => {
    expect(parseLayerDiff('["/b","/a"]')).toEqual(['/a', '/b']);
  });

  it('returns an empty list for an empty change set', () => {
    expect(parseLayerDiff('{"changes":[]}')).toEqual([]);
  });

  it('falls back to the last absolute path on each text line', () => {
    expect(parseLayerDiff('M /workspace/a.js\nA /workspace/b.js\n')).toEqual(['/workspace/a.js', '/workspace/b.js']);
  });
});

describe('parseJournalVerify', () => {
  it('reads a boolean flag', () => {
    expect(parseJournalVerify('{"ok":true,"entries":12}')).toEqual({ ok: true });
    expect(parseJournalVerify('{"valid":false}')).toEqual({ ok: false });
  });

  it('reads a status string', () => {
    expect(parseJournalVerify('{"status":"verified"}')).toEqual({ ok: true });
    expect(parseJournalVerify('{"status":"hash mismatch"}')).toEqual({ ok: false });
  });

  it('reads plain text', () => {
    expect(parseJournalVerify('journal verified')).toEqual({ ok: true });
    expect(parseJournalVerify('hash chain broken at entry 4')).toEqual({ ok: false });
  });

  it('throws on output it cannot classify', () => {
    expect(() => parseJournalVerify('???')).toThrow('journal verification result not found in output');
  });
});

describe('parseBranch', () => {
  it('reads branchId and state from JSON output', () => {
    expect(parseBranch('{"branchId":"br_123","displayName":"a1","state":"CREATING"}')).toEqual({
      branchId: 'br_123',
      state: 'CREATING',
    });
  });

  it('reads labelled text output', () => {
    expect(parseBranch('Branch ID: br_456\nState: ACTIVE\n')).toEqual({ branchId: 'br_456', state: 'ACTIVE' });
  });

  it('reports UNKNOWN when no state is printed', () => {
    expect(parseBranch('{"branch_id":"br_789"}')).toEqual({ branchId: 'br_789', state: 'UNKNOWN' });
  });

  it('throws when no branch id is present', () => {
    expect(() => parseBranch('created')).toThrow('branch id not found in output');
  });
});

describe('parseBranchList', () => {
  it('reads branches with endpoint details', () => {
    const stdout = JSON.stringify({
      branches: [
        {
          branchId: 'br_1',
          state: 'ACTIVE',
          userPrefix: '3pTAoNNegb47Uc8',
          endpoints: { public: { host: 'gateway01.us-east-1.prod.aws.tidbcloud.com', port: 4000 } },
        },
        { branchId: 'br_2', state: 'CREATING' },
      ],
    });
    expect(parseBranchList(stdout)).toEqual([
      {
        branchId: 'br_1',
        state: 'ACTIVE',
        host: 'gateway01.us-east-1.prod.aws.tidbcloud.com',
        port: 4000,
        userPrefix: '3pTAoNNegb47Uc8',
      },
      { branchId: 'br_2', state: 'CREATING', host: undefined, port: undefined, userPrefix: undefined },
    ]);
  });

  it('accepts a top-level array', () => {
    expect(parseBranchList('[{"id":"br_9","state":"ACTIVE"}]').map((branch) => branch.branchId)).toEqual(['br_9']);
  });

  it('throws when the output is not JSON', () => {
    expect(() => parseBranchList('table output')).toThrow('branch list not found in output');
  });
});
