import { z } from 'zod';
export type TerraformResourceEvent =
  | { readonly type: 'resource-starting'; readonly resourceAddr: string; readonly resourceType: string; readonly action: string }
  | {
      readonly type: 'resource-done';
      readonly resourceAddr: string;
      readonly resourceType: string;
      readonly action: string;
      readonly elapsedSeconds: number;
    }
  | { readonly type: 'resource-errored'; readonly resourceAddr: string; readonly resourceType: string; readonly elapsedSeconds: number }
  | { readonly type: 'summary'; readonly operation: string; readonly add: number; readonly change: number; readonly remove: number }
  | { readonly type: 'unrecognized'; readonly raw: string };

type RawResource = {
  readonly addr: string;
  readonly resource_type: string;
};

type RawHook = {
  readonly resource: RawResource;
  readonly action: string;
  readonly elapsed_seconds?: number;
};

type RawChanges = {
  readonly operation: string;
  readonly add: number;
  readonly change: number;
  readonly remove: number;
};

type RawMessage = {
  readonly type: string;
  readonly hook?: RawHook;
  readonly changes?: RawChanges;
};

const RawMessageSchema = z.object({
  type: z.string(),
  hook: z
    .object({
      resource: z.object({ addr: z.string(), resource_type: z.string() }),
      action: z.string(),
      elapsed_seconds: z.number().optional(),
    })
    .optional(),
  changes: z.object({ operation: z.string(), add: z.number(), change: z.number(), remove: z.number() }).optional(),
});

const parseJson = (line: string): RawMessage | undefined => {
  try {
    const parsed = RawMessageSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export const parseTerraformLine = (line: string): TerraformResourceEvent => {
  const message = parseJson(line);
  if (!message) return { type: 'unrecognized', raw: line };

  if (message.type === 'apply_start' && message.hook) {
    return {
      type: 'resource-starting',
      resourceAddr: message.hook.resource.addr,
      resourceType: message.hook.resource.resource_type,
      action: message.hook.action,
    };
  }

  if (message.type === 'apply_complete' && message.hook && message.hook.elapsed_seconds !== undefined) {
    return {
      type: 'resource-done',
      resourceAddr: message.hook.resource.addr,
      resourceType: message.hook.resource.resource_type,
      action: message.hook.action,
      elapsedSeconds: message.hook.elapsed_seconds,
    };
  }

  if (message.type === 'apply_errored' && message.hook && message.hook.elapsed_seconds !== undefined) {
    return {
      type: 'resource-errored',
      resourceAddr: message.hook.resource.addr,
      resourceType: message.hook.resource.resource_type,
      elapsedSeconds: message.hook.elapsed_seconds,
    };
  }

  if (message.type === 'change_summary' && message.changes) {
    return {
      type: 'summary',
      operation: message.changes.operation,
      add: message.changes.add,
      change: message.changes.change,
      remove: message.changes.remove,
    };
  }

  return { type: 'unrecognized', raw: line };
};
