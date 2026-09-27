import { z } from 'zod';

export type ChangefeedStatus = {
  readonly state: string;
  readonly checkpointTime: string;
  readonly checkpointTso: bigint;
};

export type TicdcApi = {
  readonly getChangefeed: (id: string) => Promise<ChangefeedStatus>;
  readonly pause: (id: string) => Promise<void>;
  readonly resume: (id: string) => Promise<void>;
};

const ChangefeedResponseSchema = z.object({
  state: z.string(),
  checkpoint_time: z.string(),
});

const checkpointTsPattern = /"checkpoint_ts"\s*:\s*(\d+)/;

const extractCheckpointTso = (raw: string): bigint => {
  const found = checkpointTsPattern.exec(raw);
  if (found === null) throw new Error('checkpoint_ts missing from changefeed response');
  const digits = found[1];
  if (digits === undefined) throw new Error('checkpoint_ts missing from changefeed response');
  return BigInt(digits);
};

export const createTicdcApi = (options: { readonly baseUrl: string }): TicdcApi => {
  const getChangefeed = async (id: string): Promise<ChangefeedStatus> => {
    const response = await fetch(`${options.baseUrl}/api/v2/changefeeds/${id}`);
    const raw = await response.text();
    const parsed = ChangefeedResponseSchema.parse(JSON.parse(raw));
    return {
      state: parsed.state,
      checkpointTime: parsed.checkpoint_time,
      checkpointTso: extractCheckpointTso(raw),
    };
  };
  const pause = async (id: string): Promise<void> => {
    await fetch(`${options.baseUrl}/api/v2/changefeeds/${id}/pause`, { method: 'POST' });
  };
  const resume = async (id: string): Promise<void> => {
    await fetch(`${options.baseUrl}/api/v2/changefeeds/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overwrite_checkpoint_ts: 0 }),
    });
  };
  return { getChangefeed, pause, resume };
};
