import { describe, expect, it } from 'vitest';
import { selectNewEvents } from '../src/eventCursor';

describe('selectNewEvents', () => {
  it('returns all events when nothing has been seen yet', () => {
    const events = [{ uuid: 'a', published: '2026-01-01T00:00:00.000Z' }];
    expect(selectNewEvents(events, new Set())).toEqual(events);
  });

  it('drops an event whose uuid was already seen', () => {
    const events = [{ uuid: 'a', published: '2026-01-01T00:00:00.000Z' }];
    expect(selectNewEvents(events, new Set(['a']))).toEqual([]);
  });

  it('keeps only the unseen events when the Okta System Log re-returns an already-processed event at the same since timestamp', () => {
    const events = [
      { uuid: 'a', published: '2026-01-01T00:00:00.000Z' },
      { uuid: 'b', published: '2026-01-01T00:00:00.000Z' },
    ];
    expect(selectNewEvents(events, new Set(['a']))).toEqual([events[1]]);
  });
});
