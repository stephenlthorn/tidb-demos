import { describe, expect, it } from 'vitest';
import { changedPaths, stripPrefix, treeHash } from '../src/tree';

describe('treeHash', () => {
  it('does not depend on key order', () => {
    expect(treeHash({ a: '1', b: '2' })).toBe(treeHash({ b: '2', a: '1' }));
  });

  it('changes when content changes', () => {
    expect(treeHash({ a: '1' })).not.toBe(treeHash({ a: '2' }));
  });

  it('distinguishes a path split from a content shift', () => {
    expect(treeHash({ ab: 'c' })).not.toBe(treeHash({ a: 'bc' }));
  });
});

describe('changedPaths', () => {
  it('lists modified, added and removed files', () => {
    expect(changedPaths({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' })).toEqual(['b', 'c', 'd']);
  });

  it('is empty for identical trees', () => {
    expect(changedPaths({ a: '1' }, { a: '1' })).toEqual([]);
  });
});

describe('stripPrefix', () => {
  it('removes a directory prefix', () => {
    expect(stripPrefix('/workspace/payments-api/src/a.js', '/workspace/payments-api')).toBe('src/a.js');
  });

  it('leaves other paths alone', () => {
    expect(stripPrefix('/other/a.js', '/workspace')).toBe('/other/a.js');
  });
});
