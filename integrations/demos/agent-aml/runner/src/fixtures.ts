import { z } from 'zod';
import type { PatternKind } from './domain';

const StepIdSchema = z.enum([
  'load-working-set',
  'recall-similar-cases',
  'lake-lookback',
  'write-evidence',
  'test-rule-on-branch',
]);

export type StepId = z.infer<typeof StepIdSchema>;

export const PlaybookSchema = z.object({
  structuring: z.array(StepIdSchema).min(1),
  'rapid-in-out': z.array(StepIdSchema).min(1),
  'watchlist-near-match': z.array(StepIdSchema).min(1),
});

export type Playbook = z.infer<typeof PlaybookSchema>;

export const stepsFor = (pattern: PatternKind, playbook: Playbook): readonly StepId[] => playbook[pattern];

export const WatchlistFixtureSchema = z.object({
  listTag: z.string().min(1),
  note: z.string(),
  entries: z.array(z.string().min(3)).min(10),
});

export const PastCasesSchema = z.array(
  z.object({
    caseId: z.string().regex(/^PAST-\d{3}$/),
    pattern: z.enum(['structuring', 'rapid-in-out', 'watchlist-near-match']),
    outcome: z.enum(['confirmed', 'false-positive', 'lesson']),
    summary: z.string().min(40),
  }),
);

export type PastCase = z.infer<typeof PastCasesSchema>[number];

export const skillFileFor = (pattern: PatternKind): string => {
  if (pattern === 'structuring') return 'structuring-triage.md';
  if (pattern === 'rapid-in-out') return 'rapid-movement-review.md';
  return 'watchlist-review.md';
};
