import { describe, expect, it } from 'vitest';
import { parseEventLine } from '@lab/contract';
import { createEmitter } from '../src/emitter';
import { captureLines, clockFrom } from './helpers';

describe('createEmitter', () => {
  it('stamps events with milliseconds since the emitter was created', () => {
    const out = captureLines();
    const emitter = createEmitter({ clock: clockFrom([1000, 1250]), write: out.write });
    emitter.metric('ingest-rate', 42);
    expect(JSON.parse(out.lines[0] ?? '')).toEqual({ type: 'metric', id: 'ingest-rate', value: 42, t: 250 });
  });

  it('writes one newline-terminated line per event that satisfies the contract', () => {
    const out = captureLines();
    const emitter = createEmitter({ clock: clockFrom([0, 1, 2, 3, 4, 5]), write: out.write });
    emitter.flow('source-to-tidb', 10);
    emitter.node('tidb', 'healthy', 'ready');
    emitter.phase('warmup');
    emitter.check('counts-match', 'pass', '100 = 100');
    emitter.log('info', 'started');
    expect(out.lines).toHaveLength(5);
    expect(out.lines.every((line) => line.endsWith('\n'))).toBe(true);
    expect(out.lines.every((line) => parseEventLine(line.trim()).ok)).toBe(true);
  });

  it('omits optional fields that were not given', () => {
    const out = captureLines();
    const emitter = createEmitter({ clock: clockFrom([0, 0]), write: out.write });
    emitter.node('tidb', 'down');
    expect(Object.keys(JSON.parse(out.lines[0] ?? '{}'))).not.toContain('note');
  });

  it('reports elapsed time', () => {
    const emitter = createEmitter({ clock: clockFrom([500, 900]), write: () => undefined });
    expect(emitter.elapsedMs()).toBe(400);
  });
});
