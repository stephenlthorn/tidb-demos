import { describe, expect, it } from 'vitest';
import { buildSuggestionPrompt, buildSummaryPrompt } from '../src/prompt';

describe('buildSuggestionPrompt', () => {
  it('includes the trigger, the recent transcript, and each retrieved fact', () => {
    const prompt = buildSuggestionPrompt({
      trigger: { kind: 'competitor', matched: 'Aurora' },
      recentTranscript: 'prospect: We are also looking at Aurora for this.',
      facts: [
        { id: 'fact-1', text: 'TiDB is MySQL wire-compatible; Aurora migrations need no app rewrite.' },
        { id: 'fact-2', text: 'TiDB combines HTAP with TiFlash; Aurora requires a separate analytics stack.' },
      ],
    });
    expect(prompt).toContain('competitor');
    expect(prompt).toContain('Aurora');
    expect(prompt).toContain('We are also looking at Aurora for this.');
    expect(prompt).toContain('TiDB is MySQL wire-compatible');
    expect(prompt).toContain('TiDB combines HTAP with TiFlash');
  });

  it('says no facts were retrieved when the list is empty', () => {
    const prompt = buildSuggestionPrompt({
      trigger: { kind: 'question', matched: 'How does failover work?' },
      recentTranscript: 'prospect: How does failover work?',
      facts: [],
    });
    expect(prompt).toContain('No matching facts were retrieved');
  });
});

describe('buildSummaryPrompt', () => {
  it('includes the full transcript', () => {
    const prompt = buildSummaryPrompt({ fullTranscript: 'se: Hi.\nprospect: Hi, thanks for the call.' });
    expect(prompt).toContain('se: Hi.');
    expect(prompt).toContain('prospect: Hi, thanks for the call.');
  });
});
