import { describe, expect, it } from 'vitest';
import { ftsQueryFromName, nameSimilarity, sharesToken, tokenizeName } from '../src/names';

describe('tokenizeName', () => {
  it('lowercases, strips accents and punctuation, and drops initials', () => {
    expect(tokenizeName("Orsolya Q. Fenwick-Dray")).toEqual(['orsolya', 'fenwick', 'dray']);
    expect(tokenizeName('Zoé Marlow')).toEqual(['zoe', 'marlow']);
  });
});

describe('nameSimilarity', () => {
  it('is 1 for the same tokens in a different order', () => {
    expect(nameSimilarity('Quenby Marlow Tarn', 'Marlow Quenby Tarn')).toBe(1);
  });

  it('is high for a one-letter variation', () => {
    expect(nameSimilarity('Marlaw Quenby Tarn', 'Marlow Quenby Tarn')).toBeGreaterThan(0.9);
  });

  it('is low when only one token is shared', () => {
    expect(nameSimilarity('Marlow Davies', 'Marlow Quenby Tarn')).toBeLessThan(0.7);
  });

  it('is 0 when either name has no usable tokens', () => {
    expect(nameSimilarity('', 'Marlow Quenby')).toBe(0);
  });
});

describe('ftsQueryFromName', () => {
  it('joins the cleaned tokens with spaces for fts_match_word', () => {
    expect(ftsQueryFromName("Brisa O'Hallworth")).toBe('brisa hallworth');
  });
});

describe('sharesToken', () => {
  it('is true when any cleaned token is shared and false otherwise', () => {
    expect(sharesToken('Marlow Quenby', 'Queaby Marlow')).toBe(true);
    expect(sharesToken('Marlow Quenby', 'Veskar Tolmund')).toBe(false);
  });
});
