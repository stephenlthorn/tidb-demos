export type PlayerState = {
  readonly playing: boolean;
  readonly speed: number;
  readonly positionMs: number;
  readonly durationMs: number;
};

export const SPEEDS: readonly number[] = [1, 2, 4, 8];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const createPlayer = (durationMs: number): PlayerState => ({ playing: false, speed: 1, positionMs: 0, durationMs });

export const advance = (player: PlayerState, wallDeltaMs: number): PlayerState => {
  if (!player.playing) return player;
  const positionMs = Math.min(player.durationMs, player.positionMs + wallDeltaMs * player.speed);
  return { ...player, positionMs, playing: positionMs < player.durationMs };
};

export const seek = (player: PlayerState, positionMs: number): PlayerState => ({
  ...player,
  positionMs: clamp(positionMs, 0, player.durationMs),
});

export const togglePlay = (player: PlayerState): PlayerState =>
  player.positionMs >= player.durationMs ? { ...player, positionMs: 0, playing: true } : { ...player, playing: !player.playing };
