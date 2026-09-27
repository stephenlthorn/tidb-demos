import { describe, expect, it } from 'vitest';
import { detectTrigger } from '../src/triggers';

describe('detectTrigger', () => {
  it('detects a direct question', () => {
    const result = detectTrigger('How does TiDB handle a node failure?');
    expect(result).toEqual({ kind: 'question', matched: 'How does TiDB handle a node failure?' });
  });

  it('detects a named competitor', () => {
    const result = detectTrigger('We are also looking at Aurora for this.');
    expect(result).toEqual({ kind: 'competitor', matched: 'Aurora' });
  });

  it('detects an objection phrase', () => {
    const result = detectTrigger('Honestly this seems like it would be too expensive for us.');
    expect(result).toEqual({ kind: 'objection', matched: 'too expensive' });
  });

  it('detects a technical term', () => {
    const result = detectTrigger('Can you explain how HTAP works here?');
    expect(result).toEqual({ kind: 'question', matched: 'Can you explain how HTAP works here?' });
  });

  it('detects a technical term with no question mark', () => {
    const result = detectTrigger('We read about TiFlash in your docs.');
    expect(result).toEqual({ kind: 'technical-term', matched: 'TiFlash' });
  });

  it('returns none when nothing matches', () => {
    const result = detectTrigger('Great, thanks for the overview so far.');
    expect(result).toEqual({ kind: 'none' });
  });
});
