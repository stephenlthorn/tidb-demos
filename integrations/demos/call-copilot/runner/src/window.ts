export type Turn = {
  readonly speaker: string;
  readonly text: string;
  readonly endedAtMs: number;
};

export type TurnWindow = {
  readonly add: (turn: Turn) => void;
  readonly turns: () => readonly Turn[];
  readonly joinedText: () => string;
};

export const createTurnWindow = (options: { readonly windowMs: number }): TurnWindow => {
  const buffer: Turn[] = [];
  const add = (turn: Turn): void => {
    buffer.push(turn);
    const newestMs = turn.endedAtMs;
    let oldest = buffer[0];
    while (oldest !== undefined && newestMs - oldest.endedAtMs > options.windowMs) {
      buffer.shift();
      oldest = buffer[0];
    }
  };
  const turns = (): readonly Turn[] => [...buffer];
  const joinedText = (): string => buffer.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n');
  return { add, turns, joinedText };
};
