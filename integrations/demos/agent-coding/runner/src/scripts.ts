import { z } from 'zod';

const Fault = z.literal('econnreset');
const common = { step: z.number().int().min(1), note: z.string().min(1) };

export const ScriptStepSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('read') }),
  z.object({ ...common, kind: z.literal('baseline'), fault: Fault.optional() }),
  z.object({ ...common, kind: z.literal('write'), path: z.string().min(1), from: z.string().min(1) }),
  z.object({ ...common, kind: z.literal('verify'), fault: Fault.optional() }),
]);

export const AttemptScriptSchema = z
  .object({
    attemptId: z.string().regex(/^attempt-[0-9]+$/),
    model: z.string().min(1),
    stepCostUsd: z.number().nonnegative(),
    steps: z.array(ScriptStepSchema).min(1),
  })
  .superRefine((script, ctx) => {
    script.steps
      .filter((step, index) => step.step !== index + 1)
      .forEach((step) => ctx.addIssue({ code: 'custom', message: `step ${step.step} is out of order` }));
  });

export type ScriptStep = z.infer<typeof ScriptStepSchema>;
export type AttemptScript = z.infer<typeof AttemptScriptSchema>;

export const parseAttemptScript = (value: unknown): AttemptScript => AttemptScriptSchema.parse(value);

export const writtenPaths = (script: AttemptScript): readonly string[] => [
  ...new Set(script.steps.flatMap((step) => (step.kind === 'write' ? [step.path] : []))),
];

export const pathOwners = (scripts: readonly AttemptScript[]): Readonly<Record<string, string>> => {
  const writers = scripts.flatMap((script) =>
    writtenPaths(script).map((path) => ({ path, attemptId: script.attemptId })),
  );
  const owned = [...new Set(writers.map((writer) => writer.path))].flatMap((path) => {
    const owners = writers.filter((writer) => writer.path === path);
    const only = owners[0];
    return owners.length === 1 && only !== undefined ? [only] : [];
  });
  return Object.fromEntries(owned.map((owner) => [owner.path, owner.attemptId]));
};
