import { describe, expect, it } from 'vitest';
import { eventReferenceErrors, parseEventLine } from '../src/events';
import { aManifest } from './fixtures';

describe('parseEventLine', () => {
  it('parses a valid metric event', () => {
    expect(parseEventLine('{"type":"metric","t":1000,"id":"ingest-rate","value":42}')).toEqual({
      ok: true,
      event: { type: 'metric', t: 1000, id: 'ingest-rate', value: 42 },
    });
  });

  it('reports input that is not JSON', () => {
    const parsed = parseEventLine('hello world');
    expect(parsed.ok ? '' : parsed.error).toContain('not JSON');
  });

  it('rejects an unknown event type', () => {
    expect(parseEventLine('{"type":"banana","t":0}').ok).toBe(false);
  });

  it('rejects a negative flow count', () => {
    expect(parseEventLine('{"type":"flow","t":5,"edge":"source-to-tidb","count":-1}').ok).toBe(false);
  });

  it('rejects a negative timestamp', () => {
    expect(parseEventLine('{"type":"phase","t":-1,"phase":"warmup"}').ok).toBe(false);
  });
});

describe('eventReferenceErrors', () => {
  it('returns no errors for ids declared in the manifest', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'flow', t: 0, edge: 'source-to-tidb', count: 5 })).toEqual([]);
  });

  it('flags a metric id missing from the manifest', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'metric', t: 0, id: 'nope', value: 1 })).toEqual([
      'unknown metric: nope',
    ]);
  });

  it('flags an unknown control id', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'control', t: 0, id: 'launch' })).toEqual([
      'unknown control: launch',
    ]);
  });

  it('accepts a log event without a node', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'log', t: 0, level: 'info', msg: 'hi' })).toEqual([]);
  });

  it('flags a log event that names an unknown node', () => {
    expect(eventReferenceErrors(aManifest(), { type: 'log', t: 0, level: 'info', msg: 'hi', node: 'ghost' })).toEqual([
      'unknown node: ghost',
    ]);
  });
});
