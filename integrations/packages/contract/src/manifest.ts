import { z } from 'zod';

export const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case');

export const NodeKindSchema = z.enum([
  'tidb',
  'source',
  'sink',
  'queue',
  'service',
  'identity',
  'cloud',
  'client',
  'cache',
  'observability',
]);

export const ManifestNodeSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  kind: NodeKindSchema,
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
});

export const ManifestEdgeSchema = z.object({
  id: SlugSchema,
  from: SlugSchema,
  to: SlugSchema,
  label: z.string().min(1),
  unit: z.string().min(1),
});

export const MetricUnitSchema = z.enum([
  'rows/s',
  'msgs/s',
  'req/s',
  'ms',
  's',
  '%',
  'count',
  'rows',
  'MB',
  'USD',
]);

export const ManifestMetricSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  unit: MetricUnitSchema,
  display: z.enum(['tile', 'series', 'both']),
  better: z.enum(['higher', 'lower', 'neutral']),
  target: z.number().optional(),
  group: z.string().min(1).optional(),
  howMeasured: z.string().min(1),
});

export const ManifestPhaseSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  narration: z.string().min(1),
});

export const ManifestCheckSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  description: z.string().min(1),
});

export const ManifestControlSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1),
  description: z.string().min(1),
});

export const RunnerSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).default('.'),
});

const duplicateIds = (ids: readonly string[]): readonly string[] =>
  ids.filter((id, index) => ids.indexOf(id) !== index);

export const DemoManifestSchema = z
  .object({
    id: SlugSchema,
    number: z.number().int().min(0),
    title: z.string().min(1),
    tagline: z.string().min(1),
    integrations: z.array(z.string().min(1)).min(1),
    pattern: z.string().min(1),
    publish: z.boolean().default(true),
    runner: RunnerSchema,
    nodes: z.array(ManifestNodeSchema).min(2),
    edges: z.array(ManifestEdgeSchema),
    metrics: z.array(ManifestMetricSchema).min(1),
    phases: z.array(ManifestPhaseSchema).min(1),
    checks: z.array(ManifestCheckSchema),
    controls: z.array(ManifestControlSchema),
  })
  .superRefine((manifest, ctx) => {
    const nodeIds = new Set(manifest.nodes.map((node) => node.id));
    manifest.edges
      .filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
      .forEach((edge) =>
        ctx.addIssue({ code: 'custom', message: `edge ${edge.id} references an unknown node` }),
      );
    const collections = {
      nodes: manifest.nodes,
      edges: manifest.edges,
      metrics: manifest.metrics,
      phases: manifest.phases,
      checks: manifest.checks,
      controls: manifest.controls,
    };
    Object.entries(collections).forEach(([name, items]) =>
      duplicateIds(items.map((item) => item.id)).forEach((id) =>
        ctx.addIssue({ code: 'custom', message: `duplicate ${name} id: ${id}` }),
      ),
    );
  });

export type DemoManifest = z.infer<typeof DemoManifestSchema>;
export type ManifestNode = z.infer<typeof ManifestNodeSchema>;
export type ManifestEdge = z.infer<typeof ManifestEdgeSchema>;
export type ManifestMetric = z.infer<typeof ManifestMetricSchema>;
export type MetricUnit = z.infer<typeof MetricUnitSchema>;
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type ManifestPhase = z.infer<typeof ManifestPhaseSchema>;
export type ManifestControl = z.infer<typeof ManifestControlSchema>;
