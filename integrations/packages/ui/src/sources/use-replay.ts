import { useEffect, useMemo, useRef, useState } from 'react';
import type { Trace } from '@lab/contract';
import type { DemoState } from '../state/demo-state';
import { foldTo, type Folded } from '../state/replay-fold';
import { advance, createPlayer, seek, togglePlay, type PlayerState } from './player';

export type Replay = {
  readonly player: PlayerState;
  readonly state: DemoState;
  readonly toggle: () => void;
  readonly seekTo: (ms: number) => void;
  readonly setSpeed: (speed: number) => void;
};

export const useReplay = (trace: Trace): Replay => {
  const [player, setPlayer] = useState<PlayerState>(() => createPlayer(trace.durationMs));
  const folded = useRef<Folded | undefined>(undefined);

  useEffect(() => {
    if (!player.playing) return undefined;
    const frame = { id: 0, last: performance.now() };
    const loop = (now: number): void => {
      setPlayer((current) => advance(current, now - frame.last));
      frame.last = now;
      frame.id = requestAnimationFrame(loop);
    };
    frame.id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame.id);
  }, [player.playing]);

  const state = useMemo(() => {
    folded.current = foldTo(trace.manifest, trace.events, folded.current, player.positionMs);
    return folded.current.state;
  }, [trace, player.positionMs]);

  return {
    player,
    state,
    toggle: () => setPlayer(togglePlay),
    seekTo: (ms) => setPlayer((current) => seek(current, ms)),
    setSpeed: (speed) => setPlayer((current) => ({ ...current, speed })),
  };
};
