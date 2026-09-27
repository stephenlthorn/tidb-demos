import { describe, expect, it } from 'vitest';
import { isScannable, parseDenylist, scanText } from '../src/public-check';

const internalWiki = ['https://example', 'feishu', 'cn/wiki/abc'].join('.');

describe('parseDenylist', () => {
  it('drops blank lines and comments', () => {
    expect(parseDenylist('# customers\nAcme Rockets\n\n  Globex  \n')).toEqual(['Acme Rockets', 'Globex']);
  });
});

describe('scanText', () => {
  it('flags a denylisted name by entry number, never by name', () => {
    const findings = scanText({ file: 'README.md', text: 'intro\nwe migrated Acme Rockets to TiDB', denylist: ['Acme Rockets'] });
    expect(findings).toEqual([{ file: 'README.md', line: 2, match: 'denylist entry 1' }]);
  });

  it('matches whole words only', () => {
    expect(scanText({ file: 'a.md', text: 'Acme Rocketship', denylist: ['Acme Rockets'] })).toEqual([]);
  });

  it('flags internal URLs', () => {
    expect(scanText({ file: 'a.md', text: `see ${internalWiki}`, denylist: [] })).toHaveLength(1);
  });
});

describe('isScannable', () => {
  it('skips binary assets and lockfiles', () => {
    expect(isScannable('demos/kafka/README.md')).toBe(true);
    expect(isScannable('packages/ui/public/logo.png')).toBe(false);
    expect(isScannable('pnpm-lock.yaml')).toBe(false);
  });
});
