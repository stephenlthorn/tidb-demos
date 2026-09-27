import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../src/fusion';

describe('reciprocalRankFusion', () => {
  it('ranks a document appearing near the top of both lists highest', () => {
    const vectorResults = ['fact-1', 'fact-2', 'fact-3'];
    const fulltextResults = ['fact-2', 'fact-1', 'fact-4'];
    const fused = reciprocalRankFusion({ vectorResults, fulltextResults, k: 60 });
    expect(fused[0]?.id).toBe('fact-1');
  });

  it('scores a document present in only one list lower than one present in both', () => {
    const vectorResults = ['fact-1', 'fact-5'];
    const fulltextResults = ['fact-1'];
    const fused = reciprocalRankFusion({ vectorResults, fulltextResults, k: 60 });
    const fact1 = fused.find((row) => row.id === 'fact-1');
    const fact5 = fused.find((row) => row.id === 'fact-5');
    expect(fact1).toBeDefined();
    expect(fact5).toBeDefined();
    expect(fact1!.score).toBeGreaterThan(fact5!.score);
  });

  it('computes the exact RRF score with the standard formula', () => {
    const fused = reciprocalRankFusion({ vectorResults: ['fact-1'], fulltextResults: [], k: 60 });
    expect(fused[0]?.score).toBeCloseTo(1 / (60 + 1), 10);
  });

  it('returns an empty array when both inputs are empty', () => {
    expect(reciprocalRankFusion({ vectorResults: [], fulltextResults: [], k: 60 })).toEqual([]);
  });

  it('sorts the fused list by score descending', () => {
    const fused = reciprocalRankFusion({
      vectorResults: ['fact-1', 'fact-2', 'fact-3'],
      fulltextResults: ['fact-3', 'fact-2', 'fact-1'],
      k: 60,
    });
    const scores = fused.map((row) => row.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
