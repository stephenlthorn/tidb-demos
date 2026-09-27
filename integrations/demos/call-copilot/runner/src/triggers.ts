export type TriggerKind = 'question' | 'competitor' | 'objection' | 'technical-term' | 'none';

export type TriggerResult =
  | { readonly kind: 'question'; readonly matched: string }
  | { readonly kind: 'competitor'; readonly matched: string }
  | { readonly kind: 'objection'; readonly matched: string }
  | { readonly kind: 'technical-term'; readonly matched: string }
  | { readonly kind: 'none' };

const COMPETITORS = ['Aurora', 'CockroachDB', 'PlanetScale', 'Vitess', 'YugabyteDB'];
const OBJECTION_PHRASES = ['too expensive', 'too complex', 'too risky', 'not sure we need this'];
const TECHNICAL_TERMS = ['HTAP', 'TiFlash', 'TiKV', 'TiCDC', 'HNSW', 'BM25'];

const findFirst = (haystack: string, needles: readonly string[]): string | undefined =>
  needles.find((needle) => haystack.toLowerCase().includes(needle.toLowerCase()));

export const detectTrigger = (text: string): TriggerResult => {
  const competitor = findFirst(text, COMPETITORS);
  if (competitor !== undefined) return { kind: 'competitor', matched: competitor };

  const objection = findFirst(text, OBJECTION_PHRASES);
  if (objection !== undefined) return { kind: 'objection', matched: objection };

  if (text.trim().endsWith('?')) return { kind: 'question', matched: text.trim() };

  const technicalTerm = findFirst(text, TECHNICAL_TERMS);
  if (technicalTerm !== undefined) return { kind: 'technical-term', matched: technicalTerm };

  return { kind: 'none' };
};
