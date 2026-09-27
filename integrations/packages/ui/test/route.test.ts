import { describe, expect, it } from 'vitest';
import { demoHref, isLocalRelay, parseRoute } from '../src/route';

describe('parseRoute', () => {
  it('defaults to the catalog', () => {
    expect(parseRoute('')).toEqual({ page: 'catalog' });
    expect(parseRoute('#/demo/Bad_Id')).toEqual({ page: 'catalog' });
  });

  it('parses a demo route with and without a relay', () => {
    expect(parseRoute('#/demo/kafka')).toEqual({ page: 'demo', id: 'kafka', relay: undefined });
    expect(parseRoute('#/demo/kafka?relay=http://localhost:7070')).toEqual({ page: 'demo', id: 'kafka', relay: 'http://localhost:7070' });
  });

  it('builds demo links', () => {
    expect(demoHref('kafka')).toBe('#/demo/kafka');
  });
});

describe('isLocalRelay', () => {
  it('only trusts loopback relays', () => {
    expect(isLocalRelay('http://localhost:7070')).toBe(true);
    expect(isLocalRelay('http://127.0.0.1:7070')).toBe(true);
    expect(isLocalRelay('https://relay.example.com')).toBe(false);
    expect(isLocalRelay('not a url')).toBe(false);
  });
});
