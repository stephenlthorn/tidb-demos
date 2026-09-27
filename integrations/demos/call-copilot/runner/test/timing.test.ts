import { describe, expect, it } from 'vitest';
import { suggestionLatencyMs, timeToFirstTokenMs } from '../src/timing';

describe('timeToFirstTokenMs', () => {
  it('subtracts request-sent time from first-delta time', () => {
    expect(timeToFirstTokenMs({ requestSentMs: 1_000, firstDeltaMs: 1_320 })).toBe(320);
  });

  it('throws if the first delta arrives before the request was sent', () => {
    expect(() => timeToFirstTokenMs({ requestSentMs: 1_000, firstDeltaMs: 900 })).toThrow();
  });
});

describe('suggestionLatencyMs', () => {
  it('subtracts utterance-end time from first-delta time', () => {
    expect(suggestionLatencyMs({ utteranceEndMs: 2_000, firstDeltaMs: 3_450 })).toBe(1_450);
  });

  it('throws if the first delta arrives before the utterance ended', () => {
    expect(() => suggestionLatencyMs({ utteranceEndMs: 2_000, firstDeltaMs: 1_999 })).toThrow();
  });
});
