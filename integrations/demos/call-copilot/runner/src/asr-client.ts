import WebSocket from 'ws';
import { z } from 'zod';

export type AsrWord = { readonly text: string; readonly start: number; readonly end: number; readonly confidence: number };

export type AsrTurn = {
  readonly turnOrder: number;
  readonly transcript: string;
  readonly endOfTurn: boolean;
  readonly words: readonly AsrWord[];
};

export type AsrClient = {
  readonly sendAudio: (chunk: Buffer) => void;
  readonly onTurn: (handler: (turn: AsrTurn) => void) => void;
  readonly close: () => void;
};

const TurnMessageSchema = z.object({
  type: z.literal('Turn'),
  turn_order: z.number().default(0),
  transcript: z.string().default(''),
  end_of_turn: z.boolean().default(false),
  words: z
    .array(
      z.object({
        text: z.string().default(''),
        start: z.number().default(0),
        end: z.number().default(0),
        confidence: z.number().default(0),
      }),
    )
    .default([]),
});

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const parseTurn = (raw: unknown): AsrTurn | undefined => {
  const parsed = TurnMessageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    turnOrder: parsed.data.turn_order,
    transcript: parsed.data.transcript,
    endOfTurn: parsed.data.end_of_turn,
    words: parsed.data.words,
  };
};

export const connectAsrClient = (options: { readonly apiKey: string; readonly speechModel: string }): AsrClient => {
  const url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=${options.speechModel}`;
  const socket = new WebSocket(url, { headers: { Authorization: options.apiKey } });
  const handlers: ((turn: AsrTurn) => void)[] = [];
  socket.on('message', (data) => {
    const turn = parseTurn(parseJson(data.toString()));
    if (turn !== undefined) handlers.forEach((handler) => handler(turn));
  });
  return {
    sendAudio: (chunk) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
    },
    onTurn: (handler) => {
      handlers.push(handler);
    },
    close: () => socket.close(),
  };
};
