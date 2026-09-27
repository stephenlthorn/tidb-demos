import { describe, expect, it } from 'vitest';
import { roleForGroups } from '../src/groupRoleMap';

describe('roleForGroups', () => {
  it('returns null when the user is in no tracked group', () => {
    expect(roleForGroups([])).toBeNull();
  });

  it('maps lab_analysts to the analyst role', () => {
    expect(roleForGroups(['lab_analysts'])).toBe('analyst');
  });

  it('maps lab_engineers to the engineer role', () => {
    expect(roleForGroups(['lab_engineers'])).toBe('engineer');
  });

  it('prefers engineer when the user is in both groups', () => {
    expect(roleForGroups(['lab_analysts', 'lab_engineers'])).toBe('engineer');
  });

  it('ignores group names it does not track', () => {
    expect(roleForGroups(['some_other_group'])).toBeNull();
  });
});
