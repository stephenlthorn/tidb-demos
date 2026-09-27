import { z } from 'zod';
import { DemoManifestSchema } from './manifest';
import { DemoEventSchema } from './events';

export const TraceEnvironmentSchema = z.object({
  tidb: z.string().min(1),
  components: z.record(z.string(), z.string()),
  notes: z.string(),
});

export const TraceSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: DemoManifestSchema,
  recordedAt: z.iso.datetime(),
  environment: TraceEnvironmentSchema,
  durationMs: z.number().nonnegative(),
  events: z.array(DemoEventSchema),
});

export type Trace = z.infer<typeof TraceSchema>;
export type TraceEnvironment = z.infer<typeof TraceEnvironmentSchema>;
