import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';

export type AudioSource = {
  readonly onChunk: (handler: (chunk: Buffer) => void) => void;
  readonly onEnd: (handler: () => void) => void;
  readonly stop: () => void;
};

export const startMicCapture = (options: { readonly deviceName: string }): AudioSource => {
  const proc = spawn('rec', [
    '-q',
    '-t',
    'raw',
    '-r',
    '16000',
    '-e',
    'signed-integer',
    '-b',
    '16',
    '-c',
    '1',
    '-d',
    options.deviceName,
    '-',
  ]);
  const handlers: ((chunk: Buffer) => void)[] = [];
  const endHandlers: (() => void)[] = [];
  proc.stdout.on('data', (chunk: Buffer) => handlers.forEach((handler) => handler(chunk)));
  proc.on('close', () => endHandlers.forEach((handler) => handler()));
  return {
    onChunk: (handler) => {
      handlers.push(handler);
    },
    onEnd: (handler) => {
      endHandlers.push(handler);
    },
    stop: () => {
      proc.kill('SIGTERM');
    },
  };
};

export const startFixtureCapture = (options: { readonly wavPath: string; readonly chunkBytes: number }): AudioSource => {
  const stream = createReadStream(options.wavPath, { start: 44, highWaterMark: options.chunkBytes });
  const handlers: ((chunk: Buffer) => void)[] = [];
  const endHandlers: (() => void)[] = [];
  stream.on('data', (chunk) => {
    if (Buffer.isBuffer(chunk)) handlers.forEach((handler) => handler(chunk));
  });
  stream.on('end', () => endHandlers.forEach((handler) => handler()));
  return {
    onChunk: (handler) => {
      handlers.push(handler);
    },
    onEnd: (handler) => {
      endHandlers.push(handler);
    },
    stop: () => {
      stream.close();
    },
  };
};
