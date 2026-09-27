import { z } from 'zod';

export type MonitorClientOptions = { readonly apiKey: string; readonly appKey: string; readonly site: string };

export type MonitorState = { readonly id: number; readonly overallState: string };

export type MonitorClient = {
  readonly create: (definition: Readonly<Record<string, unknown>>) => Promise<number>;
  readonly get: (id: number) => Promise<MonitorState>;
  readonly remove: (id: number) => Promise<void>;
};

const CreateMonitorResponseSchema = z.object({ id: z.number() });

const MonitorStateResponseSchema = z.object({ id: z.number(), overall_state: z.string() });

const readErrorBody = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.slice(0, 500);
};

export const createMonitorClient = ({ apiKey, appKey, site }: MonitorClientOptions): MonitorClient => {
  const authHeaders = { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey };
  const base = `https://api.${site}/api/v1/monitor`;
  const create = async (definition: Readonly<Record<string, unknown>>): Promise<number> => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(definition),
    });
    if (!response.ok) throw new Error(`datadog monitor create failed: ${response.status} ${await readErrorBody(response)}`);
    return CreateMonitorResponseSchema.parse(await response.json()).id;
  };
  const get = async (id: number): Promise<MonitorState> => {
    const response = await fetch(`${base}/${id}`, { headers: authHeaders });
    if (!response.ok) throw new Error(`datadog monitor get failed: ${response.status} ${await readErrorBody(response)}`);
    const body = MonitorStateResponseSchema.parse(await response.json());
    return { id: body.id, overallState: body.overall_state };
  };
  const remove = async (id: number): Promise<void> => {
    const response = await fetch(`${base}/${id}`, { method: 'DELETE', headers: authHeaders });
    if (!response.ok) throw new Error(`datadog monitor delete failed: ${response.status} ${await readErrorBody(response)}`);
  };
  return { create, get, remove };
};
