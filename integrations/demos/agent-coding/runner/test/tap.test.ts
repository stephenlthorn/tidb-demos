import { describe, expect, it } from 'vitest';
import { failureSignature, parseTap } from '../src/tap';

const baselineOutput = [
  'TAP version 13',
  'ok 1 - records one charge for a first request',
  'not ok 2 - a retried request with the same idempotency key records one charge',
  '  code: \'ERR_ASSERTION\'',
  'not ok 3 - a retried request returns the original charge id',
  'ok 4 - different idempotency keys record separate charges',
  '1..4',
].join('\n');

describe('parseTap', () => {
  it('lists failing test names alphabetically and counts passing tests', () => {
    expect(parseTap(baselineOutput)).toEqual({
      failing: [
        'a retried request returns the original charge id',
        'a retried request with the same idempotency key records one charge',
      ],
      passing: 2,
      signature: 'AssertionError',
    });
  });

  it('reports no failures for a clean run', () => {
    expect(parseTap('ok 1 - a\nok 2 - b\n')).toEqual({ failing: [], passing: 2, signature: undefined });
  });
});

describe('failureSignature', () => {
  it('prefers the gateway reset signature', () => {
    expect(failureSignature("not ok 1 - a\n  error: 'connect ECONNRESET 10.0.0.7:443'\n  code: 'ECONNRESET'")).toBe(
      'ECONNRESET',
    );
  });

  it('falls back to an unknown failure', () => {
    expect(failureSignature('not ok 1 - a')).toBe('UnknownFailure');
  });
});
