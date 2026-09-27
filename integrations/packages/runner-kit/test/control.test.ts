import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { onControl, parseControlLine } from '../src/control';
import { sleep } from '../src/timing';

describe('parseControlLine', () => {
  it('returns the control id', () => {
    expect(parseControlLine('{"control":"burst"}')).toBe('burst');
  });

  it('ignores blank lines, bad JSON and bad ids', () => {
    expect(parseControlLine('')).toBeUndefined();
    expect(parseControlLine('not json')).toBeUndefined();
    expect(parseControlLine('{"control":"Not Kebab"}')).toBeUndefined();
    expect(parseControlLine('{"other":"burst"}')).toBeUndefined();
  });
});

describe('onControl', () => {
  it('calls the handler once per valid control line', async () => {
    const input = new PassThrough();
    const received: string[] = [];
    onControl((id) => { received.push(id); }, input);
    input.write('{"control":"burst"}\n');
    input.write('garbage\n');
    input.write('{"control":"kill-ingester"}\n');
    await sleep(20);
    expect(received).toEqual(['burst', 'kill-ingester']);
  });
});
