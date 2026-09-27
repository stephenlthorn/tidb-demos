import { createInterface } from 'node:readline';
import { z } from 'zod';
import { SlugSchema } from '@lab/contract';

const ControlLineSchema = z.object({ control: SlugSchema });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const parseControlLine = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  const result = ControlLineSchema.safeParse(parseJson(trimmed));
  return result.success ? result.data.control : undefined;
};

export const onControl = (handler: (id: string) => void, input: NodeJS.ReadableStream = process.stdin): void => {
  createInterface({ input }).on('line', (line) => {
    const id = parseControlLine(line);
    if (id !== undefined) handler(id);
  });
};
