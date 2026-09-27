import { z } from 'zod';

const PrometheusVectorSampleSchema = z.object({
  metric: z.record(z.string(), z.string()),
  value: z.tuple([z.number(), z.string()]),
});

const PrometheusInstantQueryResponseSchema = z.object({
  status: z.enum(['success', 'error']),
  data: z
    .object({
      resultType: z.string(),
      result: z.array(PrometheusVectorSampleSchema),
    })
    .optional(),
  error: z.string().optional(),
});

export type PrometheusClientOptions = { readonly baseUrl: string };

export type InstantQueryResult = { readonly value: number | undefined };

export type PrometheusClient = {
  readonly instantQuery: (query: string) => Promise<InstantQueryResult>;
};

export const createPrometheusClient = ({ baseUrl }: PrometheusClientOptions): PrometheusClient => ({
  instantQuery: async (query: string): Promise<InstantQueryResult> => {
    const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const rawBody: unknown = await response.json();
    const parsed = PrometheusInstantQueryResponseSchema.parse(rawBody);
    if (parsed.status !== 'success' || parsed.data === undefined) return { value: undefined };
    const first = parsed.data.result[0];
    if (first === undefined) return { value: undefined };
    const [, sampleValue] = first.value;
    return { value: Number(sampleValue) };
  },
});
