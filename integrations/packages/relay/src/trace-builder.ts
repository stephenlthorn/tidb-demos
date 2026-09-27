import type { DemoEvent, DemoManifest, Trace } from '@lab/contract';

const COMPONENT_PREFIX = 'LAB_ENV_COMPONENT_';

const componentsFromEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[0].startsWith(COMPONENT_PREFIX) && entry[1] !== undefined)
      .map(([key, value]) => [key.slice(COMPONENT_PREFIX.length).toLowerCase(), value]),
  );

export const buildTrace = (options: {
  readonly manifest: DemoManifest;
  readonly events: readonly DemoEvent[];
  readonly recordedAt: Date;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Trace => ({
  schemaVersion: 1,
  manifest: options.manifest,
  recordedAt: options.recordedAt.toISOString(),
  environment: {
    tidb: options.env.LAB_ENV_TIDB ?? 'unspecified',
    components: componentsFromEnv(options.env),
    notes: options.env.LAB_ENV_NOTES ?? '',
  },
  durationMs: options.events.reduce((max, event) => Math.max(max, event.t), 0),
  events: [...options.events].sort((a, b) => a.t - b.t),
});

export const traceFileName = (recordedAt: Date): string => `${recordedAt.toISOString().replace(/[:.]/g, '-')}.json`;
