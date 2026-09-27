import type { TriggerResult } from './triggers';

export type RetrievedFact = { readonly id: string; readonly text: string };

export const buildSuggestionPrompt = (options: {
  readonly trigger: TriggerResult;
  readonly recentTranscript: string;
  readonly facts: readonly RetrievedFact[];
}): string => {
  const factLines =
    options.facts.length === 0
      ? 'No matching facts were retrieved. Say so plainly rather than guessing.'
      : options.facts.map((fact) => `- [${fact.id}] ${fact.text}`).join('\n');
  return [
    'You are a sales engineering copilot whispering a suggestion to a human SE mid-call.',
    `Trigger kind: ${options.trigger.kind}`,
    'Recent transcript:',
    options.recentTranscript,
    'Retrieved facts:',
    factLines,
    'In two sentences or fewer, give the SE the single most useful thing to say next.',
  ].join('\n\n');
};

export const buildSummaryPrompt = (options: { readonly fullTranscript: string }): string =>
  [
    'You are writing a post-call summary and follow-up email draft for a sales engineer.',
    'Full transcript:',
    options.fullTranscript,
    'Produce: a three-sentence summary, a list of open objections, and a short follow-up email draft.',
  ].join('\n\n');
