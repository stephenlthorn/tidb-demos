import { describe, expect, it } from 'vitest';
import { hashEmbedding, vectorLiteral } from '../src/embedding';

const cosine = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

describe('hashEmbedding', () => {
  it('returns a unit vector of the requested size', () => {
    const vector = hashEmbedding('connect ECONNRESET gateway', 64);
    expect(vector).toHaveLength(64);
    expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 4);
  });

  it('is deterministic', () => {
    expect(hashEmbedding('same text')).toEqual(hashEmbedding('same text'));
  });

  it('places similar failures closer than unrelated text', () => {
    const query = hashEmbedding('connect ECONNRESET gateway retry');
    const near = hashEmbedding('gateway ECONNRESET on retry');
    const far = hashEmbedding('assertion expected 1 actual 2 in ledger');
    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far));
  });

  it('returns zeros for text with no tokens', () => {
    expect(hashEmbedding('---', 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('vectorLiteral', () => {
  it('renders a bracketed list', () => {
    expect(vectorLiteral([0.5, 0, 1])).toBe('[0.5,0,1]');
  });
});
