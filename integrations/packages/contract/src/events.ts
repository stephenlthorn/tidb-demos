import { z } from 'zod';
import { SlugSchema, type DemoManifest } from './manifest';

const t = z.number().nonnegative();

export const NodeStatusSchema = z.enum(['idle', 'starting', 'healthy', 'busy', 'degraded', 'down', 'done']);
export const CheckStatusSchema = z.enum(['pending', 'pass', 'fail']);
export const LogLevelSchema = z.enum(['info', 'warn', 'error']);

export const MetricEventSchema = z.object({ type: z.literal('metric'), t, id: SlugSchema, value: z.number() });
export const FlowEventSchema = z.object({ type: z.literal('flow'), t, edge: SlugSchema, count: z.number().int().nonnegative() });
export const NodeEventSchema = z.object({ type: z.literal('node'), t, node: SlugSchema, status: NodeStatusSchema, note: z.string().optional() });
export const PhaseEventSchema = z.object({ type: z.literal('phase'), t, phase: SlugSchema });
export const CheckEventSchema = z.object({ type: z.literal('check'), t, id: SlugSchema, status: CheckStatusSchema, observed: z.string().optional() });
export const LogEventSchema = z.object({ type: z.literal('log'), t, level: LogLevelSchema, msg: z.string(), node: SlugSchema.optional() });
export const ControlEventSchema = z.object({ type: z.literal('control'), t, id: SlugSchema });

export const DemoEventSchema = z.discriminatedUnion('type', [
  MetricEventSchema,
  FlowEventSchema,
  NodeEventSchema,
  PhaseEventSchema,
  CheckEventSchema,
  LogEventSchema,
  ControlEventSchema,
]);

export type DemoEvent = z.infer<typeof DemoEventSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

export type ParsedLine =
  | { readonly ok: true; readonly event: DemoEvent }
  | { readonly ok: false; readonly error: string };

const parseJson = (line: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
};

export const parseEventLine = (line: string): ParsedLine => {
  const json = parseJson(line);
  if (!json.ok) return { ok: false, error: `not JSON: ${line.slice(0, 120)}` };
  const result = DemoEventSchema.safeParse(json.value);
  if (result.success) return { ok: true, event: result.data };
  return {
    ok: false,
    error: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
  };
};

const has = (items: readonly { readonly id: string }[], id: string): boolean =>
  items.some((item) => item.id === id);

export const eventReferenceErrors = (manifest: DemoManifest, event: DemoEvent): readonly string[] => {
  switch (event.type) {
    case 'metric':
      return has(manifest.metrics, event.id) ? [] : [`unknown metric: ${event.id}`];
    case 'flow':
      return has(manifest.edges, event.edge) ? [] : [`unknown edge: ${event.edge}`];
    case 'node':
      return has(manifest.nodes, event.node) ? [] : [`unknown node: ${event.node}`];
    case 'phase':
      return has(manifest.phases, event.phase) ? [] : [`unknown phase: ${event.phase}`];
    case 'check':
      return has(manifest.checks, event.id) ? [] : [`unknown check: ${event.id}`];
    case 'control':
      return has(manifest.controls, event.id) ? [] : [`unknown control: ${event.id}`];
    case 'log':
      return event.node === undefined || has(manifest.nodes, event.node) ? [] : [`unknown node: ${event.node}`];
  }
};
