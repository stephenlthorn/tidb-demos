import { createServer } from 'node:http';
import { z } from 'zod';

const AlertmanagerWebhookAlertSchema = z.object({
  status: z.enum(['firing', 'resolved']),
  labels: z.record(z.string(), z.string()),
});

const AlertmanagerWebhookBodySchema = z.object({
  alerts: z.array(AlertmanagerWebhookAlertSchema),
});

export type AlertArrival = { readonly alertname: string; readonly status: string; readonly receivedAtMs: number };

export type WebhookReceiver = {
  readonly arrivals: () => readonly AlertArrival[];
  readonly close: () => void;
};

export const createWebhookReceiver = (options: { readonly port: number; readonly now?: () => number }): WebhookReceiver => {
  const now = options.now ?? Date.now;
  const arrivals: AlertArrival[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const parsed = AlertmanagerWebhookBodySchema.safeParse(rawBody);
      if (parsed.success) {
        parsed.data.alerts.forEach((alert) => {
          const alertname = alert.labels.alertname;
          if (alertname !== undefined) arrivals.push({ alertname, status: alert.status, receivedAtMs: now() });
        });
      }
      response.writeHead(200).end();
    });
  });
  server.listen(options.port);
  return { arrivals: () => arrivals, close: () => server.close() };
};
