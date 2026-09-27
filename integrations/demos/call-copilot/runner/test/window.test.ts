import { describe, expect, it } from 'vitest';
import { createTurnWindow } from '../src/window';

describe('createTurnWindow', () => {
  it('starts empty', () => {
    const window = createTurnWindow({ windowMs: 60_000 });
    expect(window.turns()).toEqual([]);
  });

  it('keeps turns added within the window', () => {
    const window = createTurnWindow({ windowMs: 60_000 });
    window.add({ speaker: 'prospect', text: 'How does TiDB handle failover?', endedAtMs: 1_000 });
    expect(window.turns()).toHaveLength(1);
    expect(window.turns()[0]?.text).toBe('How does TiDB handle failover?');
  });

  it('evicts turns older than windowMs relative to the newest turn', () => {
    const window = createTurnWindow({ windowMs: 5_000 });
    window.add({ speaker: 'se', text: 'first turn', endedAtMs: 0 });
    window.add({ speaker: 'prospect', text: 'second turn', endedAtMs: 6_000 });
    expect(window.turns()).toHaveLength(1);
    expect(window.turns()[0]?.text).toBe('second turn');
  });

  it('joinedText concatenates turns in order with a speaker prefix', () => {
    const window = createTurnWindow({ windowMs: 60_000 });
    window.add({ speaker: 'se', text: 'Let me walk you through it.', endedAtMs: 0 });
    window.add({ speaker: 'prospect', text: 'Sounds good.', endedAtMs: 1_000 });
    expect(window.joinedText()).toBe('se: Let me walk you through it.\nprospect: Sounds good.');
  });
});
