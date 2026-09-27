import { describe, expect, it } from 'vitest';
import { advance, createPlayer, seek, togglePlay } from '../src/sources/player';

describe('player', () => {
  it('starts paused at zero', () => {
    expect(createPlayer(60000)).toEqual({ playing: false, speed: 1, positionMs: 0, durationMs: 60000 });
  });

  it('advances by wall time times speed and stops at the end', () => {
    const playing = { ...togglePlay(createPlayer(1000)), speed: 4 };
    expect(advance(playing, 100).positionMs).toBe(400);
    expect(advance(playing, 1000)).toMatchObject({ positionMs: 1000, playing: false });
  });

  it('does not move while paused', () => {
    expect(advance(createPlayer(1000), 500).positionMs).toBe(0);
  });

  it('clamps seeks', () => {
    expect(seek(createPlayer(1000), 5000).positionMs).toBe(1000);
    expect(seek(createPlayer(1000), -5).positionMs).toBe(0);
  });

  it('restarts from zero when play is pressed at the end', () => {
    expect(togglePlay({ playing: false, speed: 1, positionMs: 1000, durationMs: 1000 })).toMatchObject({ playing: true, positionMs: 0 });
  });
});
