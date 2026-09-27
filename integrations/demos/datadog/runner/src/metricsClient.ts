import { z } from 'zod';

export type MetricsClientOptions = { readonly apiKey: string; readonly appKey: string; readonly site: string };

export type MetricsClient = { readonly latestValue: (query: string) => Promise<number | undefined> };

const QueryResponseSchema = z.object({
  series: z.array(z.object({ pointlist: z.array(z.tuple([z.number(), z.number().nullable()])) })),
});

export const createMetricsClient = ({ apiKey, appKey, site }: MetricsClientOptions): MetricsClient => ({
  latestValue: async (query: string): Promise<number | undefined> => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60;
    const url = `https://api.${site}/api/v1/query?from=${from}&to=${to}&query=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey } });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`datadog metrics query failed: ${response.status} ${text.slice(0, 500)}`);
    }
    const body = QueryResponseSchema.parse(await response.json());
    const series = body.series[0];
    if (series === undefined) return undefined;
    const lastPoint = series.pointlist[series.pointlist.length - 1];
    if (lastPoint === undefined) return undefined;
    return lastPoint[1] ?? undefined;
  },
});
