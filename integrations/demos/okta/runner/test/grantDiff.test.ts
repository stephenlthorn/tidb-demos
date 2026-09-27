import { describe, expect, it } from 'vitest';
import { findDrift, type ActualAssignment, type DesiredAssignment } from '../src/grantDiff';

const desired = (overrides: Partial<DesiredAssignment> = {}): DesiredAssignment => ({
  username: 'alice',
  role: 'analyst',
  ...overrides,
});

const actual = (overrides: Partial<ActualAssignment> = {}): ActualAssignment => ({
  username: 'alice',
  role: 'analyst',
  exists: true,
  ...overrides,
});

describe('findDrift', () => {
  it('reports no drift when desired and actual match', () => {
    expect(findDrift([desired()], [actual()])).toEqual([]);
  });

  it('reports missing_user when a desired user does not exist in TiDB', () => {
    expect(findDrift([desired()], [])).toEqual([
      { username: 'alice', kind: 'missing_user', desiredRole: 'analyst', actualRole: null },
    ]);
  });

  it('reports wrong_role when the actual role differs from desired', () => {
    expect(findDrift([desired({ role: 'engineer' })], [actual({ role: 'analyst' })])).toEqual([
      { username: 'alice', kind: 'wrong_role', desiredRole: 'engineer', actualRole: 'analyst' },
    ]);
  });

  it('reports orphan_user when a TiDB user is no longer desired', () => {
    expect(findDrift([], [actual()])).toEqual([
      { username: 'alice', kind: 'orphan_user', desiredRole: null, actualRole: 'analyst' },
    ]);
  });

  it('does not report a desired user with a null role as missing', () => {
    expect(findDrift([desired({ role: null })], [])).toEqual([]);
  });
});
