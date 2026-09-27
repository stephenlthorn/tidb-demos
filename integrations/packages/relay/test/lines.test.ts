import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { controlLine, sseMessage, stderrEvent, toLabEvent } from '../src/lines';

describe('toLabEvent', () => {
  it('passes a valid event through unchanged', () => {
    expect(toLabEvent(aManifest(), '{"type":"phase","t":10,"phase":"warmup"}', 99)).toEqual({ type: 'phase', t: 10, phase: 'warmup' });
  });

  it('turns non-JSON into a warning at relay time', () => {
    const event = toLabEvent(aManifest(), 'Listening on 3000', 99);
    expect(event).toMatchObject({ type: 'log', t: 99, level: 'warn' });
    expect(event.type === 'log' ? event.msg : '').toContain('invalid event: not JSON');
  });

  it('turns an unknown metric into a warning', () => {
    const event = toLabEvent(aManifest(), '{"type":"metric","t":1,"id":"ghost","value":1}', 5);
    expect(event.type === 'log' ? event.msg : '').toContain('unknown metric: ghost');
  });

  it('refuses control events coming from a runner', () => {
    const event = toLabEvent(aManifest(), '{"type":"control","t":1,"id":"burst"}', 5);
    expect(event.type === 'log' ? event.msg : '').toContain('runners may not emit control events');
  });
});

describe('framing helpers', () => {
  it('wraps stderr as a warning', () => {
    expect(stderrEvent('boom', 7)).toEqual({ type: 'log', t: 7, level: 'warn', msg: 'boom' });
  });

  it('builds a control line', () => {
    expect(controlLine('burst')).toBe('{"control":"burst"}\n');
  });

  it('frames an SSE message', () => {
    expect(sseMessage({ type: 'phase', t: 0, phase: 'warmup' })).toBe('data: {"type":"phase","t":0,"phase":"warmup"}\n\n');
  });
});
