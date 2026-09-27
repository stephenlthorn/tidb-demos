import { describe, expect, it } from 'vitest';
import { formatSseId, parseSseId } from '../src/sse';

describe('SSE event ids', () => {
  it('round-trips a run id and history index', () => {
    expect(formatSseId('k2x9', 12)).toBe('k2x9.12');
    expect(parseSseId('k2x9.12')).toEqual({ runId: 'k2x9', index: 12 });
  });

  it('rejects malformed ids', () => {
    expect(parseSseId(undefined)).toBeUndefined();
    expect(parseSseId('')).toBeUndefined();
    expect(parseSseId('12')).toBeUndefined();
    expect(parseSseId('run.-1')).toBeUndefined();
    expect(parseSseId('run.abc')).toBeUndefined();
  });
});
