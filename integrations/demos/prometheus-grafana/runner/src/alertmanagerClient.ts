import { z } from 'zod';

const AlertmanagerAlertSchema = z.object({
  labels: z.record(z.string(), z.string()),
});

const AlertmanagerAlertsResponseSchema = z.array(AlertmanagerAlertSchema);

export type AlertmanagerClientOptions = { readonly baseUrl: string };

export type AlertmanagerClient = {
  readonly activeAlertNames: () => Promise<readonly string[]>;
};

export const createAlertmanagerClient = ({ baseUrl }: AlertmanagerClientOptions): AlertmanagerClient => ({
  activeAlertNames: async (): Promise<readonly string[]> => {
    const url = `${baseUrl}/api/v2/alerts?active=true&silenced=false&inhibited=false&unprocessed=true`;
    const response = await fetch(url);
    const rawBody: unknown = await response.json();
    const parsed = AlertmanagerAlertsResponseSchema.parse(rawBody);
    return parsed
      .map((alert) => alert.labels.alertname)
      .filter((alertname): alertname is string => alertname !== undefined);
  },
});
