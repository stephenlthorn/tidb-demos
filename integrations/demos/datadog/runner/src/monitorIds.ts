import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const MonitorIdsSchema = z.record(z.string(), z.number());

export type MonitorIds = z.infer<typeof MonitorIdsSchema>;

export const loadMonitorIds = async (path: string): Promise<MonitorIds> => {
  try {
    const text = await readFile(path, 'utf8');
    return MonitorIdsSchema.parse(JSON.parse(text));
  } catch {
    return {};
  }
};
